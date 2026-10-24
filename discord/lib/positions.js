import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Where each agent has read up to in each Discord conversation it works
 * in, kept across restarts so a message sent while the daemon was down is
 * answered once it is back.
 *
 * A conversation is the channel a message lands in: a DM, a guild
 * channel's top level, or a thread. It is tracked from the first message
 * the agent admits there. Its position is the newest message that needs
 * nothing more: everything up to it was answered, or was never this
 * agent's to answer. A message being answered holds the position below it
 * until its answer is out, so a restart in the middle of one finds it
 * again. A repeat of a finished turn is the gateway's to tell apart: it
 * posts that turn's reply from the session rather than running it twice.
 *
 * Stored as `positions.json` under the plugin's state directory, written
 * whole through a rename so a crash leaves the old file or the new one.
 */

const SNOWFLAKE = /^[0-9]{17,20}$/;
/** Conversations remembered per agent; the least recently moved go first. */
export const CONVERSATION_LIMIT = 500;
const WRITE_DELAY_MS = 500;

const valid = (entry) => entry && SNOWFLAKE.test(entry.last ?? '')
  && (entry.guildId === undefined || SNOWFLAKE.test(entry.guildId))
  && (entry.parentId === undefined || SNOWFLAKE.test(entry.parentId));

const max = (a, b) => (a === undefined || BigInt(b) > BigInt(a) ? b : a);

export const createPositions = ({ stateDirectory, warn = () => {}, writeDelayMs = WRITE_DELAY_MS } = {}) => {
  // agentId -> Map(conversationId -> { seen, guildId?, parentId?, open: Set(messageId) })
  const agents = new Map();
  let timer;
  let dirty = false;

  const fileIn = (directory) => path.join(directory, 'positions.json');

  const load = () => {
    if (!stateDirectory) {
      return;
    }
    let text;
    try {
      text = readFileSync(fileIn(stateDirectory.prepare()), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(`discord: could not read where each conversation was read up to (${error.message}); messages sent while the daemon was down won't be answered this time.`);
      }
      return;
    }
    let stored;
    try {
      stored = JSON.parse(text);
    } catch {
      warn('discord: positions.json is not JSON; starting without it, so messages sent while the daemon was down won\'t be answered this time.');
      return;
    }
    for (const [agentId, conversations] of Object.entries(stored?.agents ?? {})) {
      const map = new Map();
      for (const [conversation, entry] of Object.entries(conversations ?? {})) {
        if (SNOWFLAKE.test(conversation) && valid(entry)) {
          map.set(conversation, {
            seen: entry.last,
            ...(entry.guildId ? { guildId: entry.guildId } : {}),
            ...(entry.parentId ? { parentId: entry.parentId } : {}),
            open: new Set(),
          });
        }
      }
      agents.set(agentId, map);
    }
  };

  /** The position as stored: just below the oldest message still being answered. */
  const lastOf = (entry) => {
    if (entry.open.size === 0) {
      return entry.seen;
    }
    let oldest;
    for (const id of entry.open) {
      oldest = oldest === undefined || BigInt(id) < BigInt(oldest) ? id : oldest;
    }
    const below = String(BigInt(oldest) - 1n);
    return BigInt(below) < BigInt(entry.seen) ? below : entry.seen;
  };

  const snapshot = () => {
    const out = {};
    for (const [agentId, map] of agents) {
      out[agentId] = {};
      for (const [conversation, entry] of map) {
        out[agentId][conversation] = {
          last: lastOf(entry),
          ...(entry.guildId ? { guildId: entry.guildId } : {}),
          ...(entry.parentId ? { parentId: entry.parentId } : {}),
        };
      }
    }
    return { version: 1, agents: out };
  };

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty || !stateDirectory) {
      return;
    }
    dirty = false;
    try {
      const file = fileIn(stateDirectory.prepare());
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(snapshot())}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      dirty = true;
      warn(`discord: could not save where each conversation was read up to (${error.message}).`);
    }
  };

  const changed = () => {
    dirty = true;
    if (timer === undefined) {
      timer = setTimeout(flush, writeDelayMs);
      timer.unref?.();
    }
  };

  const entryFor = (agentId, message, create) => {
    let map = agents.get(agentId);
    let entry = map?.get(message.channelId);
    if (!entry && create) {
      map ??= new Map();
      agents.set(agentId, map);
      entry = {
        seen: message.id,
        ...(message.guildId ? { guildId: message.guildId } : {}),
        ...(message.parentId ? { parentId: message.parentId } : {}),
        open: new Set(),
      };
      if (map.size >= CONVERSATION_LIMIT) {
        map.delete(map.keys().next().value);
      }
    }
    if (entry) {
      // Most recently moved last, so the limit drops the stalest.
      map.delete(message.channelId);
      map.set(message.channelId, entry);
    }
    return entry;
  };

  return {
    load,
    flush,
    /** A message the agent will not answer: moves a tracked conversation past it. */
    passed(agentId, message) {
      const entry = entryFor(agentId, message, false);
      if (entry) {
        entry.seen = max(entry.seen, message.id);
        changed();
      }
    },
    /** A message the agent is answering: tracks its conversation and holds the position below it. */
    begin(agentId, message) {
      const entry = entryFor(agentId, message, true);
      entry.open.add(message.id);
      entry.seen = max(entry.seen, message.id);
      changed();
    },
    /** Its answer is out (or it ended some other way): the position may move past it. */
    end(agentId, message) {
      const entry = agents.get(agentId)?.get(message.channelId);
      if (entry?.open.delete(message.id)) {
        changed();
      }
    },
    /** Every conversation an agent works in, with where to read on from. */
    conversations(agentId) {
      return [...(agents.get(agentId) ?? new Map())].map(([conversation, entry]) => ({
        conversation,
        after: lastOf(entry),
        ...(entry.guildId ? { guildId: entry.guildId } : {}),
        ...(entry.parentId ? { parentId: entry.parentId } : {}),
      }));
    },
    /** Forget a conversation the agent can no longer see. */
    drop(agentId, conversation) {
      if (agents.get(agentId)?.delete(conversation)) {
        changed();
      }
    },
  };
};
