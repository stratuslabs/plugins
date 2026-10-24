import { REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
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
 * One agent's bot connection: the gateway for what comes in, REST for what
 * goes out. `@discordjs/ws` does heartbeats, identify throttling, resume and
 * reconnect. `onMessage(message, raw)` gets every MESSAGE_CREATE in the
 * adapter's form, and `onInteraction(raw)` every INTERACTION_CREATE (a button
 * click); admission is the caller's.
 *
 * `api` points both at another Discord, for tests.
 */
export const connectBot = async ({ token, onMessage, onInteraction, onFatal, onReconnect, log = () => {}, api }) => {
  const rest = new REST({ version: '10', ...(api ? { api } : {}) }).setToken(token);
  const manager = new WebSocketManager({ token, intents: INTENTS, rest, compression: null });
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

  try {
    await manager.connect();
    await readyOnce;
  } catch (error) {
    await manager.destroy().catch(() => {});
    // The library's own message for a fatal close ("Used disallowed
    // intents") doesn't say what to change; ours does.
    throw fatalError ?? error;
  }
  return {
    get botId() {
      return botId;
    },
    rest,
    threads,
    close: () => manager.destroy({ code: 1000, reason: 'stratus stopping' }),
  };
};
