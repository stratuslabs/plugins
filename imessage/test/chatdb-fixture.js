import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * A stand-in for ~/Library/Messages/chat.db with the tables and columns the
 * channel reads, named and typed as Messages names them. Rows are written
 * the way Messages writes them: `text` is often NULL on recent macOS and
 * the body is only in `attributedBody`, dates are nanoseconds since
 * 2001-01-01, and a reply the account sends is a row with is_from_me = 1.
 */

const SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, chat_identifier TEXT, service_name TEXT, room_name TEXT, display_name TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB, destination_caller_id TEXT, thread_originator_guid TEXT, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
`;

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
export const appleNanos = (date) => BigInt(date.getTime() - APPLE_EPOCH_MS) * 1_000_000n;

/** attributedBody blobs written by Foundation's NSArchiver on macOS 15.3.1 (make-bodies.swift). */
export const BODIES = [
  { text: 'hello from the phone', blob: readFileSync(new URL('./fixtures/body0.bin', import.meta.url)) },
  { text: 'emoji 👍🏽 and accents é', blob: readFileSync(new URL('./fixtures/body1.bin', import.meta.url)) },
  { text: 'long '.repeat(80), blob: readFileSync(new URL('./fixtures/body2.bin', import.meta.url)) },
  { text: 'line1\nline2', blob: readFileSync(new URL('./fixtures/body3.bin', import.meta.url)) },
];

/** A stand-in chat.db at `file`; `existing` writes into one already there, as Messages does after a swap. */
export const createChatDb = (file, { account = 'E:ava.agent@icloud.com', existing = false } = {}) => {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  if (!existing) {
    db.exec(SCHEMA);
  }
  let guids = 0;
  const nextGuid = () => `FAKE-${String(++guids).padStart(4, '0')}-${Math.random().toString(16).slice(2, 10)}`;

  const handleFor = (id, service) => {
    const found = db.prepare('SELECT ROWID FROM handle WHERE id = ? AND service = ?').get(id, service);
    if (found) {
      return found.ROWID;
    }
    return Number(db.prepare('INSERT INTO handle (id, service) VALUES (?, ?)').run(id, service).lastInsertRowid);
  };

  const chatFor = (identifier, { group = false, service = 'iMessage' } = {}) => {
    const guid = `${service};${group ? '+' : '-'};${identifier}`;
    const found = db.prepare('SELECT ROWID FROM chat WHERE guid = ?').get(guid);
    if (found) {
      return found.ROWID;
    }
    return Number(db.prepare('INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?, ?, ?, ?)')
      .run(guid, group ? 43 : 45, identifier, service).lastInsertRowid);
  };

  /** Inserts one message row and joins it to its chat; returns { rowid, guid }. */
  const insert = ({
    from,
    fromMe = false,
    text = null,
    body = null,
    service = 'iMessage',
    chat = from,
    group = false,
    date = new Date(),
    itemType = 0,
    associatedType = 0,
    associatedGuid = null,
    balloon = null,
    attachments = 0,
    files = [],
    guid = nextGuid(),
  } = {}) => {
    const handleId = from ? handleFor(from, service ?? 'iMessage') : 0;
    const result = db.prepare(`INSERT INTO message (guid, text, handle_id, attributedBody, service, account, date, is_from_me, is_finished, cache_has_attachments, item_type, associated_message_type, associated_message_guid, balloon_bundle_id, destination_caller_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(guid, text, handleId, body, service, account, appleNanos(date), fromMe ? 1 : 0, attachments + files.length > 0 ? 1 : 0, itemType, associatedType, associatedGuid, balloon, account.replace(/^[EP]:/, ''));
    const rowid = Number(result.lastInsertRowid);
    if (chat) {
      const chatId = chatFor(chat, { group, service: service ?? 'iMessage' });
      db.prepare('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)').run(chatId, rowid, appleNanos(date));
    }
    for (let index = 0; index < attachments; index += 1) {
      const attachment = Number(db.prepare('INSERT INTO attachment (guid, filename, mime_type, transfer_name) VALUES (?, ?, ?, ?)')
        .run(`AT-${guid}-${index}`, `~/Library/Messages/Attachments/xx/${index}.jpg`, 'image/jpeg', `${index}.jpg`).lastInsertRowid);
      db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(rowid, attachment);
    }
    // Attachments as Messages records them: { filename, mimeType, uti, transferName, totalBytes }.
    for (const [index, file] of files.entries()) {
      const attachment = Number(db.prepare('INSERT INTO attachment (guid, filename, uti, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`AT-${guid}-f${index}`, file.filename ?? null, file.uti ?? null, file.mimeType ?? null, file.transferName ?? null, file.totalBytes ?? 0).lastInsertRowid);
      db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(rowid, attachment);
    }
    return { rowid, guid };
  };

  return {
    db,
    insert,
    received: (from, fields = {}) => insert({ from, body: BODIES[0].blob, ...fields }),
    sent: (to, fields = {}) => insert({ from: to, fromMe: true, text: 'a reply', ...fields }),
    remove: (rowid) => db.prepare('DELETE FROM message WHERE ROWID = ?').run(rowid),
    close: () => db.close(),
  };
};
