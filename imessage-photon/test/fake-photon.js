/**
 * A stand-in Photon line with the parts of the Advanced iMessage SDK's
 * client the channel uses: a numbered, durable event log replayed by
 * `events.catchUp(since)`, live `messages.subscribeEvents()` streams,
 * `messages.sendText` (recording the clientMessageId and dropping a
 * repeat of one, as Photon does), `chats.create` and `chats.setTyping`.
 *
 * `receive` appends a received message to the log and pushes it to every
 * live stream; `drop` fails the live streams, as a lost connection does;
 * `offline` makes new streams fail until it is cleared.
 */

class LiveStream {
  constructor(onClose) {
    this.queue = [];
    this.waiting = undefined;
    this.done = false;
    this.error = undefined;
    this.onClose = onClose;
  }

  push(event) {
    if (this.done) {
      return;
    }
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  fail(error) {
    if (this.done) {
      return;
    }
    this.error = error;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = undefined;
      this.done = true;
      this.onClose(this);
      reject(error);
    }
  }

  async close() {
    if (this.done) {
      return;
    }
    this.done = true;
    this.onClose(this);
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift(), done: false });
        }
        if (this.error) {
          this.done = true;
          this.onClose(this);
          return Promise.reject(this.error);
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
      return: async () => {
        await this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

const replayOf = (events, since, { reject, onOpen } = {}) => {
  let closed = false;
  const stream = {
    async close() {
      closed = true;
    },
    async *[Symbol.asyncIterator]() {
      onOpen?.();
      if (reject) {
        throw reject;
      }
      for (const event of events.filter((entry) => entry.sequence > (since ?? 0))) {
        if (closed) {
          return;
        }
        yield event;
      }
      yield { type: 'catchup.complete', headSequence: events.at(-1)?.sequence ?? 0 };
    },
  };
  return stream;
};

export const createFakePhoton = () => {
  const events = [];
  const live = new Set();
  const sent = [];
  const typing = [];
  const created = [];
  const catchUps = [];
  const seenIds = new Set();
  let sequence = 0;
  let guid = 0;
  let offline;
  let rejectCursor;
  let failSend = () => false;
  let duringCatchUp;

  const client = {
    events: {
      catchUp: (since) => {
        catchUps.push(since);
        const reject = rejectCursor && since !== 0 ? rejectCursor : undefined;
        if (reject) {
          rejectCursor = undefined;
        }
        const onOpen = duringCatchUp;
        duringCatchUp = undefined;
        return replayOf(events, since, { reject: offline ?? reject, onOpen });
      },
    },
    messages: {
      subscribeEvents: () => {
        const stream = new LiveStream((closed) => live.delete(closed));
        if (offline) {
          stream.fail(offline);
        } else {
          live.add(stream);
        }
        return stream;
      },
      sendText: async (chat, text, options = {}) => {
        const failure = failSend(chat, text);
        if (failure === true) {
          throw new Error('Photon refused the send: test');
        }
        const repeat = options.clientMessageId !== undefined && seenIds.has(options.clientMessageId);
        if (!repeat) {
          if (options.clientMessageId) {
            seenIds.add(options.clientMessageId);
          }
          sent.push({ chat, text, clientMessageId: options.clientMessageId });
        }
        if (failure === 'after') {
          // Photon took it, and the answer was lost on the way back.
          throw new Error('deadline exceeded: test');
        }
        return { guid: repeat ? 'repeat' : `out-${sent.length}` };
      },
    },
    chats: {
      create: async ([handle]) => {
        created.push(handle);
        return { chat: { guid: `any;-;${handle}` } };
      },
      setTyping: async (chat, on) => {
        typing.push([chat, on]);
      },
    },
    closed: false,
    async close() {
      client.closed = true;
    },
  };

  return {
    client,
    events,
    sent,
    typing,
    created,
    catchUps,
    liveCount: () => live.size,
    /** A text to the line; returns its event. */
    receive({ from, text = 'hi', service = 'iMessage', chat, at = Date.now(), attachments = [], fromMe = false } = {}) {
      sequence += 1;
      guid += 1;
      const chatGuid = chat ?? `any;-;${from}`;
      const event = {
        type: 'message.received',
        sequence,
        chatGuid,
        isFromMe: fromMe,
        occurredAt: new Date(at),
        message: {
          guid: `msg-${guid}`,
          chatGuids: [chatGuid],
          isFromMe: fromMe,
          isSystemMessage: false,
          isServiceMessage: false,
          dateCreated: new Date(at),
          content: { text, attachments, formatting: [], mentions: [] },
          sender: from ? { address: from, service } : undefined,
        },
      };
      events.push(event);
      for (const stream of live) {
        stream.push(event);
      }
      return event;
    },
    /** Any other event on the line, such as a read receipt. */
    other(type = 'message.read') {
      sequence += 1;
      const event = { type, sequence, chatGuid: 'any;-;x@y.zz', isFromMe: false, occurredAt: new Date(), messageGuid: 'm' };
      events.push(event);
      for (const stream of live) {
        stream.push(event);
      }
      return event;
    },
    drop(error = new Error('connection reset')) {
      for (const stream of [...live]) {
        stream.fail(error);
      }
    },
    setOffline(error) {
      offline = error;
    },
    rejectNextCursor(error) {
      rejectCursor = error;
    },
    failSends(check) {
      failSend = check;
    },
    /** Runs `fn` as the next catch-up starts, before it reads the log: what it adds is in both streams. */
    onNextCatchUp(fn) {
      duringCatchUp = fn;
    },
  };
};

/** A token endpoint that answers like Spectrum's, counting calls. */
export const fakeTokenFetch = ({ type = 'shared', expiresIn = 3600, status = 200, lines = { 'line-1': '+15550001111' } } = {}) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) {
      return { ok: false, status, json: async () => ({ code: 'UNAUTHORIZED', message: 'Invalid project credentials' }) };
    }
    const data = type === 'shared'
      ? { type: 'shared', token: `shared-token-${calls.length}`, expiresIn }
      : { type: 'dedicated', auth: Object.fromEntries(Object.keys(lines).map((id) => [id, `token-${id}-${calls.length}`])), numbers: lines, expiresIn };
    return { ok: true, status: 200, json: async () => ({ succeed: true, data }) };
  };
  return { fetch, calls };
};
