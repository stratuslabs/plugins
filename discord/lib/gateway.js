import { REST } from '@discordjs/rest';
import { SimpleShardingStrategy, WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { normalizeMessage, trackThreads } from './normalize.js';

/** Guilds, GuildMessages, DirectMessages and MessageContent. No member intent: allowlists are by id. */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/**
 * Close codes Discord won't recover from by reconnecting. Each says what to
 * fix, because the library would otherwise just stop.
 */
const FATAL = new Map([
  [4004, 'Discord refused the bot token. Store a current one with `stratus channel set discord --agent <id> botToken`.'],
  [4013, 'Discord refused the requested intents as invalid.'],
  [4014, 'Discord refused the Message Content intent. Turn on "Message Content Intent" under Bot > Privileged Gateway Intents in the Developer Portal for this application, then restart.'],
]);

/**
 * Whether a failed connect is worth trying again: not when Discord refused
 * the bot (a fatal close code, or a 4xx other than 429 from REST), since
 * the same token and intents get the same answer.
 */
export const isRetryable = (error) => {
  if (FATAL.has(error?.code)) {
    return false;
  }
  const status = error?.status;
  return !(typeof status === 'number' && status >= 400 && status < 500 && status !== 429);
};

/**
 * `manager.destroy()` alone doesn't always stop `@discordjs/ws` 2.0.4
 * (plugins#20). After a failed attempt a shard goes idle, waits 500ms and
 * connects again; a destroy that lands in that wait is a no-op ("Tried to
 * destroy a shard that was idle"), so it keeps retrying an unreachable
 * Discord and the process never exits. So each shard's next connect is made
 * a no-op first, then the manager is destroyed, then any attempt that was
 * already underway is destroyed too.
 *
 * This reaches into the library (`strategy.shards`, `internalConnect`,
 * `status`), which is why the dependency is pinned; the "closing while
 * Discord is unreachable" test fails if a new version moves them.
 */
const IDLE = 0;
export const stopManager = async (manager, options) => {
  const shards = [...(manager.strategy?.shards?.values() ?? [])];
  for (const shard of shards) {
    shard.internalConnect = async () => {};
  }
  await manager.destroy(options);
  // An attempt already past internalConnect's first line only gets as far
  // as Connecting, within microtasks; a turn of the event loop shows it.
  for (let pass = 0; pass < 10; pass += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const live = shards.filter((shard) => shard.status !== IDLE);
    if (live.length === 0) {
      return;
    }
    await Promise.all(live.map((shard) => shard.destroy(options).catch(() => {})));
  }
};

/**
 * One agent's bot connection: the gateway for what comes in, REST for what
 * goes out. `@discordjs/ws` does heartbeats, identify throttling, resume and
 * reconnect. `onMessage(message, raw)` gets every MESSAGE_CREATE in the
 * adapter's form, and `onInteraction(raw)` every INTERACTION_CREATE (a button
 * click); admission is the caller's.
 *
 * `signal` gives up connecting: the attempt rejects with its reason and the
 * library stops retrying. Once connected, `close()` is the way out.
 *
 * `api` points both at another Discord, for tests.
 */
export const connectBot = async ({ token, onMessage, onInteraction, onFatal, onReconnect, log = () => {}, api, signal }) => {
  signal?.throwIfAborted();
  const rest = new REST({ version: '10', ...(api ? { api } : {}) }).setToken(token);
  // Given up while REST was still answering, the manager would go on to
  // start its shards anyway; they don't start once the signal has fired.
  const buildStrategy = (owner) => {
    const strategy = new SimpleShardingStrategy(owner);
    const connectShards = strategy.connect.bind(strategy);
    strategy.connect = async () => {
      signal?.throwIfAborted();
      return connectShards();
    };
    return strategy;
  };
  const manager = new WebSocketManager({ token, intents: INTENTS, rest, compression: null, buildStrategy });
  const threads = new Map();
  let botId;
  let fatalError;
  let ready;
  const readyOnce = new Promise((resolve, reject) => {
    ready = { resolve, reject };
  });
  // A fatal close can land while connect() is still running, before the
  // await below: handled here, still thrown there.
  readyOnce.catch(() => {});

  let readies = 0;
  manager.on(WebSocketShardEvents.Ready, (data) => {
    botId = data.user.id;
    readies += 1;
    ready.resolve();
    // A READY after the first is a new session, not a resume: Discord
    // replays nothing from before it.
    if (readies > 1) {
      onReconnect?.();
    }
  });
  manager.on(WebSocketShardEvents.Resumed, () => log('discord gateway resumed'));
  manager.on(WebSocketShardEvents.Closed, (code) => {
    const fatal = FATAL.get(code);
    if (fatal) {
      const error = new Error(fatal);
      error.code = code;
      fatalError = error;
      ready.reject(error);
      onFatal?.(error);
    }
  });
  manager.on(WebSocketShardEvents.Error, (error) => log(`discord gateway error: ${error.message}`));
  manager.on(WebSocketShardEvents.Dispatch, (payload) => {
    if (trackThreads(threads, payload)) {
      return;
    }
    if (payload.t === 'MESSAGE_CREATE' && botId !== undefined) {
      onMessage(normalizeMessage(payload.d, threads), payload.d);
    } else if (payload.t === 'INTERACTION_CREATE' && botId !== undefined) {
      onInteraction?.(payload.d);
    }
  });

  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    await Promise.race([
      (async () => {
        await manager.connect();
        await readyOnce;
      })(),
      aborted,
    ]);
  } catch (error) {
    await stopManager(manager).catch(() => {});
    // The library's own message for a fatal close ("Used disallowed
    // intents") doesn't say what to change; ours does.
    throw fatalError ?? error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return {
    get botId() {
      return botId;
    },
    rest,
    threads,
    close: () => stopManager(manager, { code: 1000, reason: 'stratus stopping' }),
  };
};
