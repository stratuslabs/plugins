import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { messageText } from './body.js';

/**
 * Reading ~/Library/Messages/chat.db, the store Messages.app keeps for the
 * Apple ID signed in on this macOS login.
 *
 * Opened read-only: the channel never writes to Messages' database. Only
 * the columns the channel needs are read, and every row is joined to its
 * sender's handle and its chat in one query, so a scan is one indexed
 * range read on the primary key.
 */

export const MESSAGES_DB = path.join(homedir(), 'Library', 'Messages', 'chat.db');

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/**
 * A chat.db date as a Date. Since macOS 10.13 dates are nanoseconds since
 * 2001-01-01; before that they were seconds. Anything above 1e12 cannot be
 * seconds (that is year 33,000), so the two never overlap.
 */
export const appleDate = (value) => {
  const n = typeof value === 'bigint' ? value
    : typeof value === 'string' && /^-?[0-9]+$/.test(value) ? BigInt(value)
      : BigInt(Math.trunc(Number(value ?? 0)));
  const ms = n > 1_000_000_000_000n ? Number(n / 1_000_000n) : Number(n) * 1000;
  return new Date(APPLE_EPOCH_MS + ms);
};

const ROWS_AFTER = `
SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
       m.service AS service, CAST(m.date AS TEXT) AS date, m.is_from_me AS isFromMe, m.item_type AS itemType,
       m.associated_message_type AS associatedType, m.cache_has_attachments AS hasAttachments,
       m.destination_caller_id AS account,
       h.id AS handle,
       c.guid AS chatGuid, c.chat_identifier AS chatIdentifier, c.style AS chatStyle,
       (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) AS attachments
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat c ON c.ROWID = (SELECT MIN(cmj.chat_id) FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID)
WHERE m.ROWID > ?
ORDER BY m.ROWID
LIMIT ?`;

export const openChatDb = (file = MESSAGES_DB, { Database = DatabaseSync } = {}) => {
  const db = new Database(file, { readOnly: true });
  db.exec('PRAGMA query_only = 1;');
  // Dates are nanoseconds, past 2^53, so the query reads them as text.
  const rowsAfter = db.prepare(ROWS_AFTER);
  const maxRowid = db.prepare('SELECT MAX(ROWID) AS max FROM message');
  const guidAt = db.prepare('SELECT guid FROM message WHERE ROWID = ?');
  return {
    file,
    raw: db,
    /** Which file this is: the device and inode of chat.db, as strings. */
    identity: () => {
      const stat = statSync(file, { bigint: true });
      return { dev: String(stat.dev), ino: String(stat.ino) };
    },
    /** The highest ROWID in `message`, 0 when the table is empty. */
    maxRowid: () => Number(maxRowid.get()?.max ?? 0),
    /** The guid of the row at `rowid`, or undefined when there is none. */
    guidAt: (rowid) => guidAt.get(rowid)?.guid,
    /** Up to `limit` rows with ROWID above `rowid`, in ROWID order. */
    rowsAfter: (rowid, limit = 100) => rowsAfter.all(rowid, limit),
    close: () => db.close(),
  };
};

/**
 * What one row is, for the channel:
 *
 * - `message`: received, with something in it. Carries what admission,
 *   sessions and the agent need.
 * - `skip`, with a reason: never a turn, but the watermark moves past it.
 *   `sent` is anything the account itself sent, from this Mac or another
 *   device on the Apple ID, the agent's own replies included; dispatching
 *   those would have the agent answer itself. `reaction` is a tapback or
 *   its removal (associated_message_type 2000s and 3000s, and stickers in
 *   the 1000s). `group-event` is a membership or rename row (item_type is
 *   not 0). `empty` has no text and no attachment.
 * - `poison`: something about the row itself stops it being read, the
 *   same every time. The caller skips it after a bounded number of tries.
 *
 * A link a person sends is a message: Messages marks it with the URL
 * preview balloon, but the row holds what they typed.
 */
export const classifyRow = (row) => {
  if (Number(row.isFromMe) === 1) {
    return { kind: 'skip', reason: 'sent', rowid: row.rowid, guid: row.guid };
  }
  if (Number(row.associatedType ?? 0) !== 0) {
    return { kind: 'skip', reason: 'reaction', rowid: row.rowid, guid: row.guid };
  }
  if (Number(row.itemType ?? 0) !== 0) {
    return { kind: 'skip', reason: 'group-event', rowid: row.rowid, guid: row.guid };
  }
  let text;
  try {
    text = messageText(row);
  } catch (error) {
    return { kind: 'poison', reason: error.message, rowid: row.rowid, guid: row.guid };
  }
  const attachments = Number(row.attachments ?? 0);
  if (text.trim().length === 0 && attachments === 0) {
    return { kind: 'skip', reason: 'empty', rowid: row.rowid, guid: row.guid };
  }
  if (typeof row.handle !== 'string' || row.handle.length === 0) {
    return { kind: 'poison', reason: 'a received row with no sender handle', rowid: row.rowid, guid: row.guid };
  }
  return {
    kind: 'message',
    rowid: row.rowid,
    guid: row.guid,
    from: row.handle,
    service: SERVICES.has(row.service) ? row.service : 'unknown',
    chat: {
      guid: row.chatGuid ?? null,
      identifier: row.chatIdentifier ?? row.handle,
      group: Number(row.chatStyle) === 43,
    },
    account: row.account ?? null,
    text,
    date: appleDate(row.date),
    attachments,
  };
};

const SERVICES = new Set(['iMessage', 'SMS', 'RCS']);
