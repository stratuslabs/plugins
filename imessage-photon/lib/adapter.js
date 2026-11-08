import { createHash, randomUUID } from 'node:crypto';

import { latestTurnReply, turnFailureFor, turnReplyFor } from '@stratusagent/core';

import { admit, idempotencyKeyFor, sessionIdFor } from './admission.js';
import { newCode, outcomeText, parseAnswer, promptText, WRONG_ANSWER_LIMIT } from './approvals.js';
import { createPhotonAuth } from './cloud.js';
import { createCursorStore } from './cursor.js';
import { maskHandle, normalizeHandle } from './handles.js';
import { createLineIntake } from './intake.js';
import { splitMessages, toPlainText } from './text.js';

export const CHANNEL = 'imessage-photon';

const SEND_RETRY_MS = [2000, 10_000, 30_000];
const START_RETRY_MS = [5000, 15_000, 60_000, 300_000];

const sleepFor = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/** The texts `text` goes out as; none when only formatting is left. */
const piecesOf = (text, markdown) => splitMessages(markdown ? toPlainText(text) : text);

/** A UUID-shaped id that is the same for the same key: Photon drops a second send with one it has seen. */
const clientMessageIdFor = (key) => {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** What the person typed, then a note naming the files the agent can't open on this channel yet. */
const userMessageFor = (message) => {
  if (message.attachments.length === 0) {
    return message.text;
  }
  const names = message.attachments.map((file) => `${file.fileName || 'a file'} (${file.mimeType || 'unknown type'})`).join(', ');
  const note = `[They also sent ${message.attachments.length === 1 ? 'a file' : `${message.attachments.length} files`} this channel can't open yet: ${names}.]`;
  return message.text.trim().length > 0 ? `${message.text}\n\n${note}` : note;
};

/**
 * The default connection to one Photon line: Photon's Advanced iMessage
 * SDK over gRPC with TLS, a fresh bearer token per call, retried unary
 * calls, and an idempotency key on every write.
 */
const connectWithSdk = async ({ address, token }) => {
  const { createGrpcClient } = await import('@photon-ai/advanced-imessage');
  return createGrpcClient({ address, token, tls: true, retry: true, autoIdempotency: true });
};

/**
 * The iMessage channel adapter over Photon's hosted lines. Each agent has
 * its own Photon project (its transport secrets); each line of it is read
 * by lib/intake.js, which hands received texts here in order. A text is
 * admitted or refused, dispatched to the gateway with a key that makes a
 * repeat harmless, and answered as plain text in the chat it came from,
 * on the line it came in on.
 *
 * Approvals go to the agent's approvers by text with a code, and an
 * approver's "stop" ends the turn under way in their conversation, as in
 * the local iMessage plugin. Who can be texted first (`resolveOutbound`,
 * for `message.send` and schedules) is the agent's principals and
 * approvers.
 */
export const createPhotonAdapter = ({
  config,
  secrets,
  stateDirectory,
  connect = connectWithSdk,
  fetch,
  log = () => {},
  warn = log,
  now = Date.now,
  sendRetryMs = SEND_RETRY_MS,
  startRetryMs = START_RETRY_MS,
  retryMs,
  random,
}) => {
  // agentId -> { agent, lines: Map(lineKey -> { line, client, intake }), chats: Map(handle -> { line, chatGuid }) }
  const running = new Map();
  // requestId -> an approval request put to approvers by text, while it is pending.
  const asks = new Map();
  // sessionId -> the AbortControllers of turns this adapter dispatched there and is waiting on.
  const turns = new Map();
  const toldStopped = new WeakSet();
  const stopController = new AbortController();
  const starting = new Set();
  let host;
  let unsubscribe;
  let store;

  const stopping = () => stopController.signal.aborted;

  /**
   * Sends `text` as one or more texts. Text with nothing left once its
   * markdown is gone is refused rather than reported as sent. With
   * `wanted`, stops quietly before any attempt once it says no, and
   * returns false.
   */
  const sendPieces = async (agentId, client, chatGuid, text, { markdown = true, key, wanted } = {}) => {
    const pieces = piecesOf(text, markdown);
    if (pieces.length === 0) {
      throw new Error('there is nothing to send: the message is empty once formatted for iMessage');
    }
    for (const [index, piece] of pieces.entries()) {
      const options = key ? { clientMessageId: clientMessageIdFor(`${key}:${index}`) } : {};
      for (let attempt = 0; ; attempt += 1) {
        if (wanted && !wanted()) {
          return false;
        }
        try {
          await client.messages.sendText(chatGuid, piece, options);
          break;
        } catch (error) {
          if (attempt >= sendRetryMs.length || stopping()) {
            throw error;
          }
          warn(`imessage-photon: ${agentId} could not send, retrying: ${error.message}`);
          await sleepFor(sendRetryMs[attempt], stopController.signal);
        }
      }
    }
    return true;
  };

  /**
   * Where to text `handle`: the chat they last texted the agent from, on
   * that line, or else a direct chat Photon opens on the agent's first line.
   * A shared-pool line can't start a conversation, so there the person has
   * to have texted first.
   */
  const chatFor = async (entry, handle) => {
    const known = entry.chats.get(handle);
    if (known && entry.lines.has(known.line)) {
      return { client: entry.lines.get(known.line).client, chatGuid: known.chatGuid };
    }
    const first = entry.lines.values().next().value;
    if (!first) {
      throw new Error('it has no Photon line connected');
    }
    const created = await first.client.chats.create([handle]);
    const chatGuid = created?.chat?.guid;
    if (typeof chatGuid !== 'string') {
      throw new Error('Photon opened no chat for that handle');
    }
    entry.chats.set(handle, { line: first.line.key, chatGuid });
    return { client: first.client, chatGuid };
  };

  const deliverTo = async (agentId, handle, text, options) => {
    const entry = running.get(agentId);
    if (!entry) {
      throw new Error(`${agentId} is not on iMessage here`);
    }
    const { client, chatGuid } = await chatFor(entry, handle);
    return sendPieces(agentId, client, chatGuid, text, options);
  };

  /** Sends without failing the caller: for notes whose loss costs nothing but the note. */
  const tell = async (agentId, handle, text) => {
    try {
      await deliverTo(agentId, handle, text, { markdown: false });
    } catch (error) {
      warn(`imessage-photon: ${agentId} could not send a note to ${maskHandle(handle)}: ${error.message}`);
    }
  };

  const nameOf = (agentId) => host?.agents?.().find((agent) => agent.id === agentId)?.name ?? agentId;

  /**
   * A gated call from a conversation on this channel: put it to the
   * agent's approvers by text. The person in the conversation is asked
   * when they are an approver; otherwise every approver is. A request from
   * another surface is that surface's to ask, so this neither sends nor
   * denies it.
   */
  const askApproval = async (event) => {
    const origin = event.delegatedFrom;
    const viaOrigin = origin?.metadata?.channel === CHANNEL && running.has(origin.agentId) ? origin : undefined;
    const metadata = (viaOrigin ? origin.metadata : event.metadata) ?? {};
    const scheduled = event.scheduleDestination?.channel?.trim().toLowerCase() === CHANNEL ? event.scheduleDestination : undefined;
    const here = metadata.channel === CHANNEL && typeof metadata.photonTo === 'string' ? metadata.photonTo : undefined;
    if (here === undefined && scheduled?.to === undefined) {
      return;
    }
    const askingAgent = viaOrigin?.agentId ?? event.agentId;
    const decline = (why) => {
      warn(`imessage-photon: ${why}; denying ${event.call?.toolName} for ${event.agentId}`);
      host.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
    };
    const entry = running.get(askingAgent);
    if (!entry) {
      decline(`${askingAgent} is not on iMessage here`);
      return;
    }
    const person = normalizeHandle(here ?? scheduled.to);
    const recipients = person !== null && entry.agent.approvers.has(person) ? [person] : [...entry.agent.approvers];
    let code;
    do {
      code = newCode(random);
    } while ([...asks.values()].some((ask) => ask.code === code));
    const agentName = viaOrigin && origin.agentId !== event.agentId ? `${nameOf(event.agentId)} (for ${nameOf(origin.agentId)})` : nameOf(event.agentId);
    const ask = {
      requestId: event.requestId,
      agentId: askingAgent,
      code,
      askedTo: recipients,
      wrong: 0,
      spent: false,
      oneShot: event.oneShot === true,
      toolName: event.call?.toolName ?? 'a tool',
      agentName,
    };
    asks.set(event.requestId, ask);
    // Answered, timed out or denied while prompts were still going out:
    // nobody else is asked, and a send waiting on a retry is dropped, so
    // no code arrives after the note saying how it ended.
    const pending = () => asks.get(event.requestId) === ask && !ask.spent;
    let delivered = 0;
    for (const to of recipients) {
      if (!pending()) {
        break;
      }
      try {
        const sent = await deliverTo(askingAgent, to, promptText({
          agentName,
          toolName: ask.toolName,
          risk: event.risk,
          input: event.call?.input,
          origin: event.origin,
          oneShot: ask.oneShot,
          always: event.always,
          code,
          ...(person !== null && person !== to ? { about: maskHandle(person) } : {}),
        }), { markdown: false, wanted: pending });
        if (sent) {
          delivered += 1;
        }
      } catch (error) {
        warn(`imessage-photon: ${askingAgent} could not send an approval request to ${maskHandle(to)}: ${error.message}`);
      }
    }
    if (delivered === 0 && pending()) {
      asks.delete(event.requestId);
      decline('no approver could be texted');
    }
  };

  const settleApproval = async (event) => {
    const ask = asks.get(event.requestId);
    if (!ask) {
      return;
    }
    asks.delete(event.requestId);
    const text = ask.guessed
      ? `${ask.agentName}: ${ask.toolName} was denied after ${WRONG_ANSWER_LIMIT} wrong answers to its code. Someone may be guessing.`
      : outcomeText(ask, event);
    for (const to of ask.askedTo) {
      await tell(ask.agentId, to, text);
    }
  };

  /**
   * A text that reads as an approval answer, while this agent has a request
   * pending: settled here, never dispatched. Returns undefined when it is
   * not one, decided synchronously, so a message that goes on to dispatch
   * keeps its place behind the messages before it; otherwise a promise for
   * the notes it sends.
   */
  const answerApproval = (agentId, agent, message) => {
    const parsed = parseAnswer(message.text);
    if (!parsed) {
      return undefined;
    }
    const pending = [...asks.values()].filter((ask) => ask.agentId === agentId && !ask.spent);
    if (pending.length === 0) {
      return undefined;
    }
    const from = normalizeHandle(message.from);
    const overIMessage = message.service === 'iMessage';
    const approver = from !== null && agent.approvers.has(from);
    if (parsed.code === undefined) {
      if (approver && overIMessage && pending.some((ask) => ask.askedTo.includes(from))) {
        return tell(agentId, from, 'To answer the approval request, reply with its code too, like Y K7QM2X.');
      }
      return undefined;
    }
    const ask = pending.find((candidate) => candidate.code === parsed.code);
    if (ask && approver && overIMessage) {
      ask.spent = true;
      if (!host.resolveApproval({ requestId: ask.requestId, answer: parsed.answer, actor: from })) {
        asks.delete(ask.requestId);
        return tell(agentId, from, 'That request is no longer pending.');
      }
      return Promise.resolve();
    }
    // A wrong code, a code over SMS, or a code from someone who is not an
    // approver: all count as guesses against every request pending.
    log(`imessage-photon: ${agentId} counted a wrong approval answer from ${maskHandle(from ?? message.from)} over ${message.service}.`);
    for (const candidate of pending) {
      candidate.wrong += 1;
      if (candidate.wrong >= WRONG_ANSWER_LIMIT) {
        candidate.spent = true;
        candidate.guessed = true;
        warn(`imessage-photon: ${agentId} denied ${candidate.toolName} after ${WRONG_ANSWER_LIMIT} wrong answers to its approval code.`);
        host.resolveApproval({ requestId: candidate.requestId, answer: 'deny', reason: 'undeliverable' });
      }
    }
    return approver && overIMessage ? tell(agentId, from, "That code doesn't match a pending request.") : Promise.resolve();
  };

  /**
   * "stop" from an approver over iMessage, while a turn runs in their
   * conversation: ends it, including a turn the host recovered after a
   * restart that no adapter started. With nothing running it is an
   * ordinary message. Only an approver, since a stop throws away work.
   */
  const stopRequest = (agentId, agent, message) => {
    if (!/^\s*stop[\s.!]*$/i.test(message.text) || message.service !== 'iMessage') {
      return false;
    }
    const from = normalizeHandle(message.from);
    if (from === null || !agent.approvers.has(from)) {
      return false;
    }
    const sessionId = sessionIdFor(agentId, from);
    const reason = `Stopped from iMessage by ${maskHandle(from)}`;
    const mine = turns.get(sessionId) ?? new Set();
    // One reason for every turn this stop ends, so the person is told once.
    const stop = new Error(reason);
    for (const controller of mine) {
      controller.abort(stop);
    }
    const onSession = host.abortTurns?.(sessionId, reason) ?? 0;
    if (mine.size === 0 && onSession === 0) {
      return false;
    }
    log(`imessage-photon: ${maskHandle(from)} stopped ${agentId}.`);
    return true;
  };

  const typing = (client, chatGuid, on) => {
    Promise.resolve()
      .then(() => client.chats?.setTyping?.(chatGuid, on))
      .catch((error) => log(`imessage-photon: could not ${on ? 'show' : 'clear'} the typing indicator: ${error.message}`));
  };

  // Everything up to gateway.dispatch runs synchronously, so messages reach
  // the gateway in the order intake hands them over.
  const answer = async (gateway, agentId, entry, message) => {
    const { agent } = entry;
    const lineEntry = entry.lines.get(message.line);
    const approval = answerApproval(agentId, agent, message);
    if (approval) {
      await approval;
      return 'settled';
    }
    if (stopRequest(agentId, agent, message)) {
      return 'settled';
    }
    const verdict = admit(message, agent);
    if (!verdict.admit) {
      log(`imessage-photon: ${agentId} refused a message from ${maskHandle(message.from)}: ${verdict.reason}.`);
      return 'settled';
    }
    if (typeof message.chatGuid === 'string' && lineEntry) {
      entry.chats.set(verdict.from, { line: message.line, chatGuid: message.chatGuid });
    }
    const sessionId = sessionIdFor(agentId, verdict.from);
    const idempotencyKey = idempotencyKeyFor(agentId, message.guid);
    const metadata = {
      channel: CHANNEL,
      photonTo: verdict.from,
      senderTrust: verdict.senderTrust,
      conversation: { kind: 'direct', ...(verdict.principal ? { with: verdict.from } : {}) },
    };
    let repeat;
    let absorbed = false;
    let session;
    let failure;
    const controller = new AbortController();
    const mine = turns.get(sessionId) ?? new Set();
    mine.add(controller);
    turns.set(sessionId, mine);
    if (lineEntry) {
      typing(lineEntry.client, message.chatGuid, true);
    }
    try {
      session = await gateway.dispatch({
        sessionId,
        agentId,
        userMessage: userMessageFor(message),
        metadata,
        turnId: randomUUID(),
        signal: controller.signal,
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
    } finally {
      mine.delete(controller);
      if (mine.size === 0 && turns.get(sessionId) === mine) {
        turns.delete(sessionId);
      }
      if (lineEntry) {
        typing(lineEntry.client, message.chatGuid, false);
      }
    }
    const replyTo = async (text) => {
      if (!lineEntry) {
        await deliverTo(agentId, verdict.from, text, { key: idempotencyKey });
        return;
      }
      await sendPieces(agentId, lineEntry.client, message.chatGuid, text, { key: idempotencyKey });
    };
    if (controller.signal.aborted) {
      const stop = controller.signal.reason;
      if (!toldStopped.has(stop)) {
        toldStopped.add(stop);
        await tell(agentId, verdict.from, 'Stopped.');
      }
      return 'settled';
    }
    if (repeat === 'live' || absorbed) {
      // Another delivery of this message, or the turn it was merged into,
      // posts the answer.
      return 'settled';
    }
    let reply;
    let outcome = 'settled';
    if (session) {
      const failed = turnFailureFor(session, idempotencyKey);
      reply = failed !== undefined
        ? `Something went wrong and I couldn't finish that: ${failed}`
        : repeat === 'finished' ? turnReplyFor(session, idempotencyKey) : latestTurnReply(session);
    } else if (failure?.name === 'GatewayStoppingError') {
      // Read again at the next start, and answered then.
      outcome = 'kept';
      reply = failure.restarting === true
        ? "I'm restarting. I'll answer this when I'm back."
        : "I'm shutting down. I'll answer this when I'm running again.";
    } else {
      // Told, not retried: the same refusal would come back each time.
      warn(`imessage-photon: ${agentId} could not start a turn: ${failure instanceof Error ? failure.message : String(failure)}`);
      reply = `I couldn't start on that: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
    if (reply === undefined || reply.trim().length === 0) {
      return outcome;
    }
    if (piecesOf(reply, outcome !== 'kept').length === 0) {
      // Only formatting, like a lone ---: nothing to text, so answered by
      // saying nothing, as an empty reply is.
      log(`imessage-photon: ${agentId}'s answer was empty once formatted for iMessage; nothing sent.`);
      return outcome;
    }
    try {
      if (outcome === 'kept') {
        // A note, not the answer: no idempotency key, so the real answer
        // after the restart isn't taken for a repeat of it.
        if (lineEntry) {
          await sendPieces(agentId, lineEntry.client, message.chatGuid, reply, { markdown: false });
        } else {
          await deliverTo(agentId, verdict.from, reply, { markdown: false });
        }
      } else {
        await replyTo(reply);
      }
    } catch (error) {
      // The turn's reply is in the session; the next start reads this
      // message again and the gateway hands back the finished turn.
      warn(`imessage-photon: ${agentId} could not send its answer; it will be sent after the next start: ${error.message}`);
      return 'kept';
    }
    return outcome;
  };

  const positionFor = (agentId, record, lineKey) => ({
    get: () => record.lines[lineKey],
    set: (value) => {
      record.lines[lineKey] = value;
      store.save(agentId, record);
    },
  });

  /**
   * Brings one agent onto its Photon lines: asks Photon which lines the
   * project has, then reads each. Photon being unreachable at start is
   * retried with backoff; a refused project id or secret is said once and
   * retried slowly, so fixing it with `stratus channel set` needs no more
   * than a restart.
   */
  const startAgent = async (gateway, agentId, agent) => {
    let record;
    try {
      record = store.load(agentId) ?? { lines: {} };
    } catch (error) {
      warn(`imessage-photon: ${agentId} is not on iMessage: ${error.message}. Remove ${store.file(agentId)} to start reading from now on; texts sent since it was last written won't be answered.`);
      return;
    }
    let auth;
    try {
      auth = createPhotonAuth({ projectId: secrets[agentId]?.projectId, projectSecret: secrets[agentId]?.projectSecret, ...(fetch ? { fetch } : {}) });
    } catch (error) {
      warn(`imessage-photon: ${agentId} is not on iMessage: ${error.message}`);
      return;
    }
    let lines;
    for (let attempt = 0; !stopping(); attempt += 1) {
      try {
        lines = await auth.lines();
        break;
      } catch (error) {
        const delay = startRetryMs[Math.min(attempt, startRetryMs.length - 1)];
        (attempt === 0 ? warn : log)(`imessage-photon: ${agentId} could not reach its Photon project: ${error.message} Trying again in ${Math.round(delay / 1000)}s.`);
        await sleepFor(delay, stopController.signal);
      }
    }
    if (stopping() || !lines) {
      return;
    }
    if (lines.length === 0) {
      warn(`imessage-photon: ${agentId}'s Photon project has no iMessage line yet. Add one at app.photon.codes, then restart the daemon.`);
      return;
    }
    const entry = { agent, lines: new Map(), chats: new Map() };
    running.set(agentId, entry);
    for (const line of lines) {
      let client;
      try {
        client = await connect({ address: line.address, token: () => auth.token(line.key) });
      } catch (error) {
        warn(`imessage-photon: ${agentId} could not open line ${line.key}: ${error.message}`);
        continue;
      }
      const label = `${agentId} line ${line.shared ? 'shared' : maskHandle(line.phone)}`;
      const intake = createLineIntake({
        client,
        line,
        label,
        position: positionFor(agentId, record, line.key),
        handle: (message) => answer(gateway, agentId, entry, message),
        log,
        warn,
        now,
        replayCapMs: agent.replayCapMs,
        ...(retryMs ? { retryMs } : {}),
      });
      entry.lines.set(line.key, { line, client, intake });
      void intake.start();
      log(`imessage-photon: ${agentId} is on iMessage through Photon, ${line.shared ? 'on a shared-pool line' : `on ${maskHandle(line.phone)}`}.`);
    }
  };

  return {
    name: CHANNEL,
    async start(gateway) {
      host = gateway;
      unsubscribe = gateway.bus.subscribe((event) => {
        if (event?.type === 'tool.approval-requested') {
          void askApproval(event).catch((error) => warn(`imessage-photon: could not ask for approval: ${error.message}`));
        } else if (event?.type === 'tool.approval-resolved') {
          void settleApproval(event).catch((error) => warn(`imessage-photon: could not report an approval: ${error.message}`));
        }
      });
      store = createCursorStore({ directory: stateDirectory });
      // In the background: Photon being slow to answer must not hold the
      // daemon's start.
      for (const [agentId, agent] of config.agents) {
        const started = startAgent(gateway, agentId, agent)
          .catch((error) => warn(`imessage-photon: ${agentId} could not start: ${error.message}`))
          .finally(() => starting.delete(started));
        starting.add(started);
      }
    },
    async stop() {
      stopController.abort();
      await Promise.allSettled([...starting]);
      // Intake first, so nothing new starts; the bus last, so a request
      // the shutdown settles is still reported.
      const entries = [...running.values()];
      await Promise.allSettled(entries.flatMap((entry) => [...entry.lines.values()].map(({ intake }) => intake.stop())));
      unsubscribe?.();
      unsubscribe = undefined;
      await Promise.allSettled(entries.flatMap((entry) => [...entry.lines.values()].map(({ client }) => client.close?.())));
      running.clear();
    },
    async resolveOutbound({ agentId, to }) {
      const entry = running.get(agentId);
      if (!entry) {
        throw new Error(`${agentId} is not on iMessage here.`);
      }
      const handle = normalizeHandle(to);
      if (handle === null) {
        throw new Error(`${JSON.stringify(to)} is not an iMessage handle: use an Apple ID email or a phone number like +15551234567.`);
      }
      if (!entry.agent.principals.has(handle) && !entry.agent.approvers.has(handle)) {
        throw new Error(`${agentId} only texts people listed as its principals or approvers in the imessage-photon plugin config, and ${maskHandle(handle)} isn't one.`);
      }
      return {
        post: async (text) => {
          await deliverTo(agentId, handle, text);
          return { channel: handle, ts: String(now()) };
        },
      };
    },
    /** For doctor and tests: where each agent's lines stand. */
    status: () => Object.fromEntries([...running].map(([agentId, entry]) => [
      agentId,
      [...entry.lines.values()].map(({ intake }) => intake.status()),
    ])),
  };
};
