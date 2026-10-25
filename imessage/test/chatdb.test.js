import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { messageText } from '../lib/body.js';
import { appleDate, classifyRow, openChatDb } from '../lib/chatdb.js';
import { BODIES, createChatDb } from './chatdb-fixture.js';

const scratch = (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-chatdb-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const PHONE = '+15551234821';

test('a body only in attributedBody decodes to its exact text', () => {
  for (const { text, blob } of BODIES) {
    assert.equal(messageText({ text: null, attributedBody: blob }), text);
  }
});

test('the text column wins when Messages filled it, and attachment placeholders are dropped', () => {
  assert.equal(messageText({ text: 'plain', attributedBody: BODIES[0].blob }), 'plain');
  assert.equal(messageText({ text: '￼look at this', attributedBody: null }), 'look at this');
  assert.equal(messageText({ text: null, attributedBody: null }), '');
});

test('a body that is not a typedstream throws, so the row can be counted as poison', () => {
  assert.throws(() => messageText({ text: null, attributedBody: Buffer.from('not an archive') }), /attributedBody/);
});

test('appleDate reads nanoseconds and the older seconds form', () => {
  const when = new Date('2026-10-25T09:00:00.000Z');
  const seconds = (when.getTime() - Date.UTC(2001, 0, 1)) / 1000;
  assert.equal(appleDate(BigInt(seconds) * 1_000_000_000n).toISOString(), when.toISOString());
  assert.equal(appleDate(seconds).toISOString(), when.toISOString());
});

test('rowsAfter returns rows above a ROWID in order, joined to their handle and chat', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  const first = fixture.received(PHONE);
  const second = fixture.received('friend@icloud.com', { body: BODIES[1].blob });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });

  const rows = db.rowsAfter(0, 10);
  assert.deepEqual(rows.map((row) => row.rowid), [first.rowid, second.rowid]);
  assert.equal(rows[0].handle, PHONE);
  assert.equal(rows[0].chatGuid, `iMessage;-;${PHONE}`);
  assert.equal(rows[0].chatStyle, 45);
  assert.equal(rows[0].service, 'iMessage');
  assert.deepEqual(db.rowsAfter(first.rowid, 10).map((row) => row.rowid), [second.rowid]);
  assert.deepEqual(db.rowsAfter(0, 1).map((row) => row.rowid), [first.rowid]);
  assert.equal(db.maxRowid(), second.rowid);
  assert.equal(db.guidAt(first.rowid), first.guid);
  assert.equal(db.guidAt(999), undefined);
});

test('an empty database reports 0 as its highest ROWID', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  assert.equal(db.maxRowid(), 0);
  assert.deepEqual(db.rowsAfter(0, 10), []);
});

test('the channel opens chat.db read-only', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  fixture.received(PHONE);
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  assert.throws(() => db.raw.exec('DELETE FROM message'), /readonly|read-only/i);
});

test('identity changes when chat.db is replaced by another file', (t) => {
  const directory = scratch(t);
  const file = path.join(directory, 'chat.db');
  const fixture = createChatDb(file);
  fixture.received(PHONE);
  fixture.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = openChatDb(file);
  const identity = before.identity();
  before.close();
  copyFileSync(file, path.join(directory, 'copy.db'));
  fixture.close();
  renameSync(path.join(directory, 'copy.db'), file);
  const after = openChatDb(file);
  t.after(() => after.close());
  assert.notDeepEqual(after.identity(), identity);
});

test('classifyRow: a received iMessage is a message with its sender, chat, service and text', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  const when = new Date('2026-10-25T08:30:00.000Z');
  const { rowid, guid } = fixture.received(PHONE, { date: when, body: BODIES[3].blob });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const [row] = db.rowsAfter(0, 10);
  assert.deepEqual(classifyRow(row), {
    kind: 'message',
    rowid,
    guid,
    from: PHONE,
    service: 'iMessage',
    chat: { guid: `iMessage;-;${PHONE}`, identifier: PHONE, group: false },
    account: 'ava.agent@icloud.com',
    text: 'line1\nline2',
    date: when,
    attachments: 0,
  });
});

