import { watch as watchDirectory } from 'node:fs';
import path from 'node:path';

import { classifyRow } from './chatdb.js';
import { advance, isSettled, markSettled, observe, replacementOf } from './watermark.js';

/**
 * Reads new rows from chat.db for one agent and hands each received
 * message to `handle`, in ROWID order.
 *
 * `handle(message)` resolves `'settled'` once nothing more is owed for the
 * message (answered, refused, or failed and told so) and `'kept'` when it
 * must be read again at the next start (the daemon is stopping). Each call
 * is made in ROWID order, synchronously within one scan, so whatever the
 * handler queues it queues in that order.
 *
 * The watermark moves only through the longest run of settled rows from
 * where it stands: a message still being answered holds it, so a restart
 * in the middle of a turn reads that message again. A repeat is then the
 * gateway's to tell apart by the dispatch's idempotency key. Messages
 * settled behind it are listed in the record and not handed over again.
 *
 * Rows are recorded as observed (`observedThrough`) before any of them is
 * handed over. A row first read more than `replayCapMs` after it was sent
 * is skipped, counted, not answered: after a daemon was off for days, or
 * Apple's push service replayed a backlog. A row a running channel already
 * read is never capped, however long it was held.
 *
 * A row that is poison (its body can't be decoded) or incomplete (nothing
 * in it yet) holds the rows behind it and is read again on each scan, up to
 * `poisonLimit` times; then it is skipped, logged by ROWID with the reason.
 *
 * The periodic scan is the guarantee; a change to chat.db or its WAL only
 * makes delivery sooner. Before each scan the stored record is checked
 * against the file, and a chat.db that was replaced stops intake for this
 * agent rather than reading the new file with the old cursor.
 *
 * The log names rows by ROWID and never carries message text or numbers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const createIntake = ({
  db,
  store,
  agentId,
  record: initial,
  handle,
  log = () => {},
  warn = log,
  now = () => Date.now(),
  replayCapMs = DAY_MS,
  poisonLimit = 5,
  batch = 100,
}) => {
  let record = initial;
  // ROWID of the last row read in this process; rows above it are unread.
  let readThrough = initial.watermark;
  // Rows read in this process and not yet behind the watermark, in ROWID order.
  const open = [];
  const attempts = new Map();
  const inflight = new Set();
  let stalled = null;
  let stopped = null;
  let closing = false;
  let scanning;
  let again = false;
  let timer;
  let watching = false;
  let fileWatcher;
  let dirWatcher;
  let watchWarned = false;

  /** Stores `next`, and only then takes it as the record. Throws when it can't be stored. */
  const persist = (next) => {
    store.save(agentId, next);
    record = next;
  };
  let saveWarned = false;

  const settle = (entry, outcome) => {
    entry.outcome = outcome;
    let next = record;
    while (open.length > 0 && open[0].outcome === 'settled') {
      next = advance(next, open.shift());
    }
    if (outcome === 'settled' && open.includes(entry)) {
      next = markSettled(next, entry.rowid);
    }
    if (next === record) {
      return;
    }
    try {
      persist(next);
      saveWarned = false;
    } catch (error) {
      // Kept in memory and written with the next change that saves. Until
      // then a restart reads these rows again, and the gateway's key keeps
      // each from running twice.
      record = next;
      if (!saveWarned) {
        saveWarned = true;
        warn(`imessage: ${agentId} could not save how far it has read (${error instanceof Error ? error.message : String(error)}); a restart now would read some messages again.`);
      }
    }
  };

  const capped = (message, firstRead) => firstRead && now() - message.date.getTime() > replayCapMs;

  const scanOnce = () => {
    if (closing) {
      return;
    }
    const replaced = replacementOf(record, db);
    if (replaced) {
      stopped = replaced;
      warn(`imessage: ${agentId} stopped reading: ${replaced}. Messages that arrive now are not answered until the channel is set up on this database again.`);
      close();
      return;
    }
    for (;;) {
      const rows = db.rowsAfter(readThrough, batch);
      if (rows.length === 0) {
        return;
      }
      const observedBefore = record.observedThrough;
      persist(observe(record, rows.at(-1).rowid));
      let skippedOld = 0;
      for (const row of rows) {
        const result = classifyRow(row);
        if (result.kind === 'poison' || result.kind === 'incomplete') {
          const count = (attempts.get(row.rowid) ?? 0) + 1;
          attempts.set(row.rowid, count);
          if (count < poisonLimit) {
            stalled = { rowid: row.rowid, reason: result.reason, attempts: count };
            if (skippedOld > 0) {
              log(`imessage: ${agentId} skipped ${skippedOld} message${skippedOld === 1 ? '' : 's'} older than ${Math.round(replayCapMs / 3_600_000)}h when first read.`);
            }
            return;
          }
          warn(`imessage: ${agentId} skipped row ${row.rowid} after ${count} reads: ${result.reason}.`);
          attempts.delete(row.rowid);
          stalled = null;
        }
        const entry = { rowid: row.rowid, guid: row.guid, outcome: undefined };
        open.push(entry);
        readThrough = row.rowid;
        if (result.kind !== 'message' || isSettled(record, row.rowid)) {
          settle(entry, 'settled');
          continue;
        }
        stalled = null;
        if (capped(result, row.rowid > observedBefore)) {
          skippedOld += 1;
          settle(entry, 'settled');
          continue;
        }
        let pending;
        try {
          pending = Promise.resolve(handle(result));
        } catch (error) {
          pending = Promise.reject(error);
        }
        const tracked = pending.then(
          (outcome) => {
            settle(entry, outcome === 'settled' ? 'settled' : 'kept');
          },
          (error) => {
            warn(`imessage: ${agentId} could not hand over row ${row.rowid}, keeping it for the next start: ${error instanceof Error ? error.message : String(error)}`);
            settle(entry, 'kept');
          },
        ).finally(() => inflight.delete(tracked));
        inflight.add(tracked);
      }
      if (skippedOld > 0) {
        log(`imessage: ${agentId} skipped ${skippedOld} message${skippedOld === 1 ? '' : 's'} older than ${Math.round(replayCapMs / 3_600_000)}h when first read.`);
      }
      if (rows.length < batch) {
        return;
      }
    }
  };

  /** One scan; a scan asked for while one runs runs once more after it. */
  const scan = () => {
    if (scanning) {
      again = true;
      return scanning;
    }
    scanning = (async () => {
      // Run after `scanning` is set, so a scan finishing clears it.
      await null;
      try {
        do {
          again = false;
          try {
            scanOnce();
          } catch (error) {
            warn(`imessage: ${agentId} could not read chat.db, trying again on the next scan: ${error instanceof Error ? error.message : String(error)}`);
          }
        } while (again && !closing);
      } finally {
        scanning = undefined;
      }
    })();
    return scanning;
  };

  const close = () => {
    closing = true;
    clearInterval(timer);
    timer = undefined;
    watching = false;
    fileWatcher?.close();
    fileWatcher = undefined;
    dirWatcher?.close();
    dirWatcher = undefined;
  };

  /**
   * Watches the WAL, where Messages' commits land, and falls back to
   * chat.db itself. A file watch is tied to one inode, so it is dropped
   * when the file is renamed or removed; the directory watch and the
   * periodic scan put it back. A directory watch alone is not enough: on
   * macOS it reported no event for a commit to an open WAL in testing.
   */
  const rewatch = () => {
    if (!watching) {
      return;
    }
    if (dirWatcher === undefined) {
      try {
        const base = path.basename(db.file);
        dirWatcher = watchDirectory(path.dirname(db.file), (_event, name) => {
          if (name === null || String(name).startsWith(base)) {
            if (fileWatcher === undefined) {
              rewatch();
            }
            void scan();
          }
        });
        dirWatcher.on('error', () => {
          dirWatcher?.close();
          dirWatcher = undefined;
        });
      } catch {
        dirWatcher = undefined;
      }
    }
    if (fileWatcher !== undefined) {
      return;
    }
    for (const target of [`${db.file}-wal`, db.file]) {
      try {
        const current = watchDirectory(target, (event) => {
          if (event === 'rename') {
            current.close();
            if (fileWatcher === current) {
              fileWatcher = undefined;
            }
            setImmediate(rewatch);
          }
          void scan();
        });
        current.on('error', () => {
          current.close();
          if (fileWatcher === current) {
            fileWatcher = undefined;
          }
        });
        fileWatcher = current;
        watchWarned = false;
        return;
      } catch {
        // Not there right now; try the next, and again on the next scan.
      }
    }
    if (!watchWarned) {
      watchWarned = true;
      warn(`imessage: ${agentId} cannot watch chat.db for changes; new messages are read on each periodic scan.`);
    }
  };

  return {
    scan,
    nudge: () => {
      if (!closing) {
        void scan();
      }
    },
    /** Scans every `intervalMs`, and sooner when chat.db or its WAL changes. */
    start: ({ intervalMs = 3000, watch = true } = {}) => {
      if (closing) {
        return;
      }
      timer = setInterval(() => {
        if (watching && fileWatcher === undefined) {
          rewatch();
        }
        void scan();
      }, intervalMs);
      timer.unref?.();
      if (watch) {
        watching = true;
        rewatch();
      }
      void scan();
    },
    /** Resolves once no scan runs and no handed-over message is unsettled. */
    idle: async () => {
      while (scanning || inflight.size > 0) {
        await scanning;
        await Promise.all([...inflight]);
      }
    },
    /** Closes intake first, then waits for what was handed over. */
    stop: async () => {
      close();
      await scanning;
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
    },
    /** For doctor and logs: where intake stands. */
    status: () => ({
      watermark: record.watermark,
      observedThrough: record.observedThrough,
      inflight: inflight.size,
      stalled,
      stopped,
    }),
  };
};
