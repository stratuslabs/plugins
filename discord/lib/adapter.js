import { randomUUID } from 'node:crypto';
import { admit } from './admission.js';
import { approvalMessage, EPHEMERAL, outcomeMessage, parseCustomId } from './approvals.js';
import { CDN_HOSTS, readAttachments, textBlocks, unreadNote } from './attachments.js';
import { connectBot, isRetryable } from './gateway.js';
import { normalizeMessage } from './normalize.js';
import { createAddressing } from './outbound.js';
import { createPositions } from './positions.js';
import { createRenderer } from './render.js';
import { answerInteraction, editPrompt, editText, postPrompt, postText, removeMessage, threadFrom, threadOn, typing, uploadFile } from './send.js';
import { routeFor, sessionIdFor } from './sessions.js';
import { isStopRequest } from './stop.js';
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

/** How far back a restart looks for messages it missed, and how many it reads per conversation. */
export const BACKFILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BACKFILL_LIMIT = 200;

/**
 * A bot that can't reach Discord when the daemon starts tries again after
 * each of these waits in turn, then every last one, until it connects or
 * the channel stops. An attempt with no answer in CONNECT_TIMEOUT_MS
 * counts as failed. After the first connection the library reconnects.
 */
export const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
export const CONNECT_TIMEOUT_MS = 60_000;