test('classifyRow skips what is not a received message, naming why', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  const original = fixture.received(PHONE);
  fixture.sent(PHONE);
  fixture.received(PHONE, { associatedType: 2001, associatedGuid: `p:0/${original.guid}`, text: 'Loved “hello”', body: null });
  fixture.received(PHONE, { associatedType: 3001, associatedGuid: `p:0/${original.guid}`, text: 'Removed a heart', body: null });
  fixture.received(PHONE, { chat: 'chat123', group: true, itemType: 1, text: null, body: null });
  fixture.received(PHONE, { chat: 'chat123', group: true, itemType: 2, text: null, body: null });
  fixture.received(PHONE, { text: null, body: null });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const kinds = db.rowsAfter(0, 20).map((row) => {
    const result = classifyRow(row);
    return result.kind === 'skip' ? `skip:${result.reason}` : result.kind;
  });
  assert.deepEqual(kinds, ['message', 'skip:sent', 'skip:reaction', 'skip:reaction', 'skip:group-event', 'skip:group-event', 'incomplete']);
});

test('classifyRow keeps a link a person sent, preview balloon and all', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  fixture.received(PHONE, { text: 'https://example.com/a', body: null, balloon: 'com.apple.messages.URLBalloonProvider' });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const [row] = db.rowsAfter(0, 10);
  const result = classifyRow(row);
  assert.equal(result.kind, 'message');
  assert.equal(result.text, 'https://example.com/a');
});

test('classifyRow: an attachment with no text is a message, not incomplete', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  fixture.received(PHONE, { text: '￼', body: null, attachments: 1 });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const result = classifyRow(db.rowsAfter(0, 10)[0]);
  assert.equal(result.kind, 'message');
  assert.equal(result.text, '');
  assert.equal(result.attachments, 1);
});

test('attachmentsOf: a message\'s files, as Messages recorded them, in the order they were added', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  const { rowid } = fixture.received(PHONE, { text: '\ufffc\ufffc', body: null, files: [
    { filename: '~/Library/Messages/Attachments/ab/01/X/IMG_1.HEIC', mimeType: 'image/heic', uti: 'public.heic', transferName: 'IMG_1.HEIC', totalBytes: 1234 },
    { filename: null, mimeType: 'audio/x-caf', transferName: 'Audio Message.caf' },
  ] });
  const other = fixture.received(PHONE, { text: 'plain', body: null });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  assert.deepEqual(db.attachmentsOf(rowid).map(({ filename, mimeType, uti, transferName, totalBytes }) => ({ filename, mimeType, uti, transferName, totalBytes })), [
    { filename: '~/Library/Messages/Attachments/ab/01/X/IMG_1.HEIC', mimeType: 'image/heic', uti: 'public.heic', transferName: 'IMG_1.HEIC', totalBytes: 1234 },
    { filename: null, mimeType: 'audio/x-caf', uti: null, transferName: 'Audio Message.caf', totalBytes: 0 },
  ]);
  assert.deepEqual(db.attachmentsOf(other.rowid), []);
  assert.equal(classifyRow(db.rowsAfter(0, 10)[0]).attachments, 2);
});

test('classifyRow: a group message carries the group chat and its sender', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  fixture.received(PHONE, { chat: 'chat987654', group: true });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const result = classifyRow(db.rowsAfter(0, 10)[0]);
  assert.equal(result.from, PHONE);
  assert.deepEqual(result.chat, { guid: 'iMessage;+;chat987654', identifier: 'chat987654', group: true });
});

test('classifyRow: an SMS keeps its service so admission can refuse it as a principal', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  fixture.received(PHONE, { service: 'SMS' });
  fixture.received(PHONE, { service: null });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const [sms, unknown] = db.rowsAfter(0, 10).map(classifyRow);
  assert.equal(sms.service, 'SMS');
  assert.equal(unknown.service, 'unknown');
});

test('classifyRow: an undecodable body is poison, with the row named', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  const { rowid } = fixture.received(PHONE, { body: Buffer.from('garbage') });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const result = classifyRow(db.rowsAfter(0, 10)[0]);
  assert.equal(result.kind, 'poison');
  assert.equal(result.rowid, rowid);
  assert.match(result.reason, /attributedBody/);
});

test('a message with no chat join still has a conversation: its sender', (t) => {
  const file = path.join(scratch(t), 'chat.db');
  const fixture = createChatDb(file);
  fixture.received(PHONE, { chat: null });
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  const result = classifyRow(db.rowsAfter(0, 10)[0]);
  assert.deepEqual(result.chat, { guid: null, identifier: PHONE, group: false });
});
