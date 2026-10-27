import path from 'node:path';
import { filePathsOf } from '@stratusagent/core';
import { chunk } from './chunk.js';

/**
 * Discord allows about five message writes per five seconds in a channel
 * before it answers 429. One sync can post an overflow message and edit the
 * live one, so 1.5s between syncs keeps a long streamed reply under that.
 */
export const EDIT_INTERVAL_MS = 1500;
/** Discord shows "is typing…" for about ten seconds per request. */
export const TYPING_EVERY_MS = 8000;
export const NO_REPLY_TEXT = '(no reply)';

/**
 * Renders one turn into a Discord conversation: streams its words by
 * editing what it posted, throttled, and finishes with the reply.
 *
 * The turn is a list of segments, one per model response that said
 * something. Words written before a tool call stay as their own message(s),
 * and the next response starts a new one, the way the Slack channel keeps
 * them. A segment longer than 2000 characters is split with `chunk`, so a
 * segment is one or more messages; once a later piece exists, the earlier
 * ones stop changing. A running tool shows as a `-# ⚙ name…` line at the
 * end of the live segment, or as the live message itself when the response
 * has said nothing yet; the next words replace it.
 *
 * A file a tool produced (an ok result's `file` or `files`, core's
 * `filePathsOf`) is a message of its own, in its place: after what was
 * said before the tool, before what is said after.
 *
 * `ops` does the Discord calls: `post(text) -> id`, `edit(id, text)`,
 * `remove(id)`, `typing()` and `upload(filePath) -> id`. Every call is
 * serialized, and a failed one is logged through `warn`, never thrown into
 * the event stream.
 */
