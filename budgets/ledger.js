import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_NAME as PACKAGE_LABEL, foldAgentId, weightedTokens } from './budget.js';

/**
 * The usage ledger: one JSON line per event, one file per UTC month
 * (`usage-2026-10.jsonl`) in the plugin's state directory.
 *
 * Three kinds of line:
 * - `usage`: one provider call's usage, the kernel's `UsageRecord` with the
 *   agent and session it belongs to. Counted once per `id`, so the same call
 *   seen twice is spent once.
 * - `reserve`: written before a call the budget allowed, and charged a fixed
 *   amount until it is settled. A call whose process died before its usage
 *   was announced leaves its reserve open, and the open reserve is what the
 *   call is charged: that is the whole of the crash logic.
 * - `settle`: the reserve's call is over and its usage, if any, is in.
 *
 * Every process that loads the plugin (the daemon, a `stratus run`) appends
 * to the same file and reads what the others wrote before each check, so a
 * limit holds across them. Lines are small single appends, so they arrive
 * whole and in one order every process sees; a line torn by a crash is
 * skipped and reported, and the line appended after it is still read.
 *
 * That order is the lock. A call's reserve is appended before its check is
 * final, and the check counts only what is above it in the file
 * (`refresh({ through })`, `spend({ except })`), so of two processes that
 * check at the same moment the one whose reserve landed first goes ahead.
 */

const LINE_VERSION = 1;
const NEWLINE = 0x0a;

const monthOf = (iso) => iso.slice(0, 7);

/**
 * One line, or what survives of it. A process that dies mid-append leaves a
 * line with no newline, and the next append lands on the end of it. Every
 * line starts `{"v":`, so the whole line after the torn piece is found and
 * kept; only the torn piece is lost.
 */
const parseLine = (line) => {
  try {
    return { value: JSON.parse(line), torn: false };
  } catch {
    const start = line.lastIndexOf('{"v":');
    if (start <= 0) return undefined;
    try {
      return { value: JSON.parse(line.slice(start)), torn: true };
    } catch {
      return undefined;
    }
  }
};

export class UsageLedger {
  /**
   * @param {{ directory: () => string, now?: () => Date, warn?: (line: string) => void, writeSync?: typeof writeSync }} options
   *   `directory` is asked on every read and write, the way the host's
   *   `PluginStateDirectory.prepare()` wants to be. `writeSync` is
   *   `fs.writeSync`; a test passes one that stops short.
   */
  constructor({ directory, now = () => new Date(), warn = () => {}, writeSync: writeBytes = writeSync }) {
    this.directory = directory;
    this.now = now;
    this.warn = warn;
    this.writeBytes = writeBytes;
    this.month = undefined;
    this.reset(monthOf(now().toISOString()));
  }

  reset(month) {
    this.month = month;
    this.offset = 0;
    /** id -> { at, agentKey, usage } */
    this.usage = new Map();
    /** id -> { at, agentKey, open } */
    this.reserves = new Map();
  }

  fileFor(month) {
    return path.join(this.directory(), `usage-${month}.jsonl`);
  }

