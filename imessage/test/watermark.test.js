import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openChatDb } from '../lib/chatdb.js';
import { advance, createWatermarkStore, observe, recoveredRecord, replacementOf, seedRecord, startFrom } from '../lib/watermark.js';
import { createChatDb } from './chatdb-fixture.js';

const HANDLE = 'ava.agent@icloud.com';
const PHONE = '+15551234821';

const scratch = (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-watermark-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const setup = (t) => {
  const directory = scratch(t);
  const file = path.join(directory, 'chat.db');
  const fixture = createChatDb(file);
  const db = openChatDb(file);
  t.after(() => { db.close(); fixture.close(); });
  return { directory, file, fixture, db, store: createWatermarkStore({ directory: path.join(directory, 'state') }) };
};

test('first start seeds at the end of chat.db, so history is never replayed', (t) => {
  const { fixture, db, store } = setup(t);
  fixture.received(PHONE);
  const last = fixture.received(PHONE);
  const start = startFrom({ loaded: store.load('ava'), db, handle: HANDLE });
  assert.equal(start.action, 'seed');
  assert.equal(start.record.watermark, last.rowid);
  assert.equal(start.record.fingerprint, last.guid);
  assert.equal(start.record.observedThrough, last.rowid);
  assert.equal(start.record.initialized, true);
});

test('an empty database seeds at 0 and stays initialized, so its first message is delivered', (t) => {
  const { fixture, db, store } = setup(t);
  const seeded = startFrom({ loaded: store.load('ava'), db, handle: HANDLE });
  assert.equal(seeded.record.watermark, 0);
  assert.equal(seeded.record.fingerprint, null);
  store.save('ava', seeded.record);

  fixture.received(PHONE);
  const again = startFrom({ loaded: store.load('ava'), db, handle: HANDLE });
  assert.equal(again.action, 'resume');
  assert.equal(again.record.watermark, 0);
  assert.equal(db.rowsAfter(again.record.watermark, 10).length, 1);
});

test('a stored record resumes where it left off', (t) => {
  const { fixture, db, store } = setup(t);
  const first = fixture.received(PHONE);
  store.save('ava', seedRecord(db, HANDLE));
  const later = fixture.received(PHONE);
  const start = startFrom({ loaded: store.load('ava'), db, handle: HANDLE });
  assert.equal(start.action, 'resume');
  assert.equal(start.record.watermark, first.rowid);
  assert.deepEqual(db.rowsAfter(start.record.watermark, 10).map((row) => row.rowid), [later.rowid]);
});

test('a new handle re-seeds: the old cursor belonged to another account', (t) => {
  const { fixture, db, store } = setup(t);
  fixture.received(PHONE);
  store.save('ava', seedRecord(db, HANDLE));
  const last = fixture.received(PHONE);
  const start = startFrom({ loaded: store.load('ava'), db, handle: 'other@icloud.com' });
  assert.equal(start.action, 'seed');
  assert.equal(start.record.watermark, last.rowid);
  assert.equal(start.record.handle, 'other@icloud.com');
});

test('chat.db replaced by another file is detected by its inode', (t) => {
  const { directory, file, fixture, db, store } = setup(t);
  fixture.received(PHONE);
  store.save('ava', seedRecord(db, HANDLE));
  const record = store.load('ava').record;
  fixture.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(file, path.join(directory, 'copy.db'));
  const copy = openChatDb(path.join(directory, 'copy.db'));
  t.after(() => copy.close());
  assert.match(replacementOf(record, copy), /different file/);
});

test('a database behind the watermark is detected', (t) => {
  const { directory, fixture, db, store } = setup(t);
  fixture.received(PHONE);
  fixture.received(PHONE);
  const record = seedRecord(db, HANDLE);
  const otherFile = path.join(directory, 'other.db');
  const other = createChatDb(otherFile);
  other.received(PHONE);
  const otherDb = openChatDb(otherFile);
  t.after(() => { otherDb.close(); other.close(); });
  assert.match(replacementOf({ ...record, identity: otherDb.identity() }, otherDb), /fewer messages/);
});

test('a database rebuilt in place under the same inode is caught by the fingerprint', (t) => {
  const { fixture, db, store } = setup(t);
  const { rowid } = fixture.received(PHONE);
  fixture.received(PHONE);
  const record = { ...seedRecord(db, HANDLE), watermark: rowid, observedThrough: rowid, fingerprint: 'GUID-FROM-THE-OLD-DATABASE' };
  store.save('ava', record);
  const start = startFrom({ loaded: store.load('ava'), db, handle: HANDLE });
  assert.equal(start.action, 'replaced');
  assert.match(start.reason, /no longer in chat.db/);
});

test('a missing row at the watermark counts as a replacement too', (t) => {
  const { fixture, db } = setup(t);
  const { rowid } = fixture.received(PHONE);
  fixture.received(PHONE);
  const record = advance({ ...seedRecord(db, HANDLE), watermark: 0, observedThrough: 0, fingerprint: null }, db.rowsAfter(0, 1)[0]);
  assert.equal(replacementOf(record, db), null);
  fixture.remove(rowid);
  assert.match(replacementOf(record, db), /no longer in chat.db/);
});

test('an unreadable watermark file refuses the agent instead of re-seeding over it', (t) => {
  const { directory, db, store } = setup(t);
  store.save('ava', seedRecord(db, HANDLE));
  writeFileSync(store.file, '{"version":1,"agents":');
  const start = startFrom({ loaded: store.load('ava'), db, handle: HANDLE });
  assert.equal(start.action, 'refuse');
  assert.match(start.reason, /not JSON/);
  assert.throws(() => store.save('ava', seedRecord(db, HANDLE)), /not JSON/);
  assert.equal(readFileSync(store.file, 'utf8'), '{"version":1,"agents":');
  assert.ok(existsSync(path.join(directory, 'state')));
});

test('a damaged record refuses only that agent', (t) => {
  const { db, store } = setup(t);
  store.save('juno', seedRecord(db, HANDLE));
  const all = JSON.parse(readFileSync(store.file, 'utf8'));
  all.agents.ava = { initialized: true, watermark: -1 };
  writeFileSync(store.file, JSON.stringify(all));
  assert.equal(store.load('ava').status, 'unreadable');
  assert.equal(store.load('juno').status, 'ok');
});

test('a record with a watermark above 0 and no fingerprint is damaged', (t) => {
  const { fixture, db, store } = setup(t);
  fixture.received(PHONE);
  assert.throws(() => store.save('ava', { ...seedRecord(db, HANDLE), fingerprint: null }), /invalid watermark/);
});

test('save writes through a rename and leaves no temporary file', (t) => {
  const { db, store } = setup(t);
  store.save('ava', seedRecord(db, HANDLE));
  store.save('juno', seedRecord(db, HANDLE));
  assert.deepEqual(readdirSync(path.dirname(store.file)), ['watermarks.json']);
  assert.equal(store.load('ava').status, 'ok');
  assert.equal(store.load('juno').status, 'ok');
});

test('advance moves forward only, and carries the new fingerprint', (t) => {
  const { fixture, db } = setup(t);
  const record = seedRecord(db, HANDLE);
  const row = fixture.received(PHONE);
  const next = advance(record, row);
  assert.equal(next.watermark, row.rowid);
  assert.equal(next.fingerprint, row.guid);
  assert.throws(() => advance(next, row), /only move forward/);
  assert.throws(() => advance(next, { rowid: row.rowid + 1, guid: '' }), /no guid/);
});

test('observe records rows read before they are dispatched, never moving back', (t) => {
  const { db } = setup(t);
  const record = seedRecord(db, HANDLE);
  assert.equal(observe(record, 7).observedThrough, 7);
  assert.equal(observe(observe(record, 7), 3).observedThrough, 7);
  assert.equal(observe(record, 7).watermark, record.watermark);
});

test('settled rows above the watermark are stored, and a damaged list is refused', (t) => {
  const { fixture, db, store } = setup(t);
  const record = seedRecord(db, HANDLE);
  assert.deepEqual(record.settled, []);
  fixture.received(PHONE);
  const b = fixture.received(PHONE);
  const withSettled = { ...observe(record, b.rowid), settled: [b.rowid] };
  store.save('ava', withSettled);
  assert.deepEqual(store.load('ava').record.settled, [b.rowid]);
  assert.throws(() => store.save('ava', { ...withSettled, settled: [record.watermark] }), /invalid watermark/);
  assert.throws(() => store.save('ava', { ...withSettled, settled: [b.rowid + 1] }), /invalid watermark/);
});

test('advance drops settled rows it moves past', (t) => {
  const { fixture, db } = setup(t);
  const record = seedRecord(db, HANDLE);
  const a = fixture.received(PHONE);
  const b = fixture.received(PHONE);
  const next = advance({ ...observe(record, b.rowid), settled: [a.rowid, b.rowid] }, a);
  assert.deepEqual(next.settled, [b.rowid]);
});

// Recovery when chat.db is replaced (stratuslabs/plugins#23).

const at = (iso) => new Date(iso);

test('a seed and each scan record the newest message date read, which a replacement recovers from', (t) => {
  const { fixture, db } = setup(t);
  fixture.received(PHONE, { date: at('2026-10-20T10:00:00Z') });
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  fixture.received(PHONE, { date: at('2026-10-20T11:00:00Z') });
  const record = seedRecord(db, HANDLE);
  assert.equal(record.observedDate, at('2026-10-20T12:00:00Z').getTime());
  assert.equal(observe(record, record.watermark + 1, at('2026-10-21T00:00:00Z').getTime()).observedDate, at('2026-10-21T00:00:00Z').getTime());
  // Never backwards.
  assert.equal(observe(record, record.watermark + 1, at('2026-10-01T00:00:00Z').getTime()).observedDate, record.observedDate);
});

test('an empty chat.db seeds with no date, and the store keeps such a record', (t) => {
  const { db, store } = setup(t);
  const record = seedRecord(db, HANDLE);
  assert.equal(record.observedDate, null);
  store.save('ava', record);
  assert.equal(store.load('ava').status, 'ok');
});

test('the store refuses a record whose dates are not times', (t) => {
  const { db, store } = setup(t);
  const record = seedRecord(db, HANDLE);
  assert.throws(() => store.save('ava', { ...record, observedDate: '2026-10-20' }), /invalid watermark/);
  assert.throws(() => store.save('ava', { ...record, observedDate: -1 }), /invalid watermark/);
  assert.throws(() => store.save('ava', { ...record, historyThrough: 1.5 }), /invalid watermark/);
  store.save('ava', { ...record, observedDate: 5, historyThrough: 5 });
  assert.equal(store.load('ava').record.historyThrough, 5);
});

test('a record written before dates were kept still loads', (t) => {
  const { db, store } = setup(t);
  const { observedDate, ...old } = seedRecord(db, HANDLE);
  assert.equal(observedDate, null);
  store.save('ava', old);
  assert.equal(store.load('ava').status, 'ok');
});

test('recovery re-anchors on the new database: what it held up to the last date read is history', (t) => {
  const { directory, fixture, db } = setup(t);
  fixture.received(PHONE, { date: at('2026-10-20T10:00:00Z') });
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const old = seedRecord(db, HANDLE);
  // The new database: history first, then what arrived around the switch,
  // with an old row synced in after it, as an iCloud rebuild does.
  const nextFile = path.join(directory, 'next.db');
  const next = createChatDb(nextFile);
  const h1 = next.received(PHONE, { date: at('2026-10-19T09:00:00Z') });
  next.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const fresh = next.received(PHONE, { date: at('2026-10-20T12:05:00Z') });
  next.received(PHONE, { date: at('2026-10-18T08:00:00Z') });
  const nextDb = openChatDb(nextFile);
  t.after(() => { nextDb.close(); next.close(); });
  const recovered = recoveredRecord(old, nextDb);
  assert.deepEqual(recovered.identity, nextDb.identity());
  assert.equal(recovered.handle, HANDLE);
  assert.equal(recovered.historyThrough, old.observedDate);
  assert.equal(recovered.observedDate, old.observedDate);
  // Starts just before the first row dated after the last one read.
  assert.equal(recovered.watermark, fresh.rowid - 1);
  assert.equal(recovered.observedThrough, fresh.rowid - 1);
  assert.equal(recovered.fingerprint, nextDb.guidAt(fresh.rowid - 1));
  assert.deepEqual(recovered.settled, []);
  assert.ok(h1.rowid < recovered.watermark);
  assert.equal(replacementOf(recovered, nextDb), null);
});

test('recovery on a database with nothing new starts at its end', (t) => {
  const { directory, fixture, db } = setup(t);
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const old = seedRecord(db, HANDLE);
  const nextFile = path.join(directory, 'next.db');
  const next = createChatDb(nextFile);
  next.received(PHONE, { date: at('2026-10-19T09:00:00Z') });
  const last = next.received(PHONE, { date: at('2026-10-20T11:00:00Z') });
  const nextDb = openChatDb(nextFile);
  t.after(() => { nextDb.close(); next.close(); });
  const recovered = recoveredRecord(old, nextDb);
  assert.equal(recovered.watermark, last.rowid);
  assert.equal(recovered.fingerprint, last.guid);
});

test('recovery on an empty database starts at 0 and keeps the history date', (t) => {
  const { directory, fixture, db } = setup(t);
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const old = seedRecord(db, HANDLE);
  const nextFile = path.join(directory, 'next.db');
  const next = createChatDb(nextFile);
  const nextDb = openChatDb(nextFile);
  t.after(() => { nextDb.close(); next.close(); });
  const recovered = recoveredRecord(old, nextDb);
  assert.equal(recovered.watermark, 0);
  assert.equal(recovered.fingerprint, null);
  assert.equal(recovered.historyThrough, old.observedDate);
});

test('a record that never read a dated message cannot be recovered from, and says so', (t) => {
  const { directory, db } = setup(t);
  const old = seedRecord(db, HANDLE);
  const nextFile = path.join(directory, 'next.db');
  const next = createChatDb(nextFile);
  next.received(PHONE);
  const nextDb = openChatDb(nextFile);
  t.after(() => { nextDb.close(); next.close(); });
  assert.equal(recoveredRecord(old, nextDb), null);
  const { observedDate, ...older } = old;
  assert.equal(recoveredRecord(older, nextDb), null);
});

test('a second replacement takes the newest date read since the first one', (t) => {
  const { directory, fixture, db } = setup(t);
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const old = { ...seedRecord(db, HANDLE), historyThrough: at('2026-10-20T11:00:00Z').getTime() };
  const nextFile = path.join(directory, 'next.db');
  const next = createChatDb(nextFile);
  next.received(PHONE, { date: at('2026-10-20T13:00:00Z') });
  const nextDb = openChatDb(nextFile);
  t.after(() => { nextDb.close(); next.close(); });
  assert.equal(recoveredRecord(old, nextDb).historyThrough, at('2026-10-20T12:00:00Z').getTime());
});

test('recovery carries what the old database left unsettled, from just before it in the new one', (t) => {
  const { directory, fixture, db } = setup(t);
  fixture.received(PHONE, { date: at('2026-10-20T10:00:00Z') });
  const kept = fixture.received(PHONE, { date: at('2026-10-20T11:00:00Z') });
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const old = { ...seedRecord(db, HANDLE), pending: [kept.guid, 'GONE-FROM-THE-NEW-ONE'], carry: [] };
  const nextFile = path.join(directory, 'next.db');
  const next = createChatDb(nextFile);
  next.received(PHONE, { date: at('2026-10-19T09:00:00Z') });
  const again = next.received(PHONE, { date: at('2026-10-20T11:00:00Z'), guid: kept.guid });
  next.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const fresh = next.received(PHONE, { date: at('2026-10-20T12:05:00Z') });
  const nextDb = openChatDb(nextFile);
  t.after(() => { nextDb.close(); next.close(); });
  const recovered = recoveredRecord(old, nextDb);
  assert.deepEqual(recovered.carry, [kept.guid]);
  assert.equal(recovered.watermark, again.rowid - 1);
  assert.ok(recovered.watermark < fresh.rowid);
  assert.deepEqual(recovered.pending, []);
});

test('a resumed record from before dates were kept gets its date from the rows it already read', (t) => {
  const { fixture, db } = setup(t);
  fixture.received(PHONE, { date: at('2026-10-20T10:00:00Z') });
  const read = fixture.received(PHONE, { date: at('2026-10-20T11:00:00Z') });
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const { observedDate, ...old } = { ...seedRecord(db, HANDLE), watermark: read.rowid, observedThrough: read.rowid, fingerprint: read.guid };
  const start = startFrom({ loaded: { status: 'ok', record: old }, db, handle: HANDLE });
  assert.equal(start.action, 'resume');
  assert.equal(start.record.observedDate, at('2026-10-20T11:00:00Z').getTime());
  assert.equal(start.changed, true);
});

test('a second replacement still carries what the first carried and has not been answered', (t) => {
  const { directory, fixture, db } = setup(t);
  const carried = fixture.received(PHONE, { date: at('2026-10-20T11:00:00Z') });
  fixture.received(PHONE, { date: at('2026-10-20T12:00:00Z') });
  const old = { ...seedRecord(db, HANDLE), historyThrough: at('2026-10-20T12:00:00Z').getTime(), pending: [], carry: [carried.guid] };
  const nextFile = path.join(directory, 'next.db');
  const next = createChatDb(nextFile);
  const again = next.received(PHONE, { date: at('2026-10-20T11:00:00Z'), guid: carried.guid });
  const nextDb = openChatDb(nextFile);
  t.after(() => { nextDb.close(); next.close(); });
  const recovered = recoveredRecord(old, nextDb);
  assert.deepEqual(recovered.carry, [carried.guid]);
  assert.equal(recovered.watermark, again.rowid - 1);
});
