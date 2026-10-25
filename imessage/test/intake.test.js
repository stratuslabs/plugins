import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openChatDb } from '../lib/chatdb.js';
import { createIntake } from '../lib/intake.js';
import { createWatermarkStore, seedRecord } from '../lib/watermark.js';
import { BODIES, createChatDb } from './chatdb-fixture.js';

const HANDLE = 'ava.agent@icloud.com';
const PHONE = '+15551234821';
const DAY = 24 * 60 * 60 * 1000;

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const setup = (t, { seedFirst = true } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-intake-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'chat.db');
  const fixture = createChatDb(file);
  const db = openChatDb(file);
  const store = createWatermarkStore({ directory: path.join(directory, 'state') });
  if (seedFirst) {
    store.save('ava', seedRecord(db, HANDLE));
  }
  const logs = [];
  const intakes = [];
  const make = (handle, options = {}) => {
    const intake = createIntake({
      db,
      store,
      agentId: 'ava',
      record: store.load('ava').record,
      handle,
      log: (line) => logs.push(line),
      warn: (line) => logs.push(`WARN ${line}`),
      ...options,
    });
    intakes.push(intake);
    return intake;
  };
  t.after(async () => {
    for (const intake of intakes) {
      await intake.stop();
    }
    db.close();
    fixture.close();
  });
  return { directory, file, fixture, db, store, logs, make };
};

test('received messages are handed over in ROWID order; sent rows and tapbacks are not', async (t) => {
  const { fixture, store, make } = setup(t);
  const a = fixture.received(PHONE);
  fixture.sent(PHONE);
  fixture.received(PHONE, { associatedType: 2000, associatedGuid: `p:0/${a.guid}`, text: 'Liked', body: null });
  const b = fixture.received('friend@icloud.com', { body: BODIES[1].blob });
  const seen = [];
  const intake = make(async (message) => { seen.push([message.rowid, message.text]); return 'settled'; });
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, [[a.rowid, BODIES[0].text], [b.rowid, BODIES[1].text]]);
  assert.equal(store.load('ava').record.watermark, b.rowid);
  assert.equal(store.load('ava').record.fingerprint, b.guid);
});

test('the watermark stays below a message still being answered, and catches up once it settles', async (t) => {
  const { fixture, store, make } = setup(t);
  const start = store.load('ava').record.watermark;
  const a = fixture.received(PHONE);
  const b = fixture.received('friend@icloud.com');
  const slow = deferred();
  const intake = make(async (message) => (message.rowid === a.rowid ? slow.promise : 'settled'));
  await intake.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.load('ava').record.watermark, start);
  slow.resolve('settled');
  await intake.idle();
  assert.equal(store.load('ava').record.watermark, b.rowid);
});

test('a kept message (daemon stopping) holds the watermark, and the next start reads it again, not what was answered behind it', async (t) => {
  const { fixture, store, make } = setup(t);
  const a = fixture.received(PHONE);
  const b = fixture.received(PHONE);
  const first = make(async (message) => (message.rowid === a.rowid ? 'kept' : 'settled'));
  await first.scan();
  await first.idle();
  await first.stop();
  assert.ok(store.load('ava').record.watermark < a.rowid);

  const seen = [];
  const second = make(async (message) => { seen.push(message.rowid); return 'settled'; });
  await second.scan();
  await second.idle();
  assert.deepEqual(seen, [a.rowid]);
  assert.equal(store.load('ava').record.watermark, b.rowid);
});

test('rows are recorded as observed before any of them is handed over', async (t) => {
  const { fixture, store, make } = setup(t);
  fixture.received(PHONE);
  const last = fixture.received(PHONE);
  const observed = [];
  const intake = make(async () => { observed.push(store.load('ava').record.observedThrough); return 'settled'; });
  await intake.scan();
  await intake.idle();
  assert.deepEqual(observed, [last.rowid, last.rowid]);
});

