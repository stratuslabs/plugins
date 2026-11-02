import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isMemoryPassSessionId } from '@stratusagent/core';

import { nightIn } from './window.js';

/**
 * When to ask core for a memory pass (spec 962). Core owns the transcript,
 * the model run, the store and every rule; this decides only when to ask,
 * from bus events and fleet metadata, and never sees a message or a fact.
 *
 * The due list lives in memory only. A restart loses nothing: the sweep in
 * the first drain puts back every session of an enrolled agent updated in
 * the last 7 days, and core answers `nothing-new` for one already saved
 * through its end, without a model call. What tidy has spent tonight is
 * kept in the plugin's state directory, so a restart inside the window
 * does not start the night's cap over.
 */

const MINUTE = 60_000;

/** Delay before retry N after a failure; the last one repeats. */
export const FAILURE_DELAYS_MINUTES = [5, 10, 20, 40, 60];
/** Failures in a row before a session leaves the list until its next turn. */
export const MAX_FAILURES = 6;
/** For an answer that changes on its own soon: a host still loading, another pass running. */
export const RETRY_SOON_MS = MINUTE;
export const SWEEP_DAYS = 7;
/** Rows the restart sweep first reads per agent, newest first; doubled until it reaches past the 7 days. */
export const SWEEP_PAGE = 500;
/** Where tidy's nightly accounting lives in the state directory. */
export const TIDY_STATE_FILE = 'tidy.json';
/** Rows read to find the agent of a session whose creation this plugin missed. */
export const LOOKUP_LIMIT = 50;
/** Sessions whose agent is remembered; the oldest is dropped past this. */
export const KNOWN_SESSIONS_MAX = 10_000;
export const TICK_MS = 30_000;

/** Refusals that hold until the config changes, which takes a restart. */
const SETTLED_REFUSALS = new Set(['conversation-kind', 'unattended', 'sub-agent', 'store-unsupported', 'no-session']);
/** Refusals that lift on their own. */
const SOON_REFUSALS = new Set(['not-started', 'pass-running']);

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

