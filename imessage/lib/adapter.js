import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { latestTurnReply, turnFailureFor, turnReplyFor } from '@stratusagent/core';

import { admit, idempotencyKeyFor, sessionIdFor } from './admission.js';
import { readAttachments, textBlocks, unreadNote } from './attachments.js';
import { newCode, outcomeText, parseAnswer, promptText, WRONG_ANSWER_LIMIT } from './approvals.js';
import { MESSAGES_DB, openChatDb } from './chatdb.js';
import { maskHandle, normalizeHandle } from './handles.js';
import { createIntake } from './intake.js';
import { createSender } from './send.js';
import { splitMessages, toPlainText } from './text.js';
import { createWatermarkStore, recoveredRecord, startFrom } from './watermark.js';

const SEND_RETRY_MS = [2000, 10_000, 30_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the person typed, then the text files read for it, then the files named only. */
const userMessageFor = (text, { texts, unread }) => {
  const message = `${text}${textBlocks(texts)}${unreadNote(unread)}`;
  return text.trim().length > 0 ? message : message.replace(/^\s+/, '');
};

const NO_ATTACHMENTS = Object.freeze({ images: [], texts: [], unread: [] });

/**
 * The iMessage channel adapter, local delivery: the agent's own Apple ID
 * in Messages on this Mac. Intake reads chat.db (lib/intake.js); each
 * received message is admitted or refused, dispatched to the gateway with
 * a key that makes a repeat harmless, and answered as plain text once the
 * turn finishes. There is no edit and no typing indicator on this path, so
 * the reply simply arrives.
 *
 * Who can be texted first (`resolveOutbound`, for `message.send` and
 * schedules) is bounded like admission: the agent's principals and
 * approvers, the people the operator listed. A local Apple ID can text
 * anyone, which is why the list is the boundary.
 */
export const createImessageAdapter = ({
  config,
  stateDirectory,
  chatDb = MESSAGES_DB,
  openDb = openChatDb,
  sender = createSender(),
  log = () => {},
  warn = log,
  intervalMs = 3000,
  watch = true,
  sendRetryMs = SEND_RETRY_MS,
  attachments: attachmentOptions = {},
  random,
}) => {
  const running = new Map();
  // requestId -> an approval request put to approvers by text, while it is pending.
  const asks = new Map();
  // sessionId -> the AbortControllers of turns this adapter dispatched there and is waiting on.
  const turns = new Map();
  let host;
  let unsubscribe;
  let stopping = false;
  const stopController = new AbortController();
  // sessionId -> settles once the latest message handed to that session has
  // called gateway.dispatch, or ended without one. A message whose files
  // are still being read holds the ones behind it in its conversation, so
  // the gateway still sees them in the order they were sent.
  const handing = new Map();
  // The stops already answered with "Stopped.".
  const toldStopped = new WeakSet();

  const deliver = async (agentId, to, text, { markdown = true } = {}) => {
    const pieces = splitMessages(markdown ? toPlainText(text) : text);
    for (const piece of pieces) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await sender.sendText(to, piece);
          break;
        } catch (error) {
          if (attempt >= sendRetryMs.length || stopping) {
            throw error;
          }
          warn(`imessage: ${agentId} could not send to ${maskHandle(to)}, retrying: ${error.message}`);
          await sleep(sendRetryMs[attempt]);
        }
      }
    }
  };

  /** Sends without failing the caller: for notes whose loss costs nothing but the note. */
  const tell = async (agentId, to, text) => {
    try {
      await deliver(agentId, to, text, { markdown: false });
    } catch (error) {
      warn(`imessage: ${agentId} could not send a note to ${maskHandle(to)}: ${error.message}`);
    }
  };

  const nameOf = (agentId) => host?.agents?.().find((agent) => agent.id === agentId)?.name ?? agentId;

  /**
   * A gated call from an iMessage conversation: put it to the agent's
   * approvers by text. The person in the conversation is asked when they
   * are an approver; otherwise every approver is. A request from another
   * surface is that surface's to ask, so this neither sends nor denies it.
   */
  const askApproval = async (event) => {
    const origin = event.delegatedFrom;
    const viaOrigin = origin?.metadata?.channel === 'imessage' && running.has(origin.agentId) ? origin : undefined;
    const metadata = (viaOrigin ? origin.metadata : event.metadata) ?? {};
    const scheduled = event.scheduleDestination?.channel?.trim().toLowerCase() === 'imessage' ? event.scheduleDestination : undefined;
    const here = metadata.channel === 'imessage' && typeof metadata.imessageTo === 'string' ? metadata.imessageTo : undefined;
    if (here === undefined && scheduled?.to === undefined) {
      return;
    }
    const askingAgent = viaOrigin?.agentId ?? event.agentId;
    const decline = (why) => {
      warn(`imessage: ${why}; denying ${event.call?.toolName} for ${event.agentId}`);
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
    let delivered = 0;
    for (const to of recipients) {
      try {
        await deliver(askingAgent, to, promptText({
          agentName,
          toolName: ask.toolName,
          risk: event.risk,
          input: event.call?.input,
          origin: event.origin,
          oneShot: ask.oneShot,
          always: event.always,
          code,
          ...(person !== null && person !== to ? { about: maskHandle(person) } : {}),
        }), { markdown: false });
        delivered += 1;
      } catch (error) {
        warn(`imessage: ${askingAgent} could not send an approval request to ${maskHandle(to)}: ${error.message}`);
      }
    }
    if (delivered === 0 && asks.get(event.requestId) === ask) {
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
    log(`imessage: ${agentId} counted a wrong approval answer from ${maskHandle(from ?? message.from)} over ${message.service}.`);
    for (const candidate of pending) {
      candidate.wrong += 1;
      if (candidate.wrong >= WRONG_ANSWER_LIMIT) {
        candidate.spent = true;
        candidate.guessed = true;
        warn(`imessage: ${agentId} denied ${candidate.toolName} after ${WRONG_ANSWER_LIMIT} wrong answers to its approval code.`);
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
    const sessionId = sessionIdFor(agentId, agent.handle, from);
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
    log(`imessage: ${maskHandle(from)} stopped ${agentId}.`);
    return true;
  };

  /** chat.db's attachment rows for a message; on a failed read, as many unnamed files. */
  const attachmentRowsFor = (agentId, message) => {
    try {
      const rows = running.get(agentId)?.db.attachmentsOf(message.rowid);
      if (Array.isArray(rows) && rows.length > 0) {
        return rows;
      }
    } catch (error) {
      warn(`imessage: ${agentId} could not read the attachments of row ${message.rowid}: ${error.message}`);
    }
    return Array.from({ length: message.attachments }, () => ({ filename: null }));
  };

  // Everything up to gateway.dispatch runs synchronously, so messages reach
  // the gateway in the order intake hands them over. The one wait is for a
  // message's files, and later messages in its conversation wait behind it.
  const answer = async (gateway, agentId, agent, message) => {
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
      log(`imessage: ${agentId} refused row ${message.rowid} from ${maskHandle(message.from)}: ${verdict.reason}.`);
      return 'settled';
    }
    const sessionId = sessionIdFor(agentId, agent.handle, verdict.from);
    const idempotencyKey = idempotencyKeyFor(agent.handle, message.guid);
    const metadata = {
      channel: 'imessage',
      team: agent.handle,
      imessageTo: verdict.from,
      senderTrust: verdict.senderTrust,
      conversation: { kind: 'direct', ...(verdict.principal ? { with: verdict.from } : {}) },
    };
    let repeat;
    let absorbed = false;
    let session;
    let failure;
    const controller = new AbortController();
    const running = turns.get(sessionId) ?? new Set();
    running.add(controller);
    turns.set(sessionId, running);
    // Read now, while chat.db is surely open; the files are read after.
    const listed = message.attachments > 0 ? attachmentRowsFor(agentId, message) : [];
    const prior = handing.get(sessionId);
    let handed = () => {};
    if (prior || listed.length > 0) {
      let resolve;
      const mine = new Promise((done) => {
        resolve = done;
      });
      handing.set(sessionId, mine);
      handed = () => {
        resolve();
        if (handing.get(sessionId) === mine) {
          handing.delete(sessionId);
        }
      };
    }
    const waits = prior !== undefined || listed.length > 0;
    let prepared = NO_ATTACHMENTS;
    try {
      // With nothing to wait for, nothing here awaits before dispatch.
      if (prior) {
        await prior;
      }
      if (listed.length > 0) {
        prepared = await readAttachments(listed, {
          ...attachmentOptions,
          signal: AbortSignal.any([controller.signal, stopController.signal]),
          warn,
          label: `row ${message.rowid}`,
        });
      }
      if (waits && (controller.signal.aborted || stopping)) {
        failure = { name: 'NotDispatched' };
      } else {
        const dispatching = gateway.dispatch({
          sessionId,
          agentId,
          userMessage: userMessageFor(message.text, prepared),
          ...(prepared.images.length > 0 ? { images: prepared.images } : {}),
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
        handed();
        session = await dispatching;
      }
    } catch (error) {
      failure = error;
    } finally {
      handed();
      running.delete(controller);
      if (running.size === 0 && turns.get(sessionId) === running) {
        turns.delete(sessionId);
      }
    }
    if (controller.signal.aborted) {
      const stop = controller.signal.reason;
      if (!toldStopped.has(stop)) {
        toldStopped.add(stop);
        await tell(agentId, verdict.from, 'Stopped.');
      }
      return 'settled';
    }
    if (failure?.name === 'NotDispatched') {
      // The channel stopped while this message's files were read: read
      // again, and answered, at the next start.
      return 'kept';
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
      // Told, not retried: the same refusal would come back each time and
      // hold every message behind it.
      warn(`imessage: ${agentId} could not start a turn for row ${message.rowid}: ${failure instanceof Error ? failure.message : String(failure)}`);
      reply = `I couldn't start on that: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
    if (reply === undefined || reply.trim().length === 0) {
      return outcome;
    }
    try {
      await deliver(agentId, verdict.from, reply);
    } catch (error) {
      // The turn's reply is in the session; the next start reads this
      // message again and the gateway hands back the finished turn.
      warn(`imessage: ${agentId} could not send its answer to row ${message.rowid}; it will be sent after the next start: ${error.message}`);
      return 'kept';
    }
    return outcome;
  };

  let store;

  /**
   * Opens chat.db for one agent and starts its intake, from where it left
   * off. A chat.db that replaced the one last read is recovered from: what
   * it holds up to the newest message already read is history, and what
   * came after is answered (lib/watermark.js recoveredRecord). Run at start,
   * and again by intake when it finds chat.db replaced while running.
   */
  const startAgent = (gateway, agentId, agent) => {
    let db;
    try {
      db = openDb(chatDb);
    } catch (error) {
      warn(`imessage: ${agentId} is not on iMessage: chat.db could not be opened (${error.message}). Grant Full Disk Access to ${process.execPath} in System Settings > Privacy & Security, then restart the daemon.`);
      return;
    }
    const start = startFrom({ loaded: store.load(agentId), db, handle: agent.handle });
    if (start.action === 'refuse') {
      warn(`imessage: ${agentId} is not on iMessage: ${start.reason}. Remove ${store.file} to start reading from now on; messages sent since it was last written won't be answered.`);
      db.close();
      return;
    }
    let record = start.record;
    if (start.action === 'replaced') {
      record = recoveredRecord(start.record, db);
      if (record === null) {
        warn(`imessage: ${agentId} is not on iMessage: ${start.reason}, and no message was read from the old one to recover from. Remove ${store.file} to start reading the new database from now on.`);
        db.close();
        return;
      }
      try {
        store.save(agentId, record);
      } catch (error) {
        warn(`imessage: ${agentId} is not on iMessage: ${start.reason}, and the recovery could not be saved (${error.message}).`);
        db.close();
        return;
      }
      warn(`imessage: ${agentId} found chat.db replaced (${start.reason}). Reading it from row ${record.watermark}; messages dated up to ${new Date(record.historyThrough).toISOString()}, the newest already read, are treated as history.`);
    }
    if (start.changed) {
      try {
        store.save(agentId, record);
      } catch (error) {
        warn(`imessage: ${agentId} could not save how far it has read (${error.message}).`);
      }
    }
    if (start.action === 'seed') {
      store.save(agentId, record);
      log(`imessage: ${agentId} starts reading Messages from row ${record.watermark}; earlier messages are history.`);
    }
    const intake = createIntake({
      db,
      store,
      agentId,
      record,
      handle: (message) => answer(gateway, agentId, agent, message),
      log,
      warn,
      replayCapMs: agent.replayCapMs,
      onReplaced: () => {
        // Called once what this intake handed over has settled. Its handle
        // may still be on the old file, so the new one is opened afresh. A
        // stop under way closes the handle itself.
        if (stopping || running.get(agentId)?.intake !== intake) {
          return;
        }
        running.delete(agentId);
        db.close();
        startAgent(gateway, agentId, agent);
      },
    });
    running.set(agentId, { db, intake, agent });
    intake.start({ intervalMs, watch });
    if (start.action !== 'replaced') {
      log(`imessage: ${agentId} is on iMessage as ${maskHandle(agent.handle)}, reading ${path.basename(chatDb)}.`);
    }
  };

  return {
    name: 'imessage',
    async start(gateway) {
      host = gateway;
      unsubscribe = gateway.bus.subscribe((event) => {
        if (event?.type === 'tool.approval-requested') {
          void askApproval(event).catch((error) => warn(`imessage: could not ask for approval: ${error.message}`));
        } else if (event?.type === 'tool.approval-resolved') {
          void settleApproval(event).catch((error) => warn(`imessage: could not report an approval: ${error.message}`));
        }
      });
      store = createWatermarkStore({ directory: stateDirectory });
      for (const [agentId, agent] of config.agents) {
        startAgent(gateway, agentId, agent);
      }
    },
    async stop() {
      stopping = true;
      stopController.abort();
      // Intake first, so nothing new starts; the bus last, so a request
      // the shutdown settles is still reported.
      await Promise.all([...running.values()].map(({ intake }) => intake.stop()));
      unsubscribe?.();
      unsubscribe = undefined;
      for (const { db } of running.values()) {
        db.close();
      }
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
        throw new Error(`${agentId} only texts people listed as its principals or approvers in the iMessage plugin config, and ${maskHandle(handle)} isn't one.`);
      }
      return {
        post: async (text) => {
          await deliver(agentId, handle, text);
          return { channel: handle, ts: String(Date.now()) };
        },
      };
    },
    /** For doctor and tests: where each agent's intake stands. */
    status: () => Object.fromEntries([...running].map(([agentId, { intake }]) => [agentId, intake.status()])),
  };
};
