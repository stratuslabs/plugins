import { randomUUID } from 'node:crypto';
import { admit } from './admission.js';
import { connectBot } from './gateway.js';
import { createRenderer } from './render.js';
import { editText, postText, removeMessage, threadFrom, typing } from './send.js';
import { routeFor, sessionIdFor } from './sessions.js';
import { latestTurnReply, turnFailureFor, turnReplyFor } from './turns.js';

/** How many message ids per agent are remembered to drop a gateway replay. */
const SEEN_LIMIT = 2000;

/** The bot's own mention, as `<@id>` or the older `<@!id>`. */
const withoutMention = (content, botId) => content.replaceAll(`<@${botId}>`, '').replaceAll(`<@!${botId}>`, '').trim();

/** A name for who spoke: their server nickname, display name or username. Text they chose. */
const authorName = (raw) => raw.member?.nick ?? raw.author?.global_name ?? raw.author?.username ?? raw.author?.id ?? 'someone';

/**
 * The Discord channel adapter: one bot connection per agent, admission
 * before anything else sees a message, one session per DM or thread, and a
 * renderer per turn that streams the answer into the conversation.
 *
 * `secrets` is `{ [agentId]: { botToken } }` from `transportSecrets`. A
 * token goes to the bot connection and nowhere else: not into a turn's
 * metadata, not into a log line.
 */
/** How long stop() lets replies already being written finish. */
export const DRAIN_TIMEOUT_MS = 10_000;