  /**
   * Read whatever every process has appended to this month's file since the
   * last read. With `through`, stop after that reserve's line and leave the
   * lines after it for the next read: the view is then the ledger as it
   * stood when that reserve landed, which is what decides whether its call
   * may go ahead.
   */
  refresh({ through } = {}) {
    const month = monthOf(this.now().toISOString());
    if (month !== this.month) this.reset(month);
    const file = this.fileFor(month);
    let fd;
    try {
      fd = openSync(file, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    let bytes;
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return;
      bytes = Buffer.alloc(size - this.offset);
      let read = 0;
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, this.offset + read);
        if (n === 0) break;
        read += n;
      }
      bytes = bytes.subarray(0, read);
    } finally {
      closeSync(fd);
    }
    // A last line still being written waits for the next read.
    const end = bytes.lastIndexOf(NEWLINE) + 1;
    let skipped = 0;
    let next = 0;
    while (next < end) {
      const newline = bytes.indexOf(NEWLINE, next);
      const line = bytes.subarray(next, newline).toString('utf8');
      next = newline + 1;
      if (line === '') continue;
      const entry = parseLine(line);
      if (entry === undefined || entry.torn) skipped += 1;
      if (entry !== undefined && !this.apply(entry.value)) skipped += 1;
      if (through !== undefined && entry?.value?.type === 'reserve' && entry.value.id === through) break;
    }
    this.offset += next;
    if (skipped > 0) {
      this.warn(`${PACKAGE_LABEL}: skipped ${skipped} line${skipped === 1 ? '' : 's'} of ${file} that could not be read; a crash mid-write leaves one. Spend on them is not counted.`);
    }
  }

  /** Apply one line to this month's view. False for a line that isn't one. */
  apply(entry) {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string' || typeof entry.at !== 'string') return false;
    if (monthOf(entry.at) !== this.month && entry.type !== 'settle') return true;
    switch (entry.type) {
      case 'usage':
        if (typeof entry.agentId !== 'string') return false;
        if (!this.usage.has(entry.id)) this.usage.set(entry.id, { at: entry.at, agentKey: foldAgentId(entry.agentId), usage: entry });
        return true;
      case 'reserve': {
        if (typeof entry.agentId !== 'string') return false;
        const known = this.reserves.get(entry.id);
        if (!known) this.reserves.set(entry.id, { at: entry.at, agentKey: foldAgentId(entry.agentId), open: true });
        return true;
      }
      case 'settle': {
        const known = this.reserves.get(entry.id);
        if (known) known.open = false;
        // A settle read before its reserve (they're in order in one file, so
        // only across a reset) is remembered so the reserve arrives settled.
        else this.reserves.set(entry.id, { at: entry.at, agentKey: '', open: false });
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Append one whole line, or throw. A full disk or a file size limit can
   * make the write take only part of the line without an error, so a short
   * count throws too. The rest is not written after it: another process's
   * line could land in between. The piece left behind is a torn line, and
   * the next line appended onto it is still read.
   */
  append(month, text) {
    const bytes = Buffer.from(text, 'utf8');
    const fd = openSync(this.fileFor(month), 'a', 0o600);
    try {
      const written = this.writeBytes(fd, bytes);
      if (written !== bytes.length) {
        throw new Error(`wrote ${written} of ${bytes.length} bytes of a ledger line; the disk or a file size limit may be full`);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  write(entry) {
    const line = { v: LINE_VERSION, ...entry };
    const month = monthOf(entry.type === 'settle' ? entry.reserveAt : entry.at);
    delete line.reserveAt;
    this.append(month, `${JSON.stringify(line)}\n`);
    if (month === this.month) this.apply(line);
  }

  /**
   * Weighted spend since `since` (ISO), for one agent or the install: the
   * usage recorded, plus `reservePerCall` for every reserve still open
   * other than `except`, the caller's own.
   */
  spend({ since, agentId, weights = {}, reservePerCall = 0, except }) {
    const agentKey = agentId === undefined ? undefined : foldAgentId(agentId);
    const counts = (row) => row.at >= since && (agentKey === undefined || row.agentKey === agentKey);
    let total = 0;
    for (const row of this.usage.values()) if (counts(row)) total += weightedTokens(row.usage, weights);
    for (const [id, row] of this.reserves) if (row.open && id !== except && counts(row)) total += reservePerCall;
    return total;
  }

  /** Record one call's usage. Throws when the line can't be written. */
  record({ agentId, sessionId, record }) {
    const entry = {
      type: 'usage',
      id: typeof record.id === 'string' ? record.id : randomUUID(),
      at: typeof record.at === 'string' ? record.at : this.now().toISOString(),
      agentId,
      sessionId,
      turnId: record.turnId,
      provider: record.provider,
    };
    if (record.model !== undefined) entry.model = record.model;
    for (const bucket of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      if (typeof record[bucket] === 'number') entry[bucket] = record[bucket];
    }
    this.write(entry);
  }

  /** Reserve a call about to be made; returns its id for `settle`. Throws when it can't be written. */
  reserve({ agentId, sessionId, provider }) {
    const entry = { type: 'reserve', id: randomUUID(), at: this.now().toISOString(), agentId, sessionId, provider };
    this.write(entry);
    return { id: entry.id, at: entry.at };
  }

  /** Close a reserve, in the month file it was made in. */
  settle(reserve) {
    this.write({ type: 'settle', id: reserve.id, at: this.now().toISOString(), reserveAt: reserve.at });
  }
}