test('at start, a message no running channel read that is older than the cap is skipped; one it read is not', async (t) => {
  const { fixture, store, logs, make } = setup(t);
  const now = Date.now();
  const read = fixture.received(PHONE, { date: new Date(now - 3 * DAY) });
  // A previous run read `read` (observedThrough) but never settled it.
  const record = store.load('ava').record;
  store.save('ava', { ...record, observedThrough: read.rowid });
  const stale = fixture.received(PHONE, { date: new Date(now - 2 * DAY) });
  const fresh = fixture.received(PHONE, { date: new Date(now - 60_000) });
  const seen = [];
  const intake = make(async (message) => { seen.push(message.rowid); return 'settled'; });
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, [read.rowid, fresh.rowid]);
  assert.equal(store.load('ava').record.watermark, fresh.rowid);
  assert.ok(logs.some((line) => /1 message older than 24h/.test(line)), logs.join('\n'));
  assert.ok(!logs.some((line) => line.includes(String(stale.guid))));
});

test('a poison row holds the rows behind it, then is skipped after the limit, by ROWID', async (t) => {
  const { fixture, store, logs, make } = setup(t);
  const bad = fixture.received(PHONE, { body: Buffer.from('garbage') });
  const good = fixture.received(PHONE);
  const seen = [];
  const intake = make(async (message) => { seen.push(message.rowid); return 'settled'; }, { poisonLimit: 3 });
  await intake.scan();
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, []);
  assert.equal(intake.status().stalled.rowid, bad.rowid);
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, [good.rowid]);
  assert.equal(store.load('ava').record.watermark, good.rowid);
  assert.equal(intake.status().stalled, null);
  assert.ok(logs.some((line) => line.startsWith('WARN') && line.includes(`row ${bad.rowid}`) && /attributedBody/.test(line)), logs.join('\n'));
});

test('an empty row that fills in before the limit is delivered', async (t) => {
  const { fixture, make } = setup(t);
  const row = fixture.received(PHONE, { text: null, body: null });
  const seen = [];
  const intake = make(async (message) => { seen.push(message.text); return 'settled'; });
  await intake.scan();
  fixture.db.prepare('UPDATE message SET attributedBody = ? WHERE ROWID = ?').run(BODIES[2].blob, row.rowid);
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, [BODIES[2].text]);
});

test('a scan asked for while one runs runs once more afterwards, never alongside', async (t) => {
  const { fixture, make } = setup(t);
  fixture.received(PHONE);
  let active = 0;
  let most = 0;
  const seen = [];
  const intake = make(async (message) => {
    active += 1;
    most = Math.max(most, active);
    seen.push(message.rowid);
    active -= 1;
    return 'settled';
  });
  const first = intake.scan();
  const late = fixture.received(PHONE);
  intake.nudge();
  intake.nudge();
  await first;
  await intake.idle();
  assert.ok(seen.includes(late.rowid));
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(most, 1);
});

test('a replaced chat.db stops intake instead of reading the new file with the old cursor', async (t) => {
  const { directory, file, fixture, logs, make } = setup(t);
  fixture.received(PHONE);
  fixture.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(file, path.join(directory, 'copy.db'));
  renameSync(path.join(directory, 'copy.db'), file);
  const seen = [];
  const intake = make(async (message) => { seen.push(message.rowid); return 'settled'; });
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, []);
  assert.match(intake.status().stopped, /different file/);
  assert.ok(logs.some((line) => line.startsWith('WARN') && /different file/.test(line)));
});

test('stop waits for messages being answered and starts nothing after', async (t) => {
  const { fixture, make } = setup(t);
  fixture.received(PHONE);
  const slow = deferred();
  const seen = [];
  const intake = make(async (message) => { seen.push(message.rowid); return slow.promise; });
  await intake.scan();
  let stopped = false;
  const stopping = intake.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  fixture.received(PHONE);
  intake.nudge();
  slow.resolve('settled');
  await stopping;
  await intake.scan();
  assert.equal(seen.length, 1);
});