export const createDiscordAdapter = ({ config, secrets, api, log = () => {}, warn = () => {}, connect = connectBot, drainTimeoutMs = DRAIN_TIMEOUT_MS, reconnectDelaysMs = RECONNECT_DELAYS_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, cdnHosts = CDN_HOSTS, stateDirectory, positionsWriteDelayMs }) => {
  const bots = new Map();
  const renderers = new Map(); // sessionId -> [{ turnId, renderer, controller, stoppedBy? }]
  const prompts = new Map(); // requestId -> a posted approval prompt
  const rendering = new Set(); // requestIds whose prompt is being posted
  const settledWhileRendering = new Map(); // requestId -> the resolved event
  const seen = new Map(); // agentId -> Set of message ids, insertion-ordered
  const inFlight = new Set();
  let gateway;
  let unsubscribe;
  let stopping = false;
  // Fired by stop(): gives up attempts underway and waits for the next.
  let stopController = new AbortController();
  const retryTimers = new Set();
  const positions = createPositions({ stateDirectory, warn, ...(positionsWriteDelayMs !== undefined ? { writeDelayMs: positionsWriteDelayMs } : {}) });

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

  const nameOf = (agentId) => gateway.agents().find((agent) => agent.id === agentId)?.name ?? agentId;

  /**
   * Ask a parked call's approvers in the conversation it came from. Only a
   * Discord conversation's: approval requests are a broadcast, and a
   * request from a Slack thread, the CLI or a schedule is another
   * surface's to ask, so this neither posts nor denies it.
   */
  const askApproval = async (event) => {
    const origin = event.delegatedFrom;
    const viaOrigin = origin && bots.has(origin.agentId) ? origin : undefined;
    const askingAgent = viaOrigin?.agentId ?? event.agentId;
    const metadata = (viaOrigin ? origin.metadata : event.metadata) ?? {};
    const scheduled = event.scheduleDestination?.channel?.trim().toLowerCase() === 'discord' ? event.scheduleDestination : undefined;
    const here = metadata.channel === 'discord' && typeof metadata.discordChannel === 'string' ? metadata.discordChannel : undefined;
    if (here === undefined && scheduled?.to === undefined) {
      return;
    }
    const decline = (why) => {
      warn(`discord: ${why}; denying ${event.call.toolName} for ${event.agentId}`);
      gateway.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
    };
    const bot = bots.get(askingAgent);
    const agent = config.agents.get(askingAgent);
    if (!bot || !agent) {
      // Its conversation is on Discord and nobody here can ask in it: say
      // so now rather than letting the call wait out the timeout.
      decline(`${askingAgent} has no live Discord connection`);
      return;
    }
    const agentName = viaOrigin && origin.agentId !== event.agentId ? `${nameOf(event.agentId)} (for ${nameOf(origin.agentId)})` : nameOf(event.agentId);
    const post = {
      bot,
      agentId: event.agentId,
      agentName,
      toolName: event.call.toolName,
      risk: event.risk,
      oneShot: event.oneShot === true,
      always: event.always,
      approvers: agent.approvers,
    };
    rendering.add(event.requestId);
    let failure;
    // A conversation's own channel is where it is. A schedule's `thread`
    // is a thread in `to`, or a message there to ask under.
    let channelId = here;
    let replyTo;
    try {
      if (channelId === undefined) {
        ({ target: channelId, replyTo } = await addressing.threadTarget(bot, askingAgent, scheduled.to, scheduled.thread));
      }
    } catch (error) {
      failure = (error instanceof Error ? error.message : String(error)).replace(/^discord: /, '');
    }
    if (failure === undefined) {
      post.channelId = channelId;
      try {
        post.messageId = await postPrompt(bot.rest, channelId, approvalMessage({
          agentName,
          toolName: event.call.toolName,
          risk: event.risk,
          input: event.call.input,
          origin: event.origin,
          oneShot: post.oneShot,
          always: event.always,
          requestId: event.requestId,
        }), replyTo ? { replyTo } : {});
        prompts.set(event.requestId, post);
      } catch (error) {
        failure = `could not post an approval request in ${channelId} (${error instanceof Error ? error.message : String(error)})`;
      }
    }
    rendering.delete(event.requestId);
    const settled = settledWhileRendering.get(event.requestId);
    if (settled) {
      // Decided while the post was in flight: never declined a second
      // time, only shown as settled.
      settledWhileRendering.delete(event.requestId);
      if (!failure) {
        await settleApproval(settled);
      }
      return;
    }
    if (failure) {
      decline(failure);
    }
  };

  /** Every ending (a click, the timeout, a cancelled turn) takes the buttons off. */
  const settleApproval = async (event) => {
    const post = prompts.get(event.requestId);
    if (!post) {
      if (rendering.has(event.requestId)) {
        settledWhileRendering.set(event.requestId, event);
      }
      return;
    }
    prompts.delete(event.requestId);
    try {
      await editPrompt(post.bot.rest, post.channelId, post.messageId, { content: outcomeMessage(post, event) });
    } catch (error) {
      warn(`discord: could not update a settled approval request: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** A button click. Answered every time, so the clicker never sees "This interaction failed". */
  const onInteraction = async (bot, interaction) => {
    const parsed = interaction?.type === 3 ? parseCustomId(interaction.data?.custom_id) : undefined;
    if (!parsed) {
      return;
    }
    const reply = (body) => answerInteraction(bot.rest, interaction, body).catch((error) => {
      warn(`discord: could not answer a button click: ${error instanceof Error ? error.message : String(error)}`);
    });
    const tell = (content) => reply({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
    const clicker = interaction.member?.user?.id ?? interaction.user?.id;
    const post = prompts.get(parsed.requestId);
    if (!post) {
      if (rendering.has(parsed.requestId)) {
        // Discord can show a message before the post call returns; this
        // one is live, the index just hasn't caught up.
        await tell('That approval request is still being posted. Try again in a moment.');
        return;
      }
      // Asked by a daemon that is gone, or already settled: the message
      // itself is corrected, so nobody else is offered a dead decision.
      await reply({ type: 7, data: { content: 'This request is no longer pending.', components: [], allowed_mentions: { parse: [] } } });
      return;
    }
    if (post.bot !== bot) {
      // Another agent's bot relaying a click would get around the approver
      // set bound to this request.
      await reply({ type: 6 });
      return;
    }
    if (!clicker || !post.approvers.has(clicker)) {
      // Not a decision: consuming the request would let anyone in the
      // channel deny the agent's work.
      await tell(`You are not an approver for ${post.agentName}, so that decision was not recorded.`);
      return;
    }
    if (!gateway.resolveApproval({ requestId: parsed.requestId, answer: parsed.answer, actor: clicker })) {
      await tell('That approval request is no longer pending.');
      return;
    }
    // The prompt is rewritten from tool.approval-resolved, which
    // resolveApproval emits, so a click and the timeout settle it the same way.
    await reply({ type: 6 });
  };

  /**
   * Stop: cancels every turn on this conversation's session, the ones this
   * adapter started and any other (a recovered turn), and says nothing was
   * stopped when nothing was running. The caller checked the sender is an
   * approver.
   */
  const stopTurns = (sessionId, by, byName) => {
    const running = renderers.get(sessionId) ?? [];
    const reason = `Stopped from Discord by ${by}`;
    for (const entry of running) {
      if (entry.stoppedBy === undefined) {
        entry.stoppedBy = byName;
        entry.controller.abort(new Error(reason));
      }
    }
    const onSession = gateway.abortTurns?.(sessionId, reason) ?? 0;
    return running.length > 0 || onSession > 0;
  };

  const onBusEvent = (event) => {
    if (event?.type === 'tool.approval-requested') {
      track(askApproval(event));
      return;
    }
    if (event?.type === 'tool.approval-resolved') {
      track(settleApproval(event));
      return;
    }
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
    // An approver's stop, in a conversation that has a session: checked
    // before admission, because in a thread it needs no mention. With
    // nothing running it is an ordinary message.
    if (!message.authorIsBot && agent.approvers.has(message.authorId) && isStopRequest(message.content, bot.botId)) {
      const route = routeFor(message);
      if (!route.startThread && firstSighting(agentId, `stop:${message.id}`)) {
        const sessionId = sessionIdFor(agentId, route);
        if (stopTurns(sessionId, message.authorId, authorName(raw))) {
          firstSighting(agentId, message.id);
          positions.passed(agentId, message);
          log(`discord: ${message.authorId} stopped ${agentId} in ${message.channelId}`);
          return;
        }
      }
    }
    const verdict = admit(message, agent, bot.botId);
    if (!verdict.admit) {
      positions.passed(agentId, message);
      return;
    }
    if (!firstSighting(agentId, message.id)) {
      return;
    }
    // Held until its answer is out, so a restart before then finds it again.
    positions.begin(agentId, message);
    let outcome;
    try {
      outcome = await answer(agentId, agent, bot, message, raw, verdict);
    } finally {
      if (outcome !== 'kept') {
        positions.end(agentId, message);
      }
    }
  };

  // Per session, the last message still on its way to the gateway. Reading
  // a message's attachments takes time a plain message doesn't, so each
  // waits until the one before it has been handed over: the agent reads a
  // conversation in the order it was written. Other sessions don't wait.
  const intakes = new Map();
  const inOrder = (sessionId) => {
    const before = intakes.get(sessionId) ?? Promise.resolve();
    let release;
    const handed = new Promise((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => handed);
    intakes.set(sessionId, tail);
    return {
      before,
      handed: () => {
        release();
        if (intakes.get(sessionId) === tail) {
          intakes.delete(sessionId);
        }
      },
    };
  };

  const answer = async (agentId, agent, bot, message, raw, verdict) => {
    const turn = inOrder(sessionIdFor(agentId, routeFor(message)));
    try {
      await turn.before;
      return await answerInOrder(agentId, agent, bot, message, raw, verdict, turn.handed);
    } finally {
      turn.handed();
    }
  };

  const answerInOrder = async (agentId, agent, bot, message, raw, verdict, handed) => {
    const text = withoutMention(message.content, bot.botId);
    // Read only once admitted: nothing is downloaded for a message the
    // agent won't answer.
    const { images, texts, unread } = await readAttachments(raw.attachments, { cdnHosts, signal: stopController.signal, warn });
    if (stopping) {
      // Stopped mid-download: held, so the next start answers it whole.
      return 'kept';
    }
    if (text.length === 0 && images.length === 0 && texts.length === 0) {
      // A bare mention asks nothing, and nor does a file nothing here can
      // open with nothing said. An image or a text file alone is a question.
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
        // Its thread may be open already: from a run that stopped before
        // answering, or opened by someone else meanwhile. Later messages
        // there are this session's, so the answer goes there too.
        const existing = await threadOn(bot.rest, message.channelId, message.id);
        if (existing !== undefined) {
          replyChannel = existing;
        } else {
          // No permission to start threads here: answer under the message
          // in the channel. The session is still the message's own.
          warn(`discord: ${agentId} could not open a thread in ${message.channelId}, replying in the channel: ${error instanceof Error ? error.message : String(error)}`);
          replyChannel = message.channelId;
          replyTo = message.id;
        }
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
    const spoken = direct ? text : (text.length > 0 ? `${author}: ${text}` : `${author}:`);
    const userMessage = `${spoken}${textBlocks(texts)}${unreadNote(unread)}`;
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
        upload: (filePath) => uploadFile(bot.rest, replyChannel, filePath),
      },
    });
    const entry = { turnId: randomUUID(), renderer, controller: new AbortController() };
    const queue = renderers.get(sessionId) ?? [];
    queue.push(entry);
    renderers.set(sessionId, queue);

    let repeat;
    let absorbed = false;
    let session;
    let failure;
    let dispatched;
    try {
      dispatched = gateway.dispatch({
        sessionId,
        agentId,
        userMessage,
        ...(images.length > 0 ? { images } : {}),
        metadata,
        turnId: entry.turnId,
        signal: entry.controller.signal,
        idempotencyKey,
        onRepeat: (kind) => {
          repeat = kind;
        },
        onAbsorbed: () => {
          absorbed = true;
        },
      });
    } catch (error) {
      dispatched = Promise.reject(error);
    }
    // Queued at the gateway: the next message in this session may go.
    handed();
    try {
      session = await dispatched;
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

    if (entry.stoppedBy !== undefined) {
      await renderer.stopped(entry.stoppedBy);
      return;
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
    if (failure?.name === 'GatewayStoppingError') {
      // Reached a daemon on its way down: it stays held, so the next start
      // reads it again and answers it then.
      await renderer.finalize(failure.restarting === true
        ? "I'm restarting. I'll answer this when I'm back."
        : "I'm shutting down. I'll answer this when I'm running again.");
      return 'kept';
    }
    await renderer.fail(failure instanceof Error ? failure.message : String(failure));
  };

  const addressing = createAddressing({ bots, config });

  /**
   * After a (re)connect: read on from where each conversation was left and
   * hand every message found to the same path a live one takes. Admission,
   * the in-memory dedupe and the gateway's idempotency key decide what is
   * answered; a turn that finished before the restart is posted from the
   * session, not run again. Bounded to the last day and BACKFILL_LIMIT
   * messages per conversation.
   */
  const backfill = async (agentId, agent, bot) => {
    const floor = (BigInt(Date.now() - BACKFILL_MAX_AGE_MS) - 1420070400000n) << 22n;
    let handed = 0;
    for (const { conversation, after, guildId, parentId } of positions.conversations(agentId)) {
      if (stopping) {
        return;
      }
      if (parentId && !bot.threads.has(conversation)) {
        bot.threads.set(conversation, parentId);
      }
      let cursor = BigInt(after) > floor ? BigInt(after) : floor;
      for (let read = 0; read < BACKFILL_LIMIT;) {
        let page;
        try {
          page = await bot.rest.get(`/channels/${conversation}/messages`, { query: new URLSearchParams({ limit: '100', after: String(cursor) }) });
        } catch (error) {
          if (error?.status === 403 || error?.status === 404) {
            // Gone, or no longer visible to this bot: nothing to read there again.
            positions.drop(agentId, conversation);
          } else {
            warn(`discord: ${agentId} could not read ${conversation} for messages sent while it was down: ${error instanceof Error ? error.message : String(error)}`);
          }
          break;
        }
        if (!Array.isArray(page) || page.length === 0) {
          break;
        }
        const ordered = [...page].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).slice(0, BACKFILL_LIMIT - read);
        for (const raw of ordered) {
          // A REST message says neither its guild nor, for a thread, its parent.
          const data = { ...raw, channel_id: conversation, ...(guildId ? { guild_id: guildId } : {}) };
          if (!stopping) {
            handed += 1;
            track(handle(agentId, agent, bot, normalizeMessage(data, bot.threads), data));
          }
        }
        read += ordered.length;
        cursor = BigInt(ordered[ordered.length - 1].id);
        if (page.length < 100) {
          break;
        }
      }
    }
    if (handed > 0) {
      log(`discord: ${agentId} read ${handed} message${handed === 1 ? '' : 's'} sent while it was away`);
    }
  };

  const errorText = (error) => (error instanceof Error ? error.message : String(error));

  /**
   * One attempt to connect an agent's bot. A failure Discord may get over
   * (it's unreachable, or slow to answer) schedules the next attempt; one it
   * won't (a refused token) is only reported.
   */
  const connectAgent = async (agentId, agent, token, attempt) => {
    // Messages can arrive between READY and connect() returning; they
    // wait for the connection rather than being dropped.
    let resolveBot;
    const ready = new Promise((resolve) => {
      resolveBot = resolve;
    });
    // Live messages wait behind a backfill that is reading what came before
    // them, so the agent still reads each conversation in the order it was
    // written. Interactions don't wait. Set before the first READY, so what
    // arrives while connect() is still running waits for the start's own read.
    let releaseCaughtUp;
    let caughtUp = new Promise((resolve) => {
      releaseCaughtUp = resolve;
    });
    const readOn = (connected) => backfill(agentId, agent, connected).catch((error) => {
      warn(`discord: ${agentId} could not read messages sent while it was away: ${errorText(error)}`);
    });
    const timeout = AbortSignal.timeout(connectTimeoutMs);
    let bot;
    try {
      bot = await connect({
        token,
        api,
        log,
        signal: AbortSignal.any([stopController.signal, timeout]),
        onMessage: (normalized, raw) => {
          if (!stopping) {
            track(caughtUp.then(() => ready).then((connected) => handle(agentId, agent, connected, normalized, raw)));
          }
        },
        onInteraction: (interaction) => {
          if (!stopping) {
            track(ready.then((connected) => onInteraction(connected, interaction)));
          }
        },
        onFatal: (error) => warn(`discord: ${agentId}: ${error.message}`),
        // A new session (not a resume) means Discord won't replay what
        // was missed while disconnected; read it instead.
        onReconnect: () => {
          if (!stopping) {
            // Synchronous with the READY, so no message after it slips ahead.
            caughtUp = caughtUp.then(() => ready).then(readOn);
            track(caughtUp);
          }
        },
      });
    } catch (error) {
      if (stopping) {
        return;
      }
      const reason = timeout.aborted ? `no answer from Discord in ${connectTimeoutMs}ms` : errorText(error);
      if (!timeout.aborted && !isRetryable(error)) {
        warn(`discord: ${agentId} could not connect: ${reason}`);
        return;
      }
      const delay = reconnectDelaysMs[Math.min(attempt, reconnectDelaysMs.length - 1)];
      warn(`discord: ${agentId} could not connect: ${reason}. Trying again in ${delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`}.`);
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (!stopping) {
          track(connectAgent(agentId, agent, token, attempt + 1));
        }
      }, delay);
      retryTimers.add(timer);
      return;
    }
    if (stopping) {
      await bot.close().catch(() => {});
      return;
    }
    bots.set(agentId, bot);
    resolveBot(bot);
    log(`discord: ${agentId} connected as bot ${bot.botId}${attempt > 0 ? ` after ${attempt + 1} attempts` : ''}`);
    if (stateDirectory) {
      const read = readOn(bot);
      track(read);
      read.then(releaseCaughtUp);
    } else {
      releaseCaughtUp();
    }
  };

  return {
    name: 'discord',
    resolveOutbound: addressing.resolveOutbound,
    readConversation: addressing.readConversation,
    conversationKindFor: addressing.conversationKindFor,

    async start(host) {
      gateway = host;
      stopping = false;
      stopController = new AbortController();
      unsubscribe = host.bus.subscribe(onBusEvent);
      if (stateDirectory) {
        positions.load();
      } else {
        warn('discord: this host gives plugins no state directory, so messages sent while the daemon is down will not be answered when it is back.');
      }
      const roster = new Set(host.agents().map((agent) => agent.id));
      const attempts = [];
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
        attempts.push(connectAgent(agentId, agent, token, 0));
      }
      // Each bot connects on its own; one Discord can't reach doesn't hold up the rest.
      await Promise.all(attempts);
    },

    async stop() {
      stopping = true;
      stopController.abort(new Error('the Discord channel is stopping'));
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
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
        // What is left stays as it is in Discord; its typing stops, and
        // nothing more is sent from a channel that has stopped.
        for (const queue of renderers.values()) {
          for (const entry of queue) entry.renderer.halt();
        }
        warn(`discord: stopped with ${inFlight.size} repl${inFlight.size === 1 ? 'y' : 'ies'} unfinished after ${drainTimeoutMs}ms`);
      }
      positions.flush();
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
};