export const createDiscordAdapter = ({ config, secrets, api, log = () => {}, warn = () => {}, connect = connectBot, drainTimeoutMs = DRAIN_TIMEOUT_MS }) => {
  const bots = new Map();
  const renderers = new Map(); // sessionId -> [{ turnId, renderer }]
  const seen = new Map(); // agentId -> Set of message ids, insertion-ordered
  const inFlight = new Set();
  let gateway;
  let unsubscribe;
  let stopping = false;

  const track = (promise) => {
    const tracked = promise.catch((error) => warn(`discord: ${error instanceof Error ? error.message : String(error)}`));
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
  };

  /** True the first time this agent sees this message id. */
  const firstSighting = (agentId, id) => {
    const ids = seen.get(agentId) ?? new Set();
    seen.set(agentId, ids);
    if (ids.has(id)) {
      return false;
    }
    ids.add(id);
    if (ids.size > SEEN_LIMIT) {
      ids.delete(ids.values().next().value);
    }
    return true;
  };

  /** The renderer of the turn running on a session now, if this adapter started it. */
  const rendererFor = (sessionId) => {
    const queue = renderers.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    if (gateway.activeTurnId) {
      const active = gateway.activeTurnId(sessionId);
      return active === undefined ? undefined : queue.find((entry) => entry.turnId === active);
    }
    return queue[0];
  };

  const onBusEvent = (event) => {
    if (!event || typeof event.sessionId !== 'string') {
      return;
    }
    const entry = rendererFor(event.sessionId);
    if (!entry) {
      return;
    }
    if (event.type === 'session.updated' && event.status === 'running') {
      entry.renderer.beginTurn();
      return;
    }
    entry.renderer.onEvent(event);
  };

  const handle = async (agentId, agent, bot, message, raw) => {
    const verdict = admit(message, agent, bot.botId);
    if (!verdict.admit) {
      return;
    }
    if (!firstSighting(agentId, message.id)) {
      return;
    }
    const text = withoutMention(message.content, bot.botId);
    if (text.length === 0) {
      // Attachments aren't read yet, and a bare mention asks nothing.
      return;
    }
    const route = routeFor(message);
    const direct = verdict.kind === 'direct';
    let replyChannel = route.thread ?? message.channelId;
    let replyTo;
    if (route.startThread) {
      try {
        replyChannel = await threadFrom(bot.rest, message.channelId, message.id, text);
      } catch (error) {
        // No permission to start threads here: answer under the message
        // in the channel. The session is still the message's own.
        warn(`discord: ${agentId} could not open a thread in ${message.channelId}, replying in the channel: ${error instanceof Error ? error.message : String(error)}`);
        replyChannel = message.channelId;
        replyTo = message.id;
      }
    }
    const sessionId = sessionIdFor(agentId, route);
    const author = authorName(raw);
    // Per message, never per session: a thread is one session for
    // everyone in it. Another bot is below a principal whatever the list
    // says, as on Slack.
    const senderTrust = verdict.principal && !message.authorIsBot ? 'user' : 'unknown';
    const metadata = {
      channel: 'discord',
      team: route.team,
      discordChannel: replyChannel,
      discordConversation: route.conversation,
      ...(route.thread ? { discordThread: route.thread } : {}),
      discordUser: message.authorId,
      senderTrust,
      // Who a DM is with reaches the system prompt, so it is named only for
      // someone the operator listed. A guild channel isn't described: the
      // adapter can't tell public from private without reading permission
      // overwrites, and a wrong description is worse than none.
      ...(direct ? { conversation: { kind: 'direct', ...(senderTrust === 'user' ? { with: author } : {}) } } : {}),
    };
    const userMessage = direct ? text : `${author}: ${text}`;
    const idempotencyKey = `discord:${message.id}`;

    let first = true;
    const renderer = createRenderer({
      warn,
      ops: {
        post: async (piece) => {
          const [id] = await postText(bot.rest, replyChannel, piece, first && replyTo ? { replyTo } : {});
          first = false;
          return id;
        },
        edit: (id, piece) => editText(bot.rest, replyChannel, id, piece),
        remove: (id) => removeMessage(bot.rest, replyChannel, id),
        typing: () => typing(bot.rest, replyChannel),
      },
    });
    const entry = { turnId: randomUUID(), renderer };
    const queue = renderers.get(sessionId) ?? [];
    queue.push(entry);
    renderers.set(sessionId, queue);

    let repeat;
    let absorbed = false;
    let session;
    let failure;
    try {
      session = await gateway.dispatch({
        sessionId,
        agentId,
        userMessage,
        metadata,
        turnId: entry.turnId,
        idempotencyKey,
        onRepeat: (kind) => {
          repeat = kind;
        },
        onAbsorbed: () => {
          absorbed = true;
        },
      });
    } catch (error) {
      failure = error;
    }
    // The next queued turn's events are its own renderer's from here.
    const left = (renderers.get(sessionId) ?? []).filter((other) => other !== entry);
    if (left.length > 0) {
      renderers.set(sessionId, left);
    } else {
      renderers.delete(sessionId);
    }

    if (repeat === 'live' || absorbed) {
      // Another delivery's renderer answers this turn.
      await renderer.withdraw();
      return;
    }
    if (session) {
      const failed = turnFailureFor(session, idempotencyKey);
      if (failed !== undefined) {
        await renderer.fail(failed);
        return;
      }
      await renderer.finalize(repeat === 'finished' ? turnReplyFor(session, idempotencyKey) : latestTurnReply(session));
      return;
    }
    await renderer.fail(failure instanceof Error ? failure.message : String(failure));
  };

  return {
    name: 'discord',

    async start(host) {
      gateway = host;
      stopping = false;
      unsubscribe = host.bus.subscribe(onBusEvent);
      const roster = new Set(host.agents().map((agent) => agent.id));
      for (const [agentId, agent] of config.agents) {
        if (!roster.has(agentId)) {
          warn(`discord: no roster agent with id ${agentId}; skipping its Discord bot`);
          continue;
        }
        const token = secrets[agentId]?.botToken;
        if (typeof token !== 'string' || token.length === 0) {
          warn(`discord: ${agentId} has no bot token. Store one with \`stratus channel set discord --agent ${agentId} botToken\`.`);
          continue;
        }
        // Messages can arrive between READY and connect() returning; they
        // wait for the connection rather than being dropped.
        let resolveBot;
        const ready = new Promise((resolve) => {
          resolveBot = resolve;
        });
        try {
          const bot = await connect({
            token,
            api,
            log,
            onMessage: (normalized, raw) => {
              if (!stopping) {
                track(ready.then((connected) => handle(agentId, agent, connected, normalized, raw)));
              }
            },
            onFatal: (error) => warn(`discord: ${agentId}: ${error.message}`),
          });
          bots.set(agentId, bot);
          resolveBot(bot);
          log(`discord: ${agentId} connected as bot ${bot.botId}`);
        } catch (error) {
          warn(`discord: ${agentId} could not connect: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },

    async stop() {
      stopping = true;
      // Nothing new comes in; what is being answered finishes over REST.
      await Promise.all([...bots.values()].map((bot) => bot.close().catch(() => {})));
      bots.clear();
      // The gateway drains its turns before it stops channels, so this is
      // normally quick; a turn that never settles doesn't hold the stop.
      let timer;
      const drained = await Promise.race([
        Promise.all([...inFlight]).then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), drainTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) {
        warn(`discord: stopped with ${inFlight.size} repl${inFlight.size === 1 ? 'y' : 'ies'} unfinished after ${drainTimeoutMs}ms`);
      }
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
};