test('a handler that throws keeps its row for the next start', async (t) => {
  const { fixture, store, logs, make } = setup(t);
  const start = store.load('ava').record.watermark;
  fixture.received(PHONE);
  const intake = make(async () => { throw new Error('boom'); });
  await intake.scan();
  await intake.idle();
  assert.equal(store.load('ava').record.watermark, start);
  assert.ok(logs.some((line) => line.startsWith('WARN') && /boom/.test(line)));
});

test('the log never carries message text or a whole phone number', async (t) => {
  const { fixture, logs, make } = setup(t);
  fixture.received(PHONE, { body: Buffer.from('garbage') });
  fixture.received(PHONE, { date: new Date(Date.now() - 3 * DAY) });
  fixture.received(PHONE);
  const intake = make(async () => 'settled', { poisonLimit: 1 });
  await intake.scan();
  await intake.idle();
  const all = logs.join('\n');
  assert.ok(!all.includes(BODIES[0].text));
  assert.ok(!all.includes(PHONE));
});

test('the periodic scan delivers without any nudge', async (t) => {
  const { fixture, make } = setup(t);
  const seen = deferred();
  const intake = make(async (message) => { seen.resolve(message.rowid); return 'settled'; });
  intake.start({ intervalMs: 20, watch: false });
  const row = fixture.received(PHONE);
  assert.equal(await seen.promise, row.rowid);
});

test('a change to chat.db wakes the scan before the interval would', async (t) => {
  const { fixture, make } = setup(t);
  const seen = deferred();
  const intake = make(async (message) => { seen.resolve(message.rowid); return 'settled'; });
  intake.start({ intervalMs: 60_000, watch: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const row = fixture.received(PHONE);
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000));
  assert.equal(await Promise.race([seen.promise, timeout]), row.rowid);
});

test('a message answered while an earlier one was still running is not answered again after a restart', async (t) => {
  const { fixture, store, make } = setup(t);
  const a = fixture.received(PHONE);
  const b = fixture.received('friend@icloud.com');
  const hung = deferred();
  const first = make(async (message) => (message.rowid === a.rowid ? hung.promise : 'settled'));
  await first.scan();
  await new Promise((resolve) => setImmediate(resolve));
  // The daemon dies here: a is unanswered, b was answered.
  assert.ok(store.load('ava').record.watermark < a.rowid);
  assert.deepEqual(store.load('ava').record.settled, [b.rowid]);

  const seen = [];
  const second = make(async (message) => { seen.push(message.rowid); return 'settled'; });
  await second.scan();
  await second.idle();
  assert.deepEqual(seen, [a.rowid]);
  assert.equal(store.load('ava').record.watermark, b.rowid);
  assert.deepEqual(store.load('ava').record.settled, []);
  // The first process's turn ends as a dead process's would: nothing more written.
  hung.resolve('kept');
});

test('a watermark that cannot be saved warns once, keeps going, and never dispatches unobserved rows', async (t) => {
  const { fixture, store, logs, make } = setup(t);
  const realSave = store.save;
  const seen = [];
  const intake = make(async (message) => { seen.push(message.rowid); return 'settled'; });
  const a = fixture.received(PHONE);
  let failing = 'settle';
  store.save = (agentId, record) => {
    if (failing === 'all' || (failing === 'settle' && record.watermark > 0 && record.observedThrough === record.watermark)) {
      throw new Error('disk full');
    }
    return realSave(agentId, record);
  };
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, [a.rowid]);
  assert.equal(logs.filter((line) => /could not save how far/.test(line)).length, 1);
  // With the observed mark unsaveable too, nothing new is handed over.
  failing = 'all';
  fixture.received(PHONE);
  await intake.scan();
  await intake.idle();
  assert.deepEqual(seen, [a.rowid]);
  failing = 'none';
  await intake.scan();
  await intake.idle();
  assert.equal(seen.length, 2);
  assert.equal(store.load('ava').record.watermark, seen[1]);
});
