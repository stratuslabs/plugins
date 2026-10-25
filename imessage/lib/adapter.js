import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { latestTurnReply, turnFailureFor, turnReplyFor } from '@stratusagent/core';

import { admit, idempotencyKeyFor, sessionIdFor } from './admission.js';
import { MESSAGES_DB, openChatDb } from './chatdb.js';
import { maskHandle, normalizeHandle } from './handles.js';
import { createIntake } from './intake.js';
import { createSender } from './send.js';
import { splitMessages, toPlainText } from './text.js';
import { createWatermarkStore, startFrom } from './watermark.js';

const SEND_RETRY_MS = [2000, 10_000, 30_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
}) => {
  const running = new Map();
  let stopping = false;

  const deliver = async (agentId, to, text) => {
    const pieces = splitMessages(toPlainText(text));
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

  const answer = async (gateway, agentId, agent, message) => {
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
    try {
      session = await gateway.dispatch({
        sessionId,
        agentId,
        userMessage: message.text,
        metadata,
        turnId: randomUUID(),
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

  return {
    name: 'imessage',
    async start(gateway) {
      const store = createWatermarkStore({ directory: stateDirectory });
      for (const [agentId, agent] of config.agents) {
        let db;
        try {
          db = openDb(chatDb);
        } catch (error) {
          warn(`imessage: ${agentId} is not on iMessage: chat.db could not be opened (${error.message}). Grant Full Disk Access to ${process.execPath} in System Settings > Privacy & Security, then restart the daemon.`);
          continue;
        }
        const start = startFrom({ loaded: store.load(agentId), db, handle: agent.handle });
        if (start.action === 'refuse') {
          warn(`imessage: ${agentId} is not on iMessage: ${start.reason}. Remove ${store.file} to start reading from now on; messages sent since it was last written won't be answered.`);
          db.close();
          continue;
        }
        if (start.action === 'replaced') {
          warn(`imessage: ${agentId} is not on iMessage: ${start.reason}. Remove ${store.file} to start reading the new database from now on.`);
          db.close();
          continue;
        }
        if (start.action === 'seed') {
          store.save(agentId, start.record);
          log(`imessage: ${agentId} starts reading Messages from row ${start.record.watermark}; earlier messages are history.`);
        }
        const intake = createIntake({
          db,
          store,
          agentId,
          record: start.record,
          handle: (message) => answer(gateway, agentId, agent, message),
          log,
          warn,
          replayCapMs: agent.replayCapMs,
        });
        running.set(agentId, { db, intake, agent });
        intake.start({ intervalMs, watch });
        log(`imessage: ${agentId} is on iMessage as ${maskHandle(agent.handle)}, reading ${path.basename(chatDb)}.`);
      }
    },
    async stop() {
      stopping = true;
      await Promise.all([...running.values()].map(({ intake }) => intake.stop()));
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
