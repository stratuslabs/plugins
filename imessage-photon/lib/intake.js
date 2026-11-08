import { isGroupChat } from './admission.js';

/**
 * Reading one Photon line for one agent, in order, without losing a text
 * or answering one twice.
 *
 * Photon keeps a durable, numbered event log per line. Each connection
 * opens the live stream first and buffers it, replays the log from where
 * this agent's read position stands (`events.catchUp`), then hands over
 * the buffered live events and carries on live. An event whose sequence
 * was already handed over is skipped, so the overlap between the replay
 * and the live stream is harmless. A dropped connection reconnects with
 * backoff and replays from the last event handed over.
 *
 * The very first start has no position. It reads the log through to its
 * head without answering anything, so texts from before the agent was on
 * the line are history, and stores the head.
 *
 * Received messages are handed to `handle` synchronously and in order (it
 * dispatches before it awaits anything), and settle when it resolves:
 * 'settled' means done, 'kept' means read again at the next start (the
 * daemon was stopping, or the answer couldn't be sent). The stored cursor
 * moves only past settled events (lib/cursor.js).
 *
 * Catch-up after a long outage does not answer a text sent more than
 * `replayCapMs` ago: a reply to a day-old text reads as a glitch. It is
 * logged instead.
 */

const RETRY_MS = [1000, 2000, 5000, 15_000, 30_000];
const HEALTHY_MS = 60_000;

const sleepFor = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

class CursorRejected extends Error {
  constructor(cause) {
    super(`Photon refused the stored read position: ${cause?.message ?? String(cause)}`);
    this.name = 'CursorRejected';
    this.cause = cause;
  }
}

const timeOf = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Number.NaN);

/** The message a received event carries for the agent, or undefined when there is none to answer. */
export const messageOf = (event, lineKey) => {
  if (event?.type !== 'message.received') {
    return undefined;
  }
  const message = event.message;
  if (!message || message.isFromMe || message.reaction !== undefined || message.reactionTargetGuid !== undefined
    || message.isSystemMessage || message.isServiceMessage) {
    return undefined;
  }
  const text = typeof message.content?.text === 'string' ? message.content.text : '';
  const attachments = (message.content?.attachments ?? []).filter((attachment) => !attachment.isHidden && !attachment.isSticker);
  if (text.trim().length === 0 && attachments.length === 0) {
    return undefined;
  }
  const chatGuid = event.chatGuid ?? message.chatGuids?.[0];
  return {
    sequence: event.sequence,
    guid: message.guid,
    from: message.sender?.address,
    service: message.sender?.service ?? 'unknown',
    text,
    attachments,
    chatGuid,
    group: isGroupChat(chatGuid),
    sentAt: timeOf(message.dateCreated ?? event.occurredAt),
    line: lineKey,
  };
};