export const createUpkeep = ({
  agents,
  passes,
  fleet,
  bus,
  stateDirectory,
  log = () => {},
  warn = () => {},
  now = Date.now,
  tickMs = TICK_MS,
}) => {
  /** sessionId -> { agentId, dueAt, floor, failures, version } */
  const due = new Map();
  /** sessionId -> agentId, from session.created, the sweep and fleet lookups. */
  const known = new Map();
  /** Sessions whose floor rose during the turn still running. */
  const floored = new Set();
  /** Agents whose start the host accepted. */
  const started = new Set();
  /** agentId -> { night, groups, finished }: tonight's tidy so far. */
  const tidyNights = new Map();
  /** agentId -> not before this, for a tidy the host refused for now. */
  const tidyNotBefore = new Map();
  const tidyStoreWarned = new Set();
  const abort = new AbortController();
  let swept = false;
  let stopped = false;
  let draining;
  let timer;
  let unsubscribe;

  const remember = (sessionId, agentId) => {
    known.delete(sessionId);
    known.set(sessionId, agentId);
    if (known.size > KNOWN_SESSIONS_MAX) {
      known.delete(known.keys().next().value);
    }
  };

  const quietMs = (agentId) => agents.get(agentId).save.quietMinutes * MINUTE;

  /** A turn on this session ended at `at`. */
  const join = (sessionId, agentId, at, floor) => {
    if (!started.has(agentId)) {
      return;
    }
    const existing = due.get(sessionId);
    const dueAt = floor ? at : at + quietMs(agentId);
    due.set(sessionId, {
      agentId,
      // A session still backing off keeps its retry time when that is later.
      dueAt: existing !== undefined && existing.failures > 0 ? Math.max(dueAt, existing.dueAt) : dueAt,
      floor: floor || (existing?.floor ?? false),
      failures: existing?.failures ?? 0,
      version: (existing?.version ?? 0) + 1,
    });
  };

  const lookUp = async (sessionId) => {
    const rows = await fleet.sessions({ limit: LOOKUP_LIMIT });
    const row = rows.find((candidate) => candidate.id === sessionId);
    if (row !== undefined) {
      remember(row.id, row.agentId);
    }
    return row?.agentId;
  };

  const turnEnded = (sessionId) => {
    const at = now();
    const floor = floored.delete(sessionId);
    const queue = (agentId) => {
      if (agentId !== undefined && agents.has(agentId) && !stopped) {
        join(sessionId, agentId, at, floor);
        kick();
      }
    };
    const agentId = known.get(sessionId);
    if (agentId !== undefined) {
      // In the same tick as the event, so a pass already out for this
      // session sees that a turn ended behind it.
      queue(agentId);
      return;
    }
    lookUp(sessionId).then(queue, (error) => {
      warn(`memory-upkeep: could not tell whose session ${sessionId} is, so it is not queued: ${messageOf(error)}`);
    });
  };

  // Handlers return at once: the bus awaits each one in turn, so a fleet
  // read here would hold up every subscriber after this one.
  const onEvent = (event) => {
    if (stopped || typeof event.sessionId !== 'string' || isMemoryPassSessionId(event.sessionId)) {
      return;
    }
    switch (event.type) {
      case 'session.created':
      case 'session.observed':
        remember(event.sessionId, event.agentId);
        return;
      case 'session.context-trimmed':
        floored.add(event.sessionId);
        return;
      case 'session.completed':
      case 'session.failed':
        turnEnded(event.sessionId);
        return;
      default:
    }
  };

  const sweep = async () => {
    const since = now() - SWEEP_DAYS * 24 * 60 * MINUTE;
    for (const agentId of started) {
      // Newest first: read more until the oldest row is past the 7 days.
      let rows;
      for (let limit = SWEEP_PAGE; ; limit *= 2) {
        rows = await fleet.sessions({ agentId, limit });
        const oldest = Date.parse(rows.at(-1)?.updatedAt ?? '');
        if (rows.length < limit || !(oldest >= since)) {
          break;
        }
      }
      for (const row of rows) {
        const updatedAt = Date.parse(row.updatedAt);
        if (!Number.isFinite(updatedAt) || updatedAt < since || isMemoryPassSessionId(row.id) || due.has(row.id)) {
          continue;
        }
        remember(row.id, agentId);
        due.set(row.id, { agentId, dueAt: updatedAt + quietMs(agentId), floor: false, failures: 0, version: 1 });
      }
    }
    swept = true;
  };

  const nextSave = (at) => {
    let next;
    for (const [sessionId, entry] of due) {
      if (entry.dueAt <= at && (next === undefined || entry.dueAt < next.entry.dueAt)) {
        next = { sessionId, entry };
      }
    }
    return next;
  };

  const nextTidy = (at) => {
    for (const agentId of started) {
      const tidy = agents.get(agentId).tidy;
      if (tidy === undefined || (tidyNotBefore.get(agentId) ?? 0) > at) {
        continue;
      }
      const night = nightIn(tidy.window, tidy.timeZone, new Date(at));
      if (night === undefined) {
        continue;
      }
      const tonight = tidyNights.get(agentId);
      if (tonight?.night !== night || (!tonight.finished && tonight.groups < tidy.maxGroupsPerNight)) {
        return { agentId, night };
      }
    }
    return undefined;
  };

  const optional = (settings) => ({
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    mode: settings.mode,
    signal: abort.signal,
  });

  const runSave = async ({ sessionId, entry }) => {
    const { agentId, version } = entry;
    const settings = agents.get(agentId);
    let result;
    try {
      result = await passes.run({
        kind: 'save',
        agentId,
        sessionId,
        reason: entry.floor ? 'floor' : 'quiet',
        ...(settings.save.from !== undefined ? { from: settings.save.from } : {}),
        scheduled: settings.save.scheduled,
        ...optional(settings),
      });
    } catch (error) {
      // Core rejects only a malformed request. Asking again would ask the same.
      due.delete(sessionId);
      warn(`memory-upkeep: core refused the save pass request for ${agentId} session ${sessionId}, so it is dropped until its next turn: ${messageOf(error)}`);
      return;
    }
    if (stopped) {
      return;
    }
    const current = due.get(sessionId);
    if (current === undefined) {
      return;
    }
    const at = now();
    // A turn that ended while the pass ran put new messages behind it.
    const turnedSince = current.version !== version;
    const { status, reason, more } = result;
    if (status === 'done' || status === 'nothing-new') {
      current.failures = 0;
      if (!turnedSince) {
        current.floor = false;
      }
      if (status === 'done' && more) {
        current.dueAt = at;
      } else if (!turnedSince) {
        due.delete(sessionId);
      }
      return;
    }
    if (status === 'skipped') {
      if (reason === 'stopped') {
        stop();
      } else if (reason === 'turn-running') {
        // Due when that turn ends, which queues it again; this covers a turn whose end never comes.
        current.dueAt = Math.max(current.dueAt, at + quietMs(agentId));
      } else if (SOON_REFUSALS.has(reason)) {
        current.dueAt = at + RETRY_SOON_MS;
      } else if (SETTLED_REFUSALS.has(reason) || !turnedSince) {
        due.delete(sessionId);
      }
      return;
    }
    if (status === 'interrupted') {
      // Only a daemon stop interrupts a pass, and the restart sweep picks it
      // up. Not asked again at once, in case this host is still running.
      current.dueAt = at + RETRY_SOON_MS;
      return;
    }
    // failed
    current.failures += 1;
    if (current.failures >= MAX_FAILURES) {
      due.delete(sessionId);
      warn(`memory-upkeep: save passes for ${agentId} session ${sessionId} failed ${current.failures} times in a row (last: ${reason ?? 'unknown'}); it waits for its next turn. See stratus memory passes ${agentId}.`);
      return;
    }
    const delay = FAILURE_DELAYS_MINUTES[Math.min(current.failures, FAILURE_DELAYS_MINUTES.length) - 1] * MINUTE;
    current.dueAt = Math.max(current.dueAt, at + delay);
  };

  const tidyStatePath = () => (stateDirectory === undefined ? undefined : path.join(stateDirectory.prepare(), TIDY_STATE_FILE));

  const loadTidyNights = () => {
    let file;
    try {
      file = tidyStatePath();
      if (file === undefined) {
        log('memory-upkeep: this host gives plugins no state directory, so a restart inside the tidy window starts the night\'s cap over.');
        return;
      }
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const [agentId, tonight] of Object.entries(saved?.agents ?? {})) {
        if (typeof tonight?.night === 'string' && Number.isInteger(tonight.groups)) {
          tidyNights.set(agentId, { night: tonight.night, groups: tonight.groups, finished: tonight.finished === true });
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(`memory-upkeep: could not read ${file ?? 'the tidy state'}, so tonight's tidy cap starts over: ${messageOf(error)}`);
      }
    }
  };

  const saveTidyNights = () => {
    let file;
    try {
      file = tidyStatePath();
      if (file === undefined) {
        return;
      }
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, agents: Object.fromEntries(tidyNights) })}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      warn(`memory-upkeep: could not save ${file ?? 'the tidy state'}; a restart tonight may tidy past the cap: ${messageOf(error)}`);
    }
  };

  const runTidy = async ({ agentId, night }) => {
    const settings = agents.get(agentId);
    const previous = tidyNights.get(agentId);
    const tonight = previous?.night === night ? previous : { night, groups: 0, finished: false };
    tidyNights.set(agentId, tonight);
    const finish = () => {
      tonight.finished = true;
      saveTidyNights();
    };
    while (tonight.groups < settings.tidy.maxGroupsPerNight) {
      let result;
      try {
        result = await passes.run({ kind: 'tidy', agentId, ...optional(settings) });
      } catch (error) {
        warn(`memory-upkeep: core refused the tidy pass request for ${agentId}: ${messageOf(error)}`);
        finish();
        return;
      }
      if (result.status === 'skipped') {
        if (result.reason === 'stopped') {
          stop();
          return;
        }
        if (SOON_REFUSALS.has(result.reason)) {
          tidyNotBefore.set(agentId, now() + RETRY_SOON_MS);
          return;
        }
        if (result.reason === 'store-unsupported' && !tidyStoreWarned.has(agentId)) {
          tidyStoreWarned.add(agentId);
          warn(`memory-upkeep: ${agentId}'s memory store does not take list-valued supersedes, so tidy passes cannot merge facts there. Save passes still run.`);
        }
        finish();
        return;
      }
      if (result.status === 'nothing-new') {
        finish();
        return;
      }
      // It ran (done, failed or cut off), so it counts against tonight's cap.
      tonight.groups += 1;
      saveTidyNights();
      if (stopped) {
        return;
      }
      if (result.status === 'interrupted') {
        tidyNotBefore.set(agentId, now() + RETRY_SOON_MS);
        return;
      }
      if (result.status !== 'done' || !result.more) {
        // Nothing more waits, or it failed: a failed night is tried the next night.
        finish();
        return;
      }
    }
    finish();
  };

  const drain = async () => {
    if (!swept) {
      try {
        await sweep();
      } catch (error) {
        warn(`memory-upkeep: could not list recent sessions to pick up after a restart; trying again shortly: ${messageOf(error)}`);
      }
    }
    while (!stopped) {
      const at = now();
      const save = nextSave(at);
      if (save !== undefined) {
        await runSave(save);
        continue;
      }
      const tidy = nextTidy(at);
      if (tidy !== undefined) {
        await runTidy(tidy);
        continue;
      }
      break;
    }
  };

  /** Runs everything due now, one pass at a time. Resolves when nothing more is due. */
  const runDue = () => {
    if (stopped) {
      return Promise.resolve();
    }
    if (draining === undefined) {
      draining = (async () => {
        // Never settles in the caller's tick, so `draining` is set before
        // the finally clears it, in the same tick as the last due check.
        await null;
        try {
          await drain();
        } finally {
          draining = undefined;
        }
      })();
    }
    return draining;
  };

  function kick() {
    runDue().catch((error) => warn(`memory-upkeep: ${messageOf(error)}`));
  }

  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    abort.abort();
    unsubscribe?.();
    if (timer !== undefined) {
      clearInterval(timer);
    }
  }

  return {
    /** Starts every enrolled agent, then listens. Call from `setup`. */
    async start() {
      loadTidyNights();
      const results = await Promise.allSettled([...agents].map(([agentId, settings]) => passes.start(agentId, settings.mode)));
      [...agents.keys()].forEach((agentId, index) => {
        const result = results[index];
        if (result.status === 'fulfilled') {
          started.add(agentId);
        } else {
          warn(`memory-upkeep: memory passes could not start for ${agentId}, so its conversations are not saved: ${messageOf(result.reason)}`);
        }
      });
      if (started.size > 0) {
        log(`memory-upkeep: memory passes on for ${[...started].map((id) => `${id} (${agents.get(id).mode})`).join(', ')}`);
      }
      unsubscribe = bus.subscribe(onEvent);
      if (tickMs > 0) {
        timer = setInterval(kick, tickMs);
        timer.unref?.();
      }
    },
    drain: runDue,
    stop,
  };
};
