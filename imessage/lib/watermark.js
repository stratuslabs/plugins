import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * How far into chat.db each agent has read, kept across restarts.
 *
 * The watermark is the highest ROWID that was handed to the gateway or
 * deliberately skipped, with every row below it settled too. It belongs
 * to one database: `identity` is the device and inode of chat.db, and
 * `fingerprint` is the guid of the row at the watermark, which catches a
 * database rebuilt or restored in place under the same inode.
 *
 * `settled` lists rows above the watermark that are done while an earlier
 * one is still being answered, so a restart answers only what is not:
 * without it, every message answered behind a long turn would be answered
 * again.
 *
 * `initialized` is stored on its own so a fresh Apple ID with no messages
 * at all keeps a watermark of 0 instead of looking unseeded forever.
 * `observedThrough` is the highest ROWID a live scan has read, written
 * before any row in that batch is dispatched; the replay cap uses it to
 * tell rows a running channel already read from rows that arrived while
 * the daemon was down.
 *
 * `observedDate` is the newest message date read so far (epoch ms, null
 * before any), written with `observedThrough`. When chat.db is replaced it
 * is what the channel recovers from: in the new database, a message dated
 * at or before it is history (`historyThrough`), and reading resumes from
 * the first one dated after it. Messages carry their dates across a
 * restore or a rebuild; ROWIDs don't.
 *
 * A missing record is never read as 0, which would replay the account's
 * whole history as fresh instructions. A record that cannot be read is
 * never replaced by a fresh seed either, which would drop whatever arrived
 * since it was last written: the agent is not carried until the operator
 * removes the file.
 */

const FILE = 'watermarks.json';

const isRowid = (value) => Number.isSafeInteger(value) && value >= 0;
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
const optionalTime = (value) => value === undefined || value === null || isTime(value);
const SETTLED_LIMIT = 10_000;

const validRecord = (record) => record
  && typeof record === 'object'
  && record.initialized === true
  && typeof record.identity?.dev === 'string'
  && typeof record.identity?.ino === 'string'
  && typeof record.handle === 'string'
  && isRowid(record.watermark)
  && isRowid(record.observedThrough)
  && record.observedThrough >= record.watermark
  && (record.fingerprint === null || typeof record.fingerprint === 'string')
  && (record.watermark === 0 || typeof record.fingerprint === 'string')
  && optionalTime(record.observedDate)
  && optionalTime(record.historyThrough)
  && validSettled(record);

/** Rows settled above the watermark: increasing, above it, and already observed. */
const validSettled = (record) => {
  const settled = record.settled ?? [];
  if (!Array.isArray(settled) || settled.length > SETTLED_LIMIT) {
    return false;
  }
  let previous = record.watermark;
  for (const rowid of settled) {
    if (!isRowid(rowid) || rowid <= previous || rowid > record.observedThrough) {
      return false;
    }
    previous = rowid;
  }
  return true;
};

/** Writes `text` to `file` so a crash leaves the old file or the new one, on disk. */
const writeDurably = (file, text) => {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const dir = openSync(directory, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
};

export const createWatermarkStore = ({ directory }) => {
  const file = path.join(directory, FILE);

  const readAll = () => {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { status: 'none', agents: {} };
      }
      return { status: 'unreadable', reason: `${file} could not be read (${error.code ?? error.message})` };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: 'unreadable', reason: `${file} is not JSON` };
    }
    if (parsed?.version !== 1 || typeof parsed.agents !== 'object' || parsed.agents === null) {
      return { status: 'unreadable', reason: `${file} is not a version 1 watermark file` };
    }
    return { status: 'ok', agents: parsed.agents };
  };

  return {
    file,
    /** `{ status: 'none' }`, `{ status: 'ok', record }`, or `{ status: 'unreadable', reason }`. */
    load: (agentId) => {
      const all = readAll();
      if (all.status === 'unreadable') {
        return all;
      }
      const record = all.agents[agentId];
      if (record === undefined) {
        return { status: 'none' };
      }
      if (!validRecord(record)) {
        return { status: 'unreadable', reason: `${file} holds a damaged record for ${agentId}` };
      }
      return { status: 'ok', record };
    },
    /** Stores `record` for `agentId`, durably. Refuses to overwrite a file it cannot read. */
    save: (agentId, record) => {
      if (!validRecord(record)) {
        throw new Error(`refusing to store an invalid watermark for ${agentId}`);
      }
      const all = readAll();
      if (all.status === 'unreadable') {
        throw new Error(all.reason);
      }
      writeDurably(file, `${JSON.stringify({ version: 1, agents: { ...all.agents, [agentId]: record } }, null, 2)}\n`);
    },
  };
};