export const createLineIntake = ({
  client,
  line,
  position,
  handle,
  label = line.key,
  log = () => {},
  warn = log,
  now = Date.now,
  replayCapMs = 24 * 3_600_000,
  retryMs = RETRY_MS,
}) => {
  const stopController = new AbortController();
  let streams = new Set();
  let running;
  let wake = () => {};

  const stored = position.get();
  // Everything at or before `cursor` is settled; `settled` holds the ones
  // after it that are too. Undefined until the first start has seeded it.
  let cursor = stored?.cursor;
  const settled = new Set(stored?.settled ?? []);
  // The newest event handed over (or skipped) by this process.
  let handedThrough = cursor;
  // Handed over, not yet settled.
  const open = new Set();
  // 'kept' ones stay open, holding the cursor, until the next start.
  const kept = new Set();
  const answering = new Set();

  const save = () => {
    try {
      position.set({ cursor, settled: [...settled].sort((a, b) => a - b) });
    } catch (error) {
      warn(`imessage-photon: ${label}: could not save the read position: ${error.message}`);
    }
  };

  const advance = () => {
    const floor = open.size > 0 ? Math.min(...open) - 1 : handedThrough;
    if (floor > cursor) {
      cursor = floor;
      for (const sequence of settled) {
        if (sequence <= cursor) {
          settled.delete(sequence);
        }
      }
    }
    save();
  };

  const settle = (sequence) => {
    open.delete(sequence);
    settled.add(sequence);
    advance();
  };

  const take = (event, { replay }) => {
    const sequence = event?.sequence;
    if (!Number.isSafeInteger(sequence) || sequence <= handedThrough) {
      return;
    }
    handedThrough = sequence;
    if (settled.has(sequence)) {
      return;
    }
    const message = messageOf(event, line.key);
    if (!message) {
      settle(sequence);
      return;
    }
    if (replay && Number.isFinite(message.sentAt) && now() - message.sentAt > replayCapMs) {
      log(`imessage-photon: ${label}: not answering event ${sequence}, sent ${Math.round((now() - message.sentAt) / 3_600_000)}h ago, before the catch-up limit.`);
      settle(sequence);
      return;
    }
    open.add(sequence);
    let answered;
    try {
      answered = Promise.resolve(handle(message));
    } catch (error) {
      answered = Promise.reject(error);
    }
    const tracked = answered.then((outcome) => {
      if (outcome === 'kept') {
        kept.add(sequence);
        return;
      }
      settle(sequence);
    }, (error) => {
      // A bug, not a refusal: settled, so one bad message can't hold the
      // line forever, and said.
      warn(`imessage-photon: ${label}: handling event ${sequence} failed: ${error?.message ?? String(error)}`);
      settle(sequence);
    }).finally(() => answering.delete(tracked));
    answering.add(tracked);
  };

  const closeAll = async () => {
    const closing = [...streams];
    streams = new Set();
    await Promise.allSettled(closing.map((stream) => stream.close?.()));
  };

  /** Reads the log through to its head without answering, and stores the head. */
  const seed = async () => {
    const replay = client.events.catchUp(0);
    streams.add(replay);
    let head = 0;
    for await (const event of replay) {
      if (stopController.signal.aborted) {
        return false;
      }
      if (event.type === 'catchup.complete') {
        head = Math.max(head, event.headSequence ?? 0);
        break;
      }
      if (Number.isSafeInteger(event.sequence)) {
        head = Math.max(head, event.sequence);
      }
    }
    cursor = head;
    handedThrough = head;
    settled.clear();
    save();
    log(`imessage-photon: ${label}: first start; texts before event ${head} are history.`);
    return true;
  };

  const connectOnce = async () => {
    const queue = [];
    let liveError;
    let liveEnded = false;
    const live = client.messages.subscribeEvents();
    streams.add(live);
    const pump = (async () => {
      try {
        for await (const event of live) {
          queue.push(event);
          wake();
        }
        liveEnded = true;
      } catch (error) {
        liveError = error;
      }
      wake();
    })();
    try {
      if (cursor === undefined) {
        if (!await seed()) {
          return;
        }
      } else {
        const replay = client.events.catchUp(handedThrough);
        streams.add(replay);
        try {
          for await (const event of replay) {
            if (stopController.signal.aborted) {
              return;
            }
            if (event.type === 'catchup.complete') {
              break;
            }
            take(event, { replay: true });
          }
        } catch (error) {
          throw error?.name === 'ValidationError' ? new CursorRejected(error) : error;
        }
      }
      while (!stopController.signal.aborted) {
        while (queue.length > 0) {
          take(queue.shift(), { replay: false });
        }
        if (liveError) {
          throw liveError;
        }
        if (liveEnded) {
          throw new Error('Photon closed the event stream');
        }
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      wake = () => {};
      await closeAll();
      await pump;
    }
  };

  const loop = async () => {
    let failures = 0;
    while (!stopController.signal.aborted) {
      const startedAt = now();
      try {
        await connectOnce();
        if (stopController.signal.aborted) {
          break;
        }
      } catch (error) {
        if (stopController.signal.aborted) {
          break;
        }
        if (error instanceof CursorRejected) {
          warn(`imessage-photon: ${label}: ${error.message}. Starting again from the head of the log; texts sent since the last event read may go unanswered.`);
          cursor = undefined;
          handedThrough = undefined;
          settled.clear();
          continue;
        }
        if (now() - startedAt >= HEALTHY_MS) {
          failures = 0;
        }
        const delay = retryMs[Math.min(failures, retryMs.length - 1)];
        failures += 1;
        (failures === 1 || failures % 10 === 0 ? warn : log)(`imessage-photon: ${label}: the Photon connection dropped (${error?.message ?? String(error)}); reconnecting in ${Math.round(delay / 1000)}s.`);
        await sleepFor(delay, stopController.signal);
      }
    }
  };

  return {
    start() {
      running ??= loop();
      return running;
    },
    async stop() {
      stopController.abort();
      wake();
      await closeAll();
      await running;
      // Turns under way end as the gateway stops; what they settle is saved.
      await Promise.allSettled([...answering]);
      if (cursor !== undefined) {
        save();
      }
    },
    status: () => ({
      line: line.key,
      cursor,
      handedThrough,
      open: [...open].sort((a, b) => a - b),
      kept: [...kept].sort((a, b) => a - b),
    }),
  };
};