export const createRenderer = ({
  ops,
  intervalMs = EDIT_INTERVAL_MS,
  typingEveryMs = TYPING_EVERY_MS,
  timers = globalThis,
  now = Date.now,
  warn = () => {},
}) => {
  const segments = [{ text: '', ids: [], shown: [] }];
  let tool; // name of the running tool, shown on the live segment
  let breakPending = false; // the next words belong to a new response
  let streamedThisResponse = false;
  let finished = false;
  let timer;
  let lastSyncAt = -Infinity;
  let chain = Promise.resolve();
  let typingTimer;
  let posted = 0;
  let uploaded = 0;

  const live = () => segments[segments.length - 1];

  const display = (segment) => {
    const status = segment === live() && tool !== undefined ? `-# ⚙ ${tool}…` : '';
    const words = segment.text.trim().length > 0 ? segment.text : '';
    return words && status ? `${words}\n${status}` : words || status;
  };

  const call = async (what, fn) => {
    try {
      return await fn();
    } catch (error) {
      warn(`discord: could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /** Bring every segment's messages in line with what it should show. */
  const syncNow = async () => {
    for (const segment of segments) {
      const body = display(segment);
      const pieces = body ? chunk(body) : [];
      for (const [index, piece] of pieces.entries()) {
        if (index < segment.ids.length) {
          if (segment.shown[index] !== piece) {
            const id = segment.ids[index];
            // Counted as shown only once Discord took it, so a refused
            // edit is tried again by the next sync.
            const edited = await call('edit a message', async () => {
              await ops.edit(id, piece);
              return true;
            });
            if (edited) {
              segment.shown[index] = piece;
            }
          }
        } else {
          const id = await call('post a message', () => ops.post(piece));
          if (id === undefined) {
            // Not posted: the next sync tries again rather than editing
            // pieces after it into the wrong message.
            break;
          }
          segment.ids.push(id);
          segment.shown.push(piece);
          posted += 1;
        }
      }
      // A segment that shrank (a reset, a cleared status line) takes down
      // what it no longer needs: Discord has no empty message.
      // A refused delete keeps the id, so the next sync tries again or
      // reuses the message.
      while (segment.ids.length > pieces.length) {
        const id = segment.ids.at(-1);
        const removed = await call('delete a message', async () => {
          await ops.remove(id);
          return true;
        });
        if (!removed) {
          break;
        }
        segment.ids.pop();
        segment.shown.pop();
      }
    }
  };

  const sync = () => {
    chain = chain.then(syncNow);
    return chain;
  };

  const schedule = () => {
    if (finished || timer !== undefined) {
      return;
    }
    // Nothing on screen yet: the first words go up at once, and the
    // interval counts from them.
    if (lastSyncAt === -Infinity) {
      lastSyncAt = now();
      void sync();
      return;
    }
    const delay = Math.max(0, intervalMs - (now() - lastSyncAt));
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (!finished) {
        lastSyncAt = now();
        void sync();
      }
    }, delay);
  };

  const stopTimers = () => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
    if (typingTimer !== undefined) {
      timers.clearTimeout(typingTimer);
      typingTimer = undefined;
    }
  };

  /** Words so far end a segment; the next ones start a new one. */
  const closeSegment = () => {
    if (live().text.trim().length > 0) {
      segments.push({ text: '', ids: [], shown: [] });
    }
  };

  const typingLoop = () => {
    if (finished) {
      return;
    }
    void call('show typing', () => ops.typing());
    typingTimer = timers.setTimeout(typingLoop, typingEveryMs);
  };

  return {
    /** The turn started: show typing until it ends. */
    beginTurn() {
      if (!finished && typingTimer === undefined) {
        typingLoop();
      }
    },

    onEvent(event) {
      if (finished) {
        return;
      }
      if (event.type === 'provider.delta' && event.delta.type === 'text') {
        if (breakPending) {
          closeSegment();
          breakPending = false;
        }
        live().text += event.delta.text;
        streamedThisResponse = true;
        schedule();
        return;
      }
      if (event.type === 'provider.delta' && event.delta.type === 'reset') {
        // The provider abandoned this response: drop its words, keep what
        // earlier responses said.
        live().text = '';
        streamedThisResponse = false;
        schedule();
        return;
      }
      if (event.type === 'provider.response') {
        // A provider that answers in one piece streams nothing: the
        // response is where its words before a tool call are.
        if (!streamedThisResponse && live().text.trim().length === 0) {
          live().text = (event.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
          schedule();
        }
        streamedThisResponse = false;
        breakPending = true;
        return;
      }
      if (event.type === 'tool.called') {
        closeSegment();
        breakPending = false;
        streamedThisResponse = false;
        tool = event.call.toolName;
        schedule();
        return;
      }
      if (event.type === 'tool.completed' || event.type === 'tool.denied') {
        tool = undefined;
        breakPending = true;
        const files = event.type === 'tool.completed' && event.result && ops.upload ? filePathsOf(event.result) : [];
        if (files.length === 0) {
          schedule();
          return;
        }
        // Brought up to date first (the status line comes down), so the
        // file lands below the words before it; words after it start a
        // message of their own below it.
        if (timer !== undefined) {
          timers.clearTimeout(timer);
          timer = undefined;
        }
        lastSyncAt = now();
        chain = chain.then(syncNow).then(async () => {
          for (const file of files) {
            const id = await call(`upload ${path.basename(file)}`, () => ops.upload(file));
            if (id !== undefined) {
              posted += 1;
              uploaded += 1;
            }
          }
        });
      }
    },

    /**
     * The reply. It is the session's word for what the turn said, so it
     * replaces the live segment's streamed text. A reply that is the words
     * already standing before the last tool call is not posted again.
     */
    async finalize(reply) {
      finished = true;
      stopTimers();
      tool = undefined;
      const text = typeof reply === 'string' ? reply : '';
      const previous = segments.length > 1 ? segments[segments.length - 2] : undefined;
      const repeatsPrevious = previous !== undefined && live().text.trim().length === 0 && previous.text.trim() === text.trim();
      if (text.trim().length > 0 && !repeatsPrevious) {
        live().text = text;
      }
      // A file is something said; NO_REPLY_TEXT is for a turn with nothing
      // to show. The uploads are in the chain, so wait for them first.
      await chain;
      if (uploaded === 0 && segments.every((segment) => display(segment) === '')) {
        live().text = NO_REPLY_TEXT;
      }
      await sync();
      return { spoke: posted > 0 };
    },

    /** The turn failed: say so after whatever it said. */
    async fail(message) {
      finished = true;
      stopTimers();
      tool = undefined;
      const said = live().text.trim().length > 0 ? `${live().text}\n\n` : '';
      live().text = `${said}⚠ ${message}`;
      await sync();
      return { spoke: posted > 0 };
    },

    /** Stopped by an approver: keep what it said, and say who stopped it. */
    async stopped(by) {
      finished = true;
      stopTimers();
      tool = undefined;
      const said = live().text.trim().length > 0 ? `${live().text}\n\n` : '';
      live().text = `${said}-# Stopped by ${by}.`;
      await sync();
      return { spoke: posted > 0 };
    },

    /** The adapter is stopping with this turn unfinished: no more timers or requests. */
    halt() {
      finished = true;
      stopTimers();
    },

    /** Another delivery answers this turn: take down what this one put up. */
    async withdraw() {
      finished = true;
      stopTimers();
      tool = undefined;
      for (const segment of segments) {
        segment.text = '';
      }
      await sync();
    },
  };
};