/** A first record for this database: everything already in it is history. */
export const seedRecord = (db, handle) => {
  const max = db.maxRowid();
  return {
    initialized: true,
    identity: db.identity(),
    handle,
    watermark: max,
    observedThrough: max,
    fingerprint: max === 0 ? null : db.guidAt(max) ?? null,
    settled: [],
    observedDate: db.maxDate(),
  };
};

/**
 * A record for `db`, the database that replaced the one `old` describes,
 * or null when `old` read no dated message to recover from. Everything in
 * `db` dated at or before the newest message `old` read is history; reading
 * starts just before the first row dated after it, so what arrived around
 * the switch is answered and nothing already read is answered again.
 */
export const recoveredRecord = (old, db) => {
  // Never below an earlier recovery's history date: observe only raises it.
  const historyThrough = old.observedDate;
  if (!isTime(historyThrough)) {
    return null;
  }
  const first = db.firstRowidAfter(historyThrough);
  const watermark = first === undefined ? db.maxRowid() : db.lastRowidBefore(first);
  return {
    initialized: true,
    identity: db.identity(),
    handle: old.handle,
    watermark,
    observedThrough: watermark,
    fingerprint: watermark === 0 ? null : db.guidAt(watermark) ?? null,
    settled: [],
    observedDate: historyThrough,
    historyThrough,
  };
};

/**
 * Why `record` no longer describes `db`, or null when it still does. Run
 * before any row above the watermark is read, so an old cursor is never
 * applied to another database's rows.
 */
export const replacementOf = (record, db) => {
  const identity = db.identity();
  if (identity.dev !== record.identity.dev || identity.ino !== record.identity.ino) {
    return 'chat.db is a different file than the one last read';
  }
  if (record.watermark > db.maxRowid()) {
    return 'chat.db has fewer messages than were already read';
  }
  if (record.watermark > 0 && db.guidAt(record.watermark) !== record.fingerprint) {
    return 'the last message read is no longer in chat.db';
  }
  return null;
};

/**
 * Where an agent starts reading:
 *
 * - `seed`: nothing stored, or the agent now sends as another handle. The
 *   record returned starts at the current end of chat.db.
 * - `resume`: the stored record still describes this database.
 * - `replaced`: chat.db was replaced or rebuilt; `reason` says how. What to
 *   replay is decided by the replacement recovery, not here.
 * - `refuse`: the stored record cannot be read; `reason` says why. The
 *   agent is not carried.
 */
export const startFrom = ({ loaded, db, handle }) => {
  if (loaded.status === 'unreadable') {
    return { action: 'refuse', reason: loaded.reason };
  }
  if (loaded.status === 'none' || loaded.record.handle !== handle) {
    return { action: 'seed', record: seedRecord(db, handle) };
  }
  const reason = replacementOf(loaded.record, db);
  if (reason) {
    return { action: 'replaced', reason, record: loaded.record };
  }
  return { action: 'resume', record: loaded.record };
};

/** The record after the row `{ rowid, guid }` is settled; rows must be settled in ROWID order. */
export const advance = (record, { rowid, guid }) => {
  if (!isRowid(rowid) || rowid <= record.watermark) {
    throw new Error(`watermark can only move forward: ${record.watermark} -> ${rowid}`);
  }
  if (typeof guid !== 'string' || guid.length === 0) {
    throw new Error(`row ${rowid} has no guid to fingerprint`);
  }
  return {
    ...record,
    watermark: rowid,
    fingerprint: guid,
    observedThrough: Math.max(record.observedThrough, rowid),
    settled: (record.settled ?? []).filter((settled) => settled > rowid),
  };
};

/** The record with `rowid`, above the watermark, listed as settled. */
export const markSettled = (record, rowid) => {
  const settled = record.settled ?? [];
  if (rowid <= record.watermark || settled.includes(rowid)) {
    return record;
  }
  return { ...record, settled: [...settled, rowid].sort((a, b) => a - b) };
};

/** Whether `rowid` is done: at or below the watermark, or listed as settled. */
export const isSettled = (record, rowid) => rowid <= record.watermark || (record.settled ?? []).includes(rowid);

/** The record after a scan read through `rowid`, the newest of its rows dated `date` (ms), before it dispatches anything. */
export const observe = (record, rowid, date) => {
  const later = isTime(date) && !(isTime(record.observedDate) && record.observedDate >= date);
  if (rowid <= record.observedThrough && !later) {
    return record;
  }
  return {
    ...record,
    observedThrough: Math.max(record.observedThrough, rowid),
    ...(later ? { observedDate: date } : {}),
  };
};
