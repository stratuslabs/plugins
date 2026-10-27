import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { UsageLedger } from '../ledger.js';

const at = (iso) => () => new Date(iso);
const fresh = () => mkdtempSync(path.join(tmpdir(), 'budgets-ledger-'));
const open = (directory, options = {}) => new UsageLedger({ directory: () => directory, now: at('2026-10-27T03:00:00Z'), ...options });
const call = (id, extra = {}) => ({ id, at: '2026-10-27T02:00:00.000Z', turnId: 't1', provider: 'anthropic', model: 'm', inputTokens: 100, outputTokens: 10, ...extra });
const DAY = '2026-10-27T00:00:00.000Z';
const MONTH = '2026-10-01T00:00:00.000Z';

describe('UsageLedger', () => {
  it('sums weighted spend over a window, for the install or one agent matched folded', () => {
    const ledger = open(fresh());
    ledger.record({ agentId: 'Scout', sessionId: 's1', record: call('a') });
    ledger.record({ agentId: 'ava', sessionId: 's2', record: call('b', { at: '2026-10-26T23:59:00.000Z', cacheReadTokens: 1000 }) });
    const weights = { cacheReadTokens: 0.1 };
    assert.equal(ledger.spend({ since: MONTH, weights }), 320);
    assert.equal(ledger.spend({ since: DAY, weights }), 110);
    assert.equal(ledger.spend({ since: MONTH, agentId: 'scout', weights }), 110);
    assert.equal(ledger.spend({ since: MONTH, agentId: 'AVA', weights }), 210);
  });

  it('counts a call once however many times it is recorded, and a call with no id every time', () => {
    const ledger = open(fresh());
    ledger.record({ agentId: 'ava', sessionId: 's', record: call('a') });
    ledger.record({ agentId: 'ava', sessionId: 's', record: call('a') });
    ledger.record({ agentId: 'ava', sessionId: 's', record: call(undefined) });
    ledger.record({ agentId: 'ava', sessionId: 's', record: call(undefined) });
    assert.equal(ledger.spend({ since: MONTH }), 330);
  });

  it('files a record without a time under now', () => {
    const ledger = open(fresh());
    ledger.record({ agentId: 'ava', sessionId: 's', record: call('a', { at: undefined }) });
    assert.equal(ledger.spend({ since: '2026-10-27T03:00:00.000Z' }), 110);
  });

  it('charges an open reserve until it is settled, and settling twice changes nothing', () => {
    const ledger = open(fresh());
    const id = ledger.reserve({ agentId: 'ava', sessionId: 's', provider: 'anthropic' });
    assert.equal(ledger.spend({ since: DAY, reservePerCall: 500 }), 500);
    assert.equal(ledger.spend({ since: DAY, agentId: 'bob', reservePerCall: 500 }), 0);
    ledger.settle(id);
    ledger.settle(id);
    assert.equal(ledger.spend({ since: DAY, reservePerCall: 500 }), 0);
  });

  it('sees what another process wrote, and a dead process\'s open reserve stays charged', () => {
    const directory = fresh();
    const daemon = open(directory);
    const oneShot = open(directory);
    daemon.refresh();
    oneShot.record({ agentId: 'ava', sessionId: 's9', record: call('x') });
    oneShot.reserve({ agentId: 'ava', sessionId: 's9', provider: 'anthropic' });
    // oneShot dies here: nothing settles its reserve.
    assert.equal(daemon.spend({ since: DAY, reservePerCall: 500 }), 0, 'not before a refresh');
    daemon.refresh();
    assert.equal(daemon.spend({ since: DAY, reservePerCall: 500 }), 610);
    const restarted = open(directory);
    restarted.refresh();
    assert.equal(restarted.spend({ since: DAY, reservePerCall: 500 }), 610);
  });

  it('reads only through a given reserve when asked, leaves later lines for the next read, and can leave one reserve out of spend', () => {
    const directory = fresh();
    const a = open(directory);
    const b = open(directory);
    a.refresh();
    b.refresh();
    const mine = a.reserve({ agentId: 'ava', sessionId: 's1', provider: 'anthropic' });
    const theirs = b.reserve({ agentId: 'bob', sessionId: 's2', provider: 'anthropic' });
    a.refresh({ through: mine.id });
    assert.equal(a.spend({ since: DAY, reservePerCall: 600, except: mine.id }), 0, 'their reserve is after mine in the file');
    assert.equal(a.spend({ since: DAY, reservePerCall: 600 }), 600);
    b.refresh({ through: theirs.id });
    assert.equal(b.spend({ since: DAY, reservePerCall: 600, except: theirs.id }), 600, 'mine is before theirs');
    a.refresh();
    assert.equal(a.spend({ since: DAY, reservePerCall: 600 }), 1200, 'the next read takes the rest');
  });

  it('a settle another process wrote releases the reserve here too', () => {
    const directory = fresh();
    const a = open(directory);
    const b = open(directory);
    const id = b.reserve({ agentId: 'ava', sessionId: 's', provider: 'p' });
    a.refresh();
    assert.equal(a.spend({ since: DAY, reservePerCall: 7 }), 7);
    b.settle(id);
    a.refresh();
    assert.equal(a.spend({ since: DAY, reservePerCall: 7 }), 0);
  });

  it('keeps one file per UTC month, private to the daemon\'s user, and starts each month at zero', () => {
    const directory = fresh();
    const october = open(directory);
    october.record({ agentId: 'ava', sessionId: 's', record: call('a') });
    const november = open(directory, { now: at('2026-11-01T00:00:01Z') });
    november.refresh();
    assert.equal(november.spend({ since: '2026-11-01T00:00:00.000Z' }), 0);
    november.record({ agentId: 'ava', sessionId: 's', record: call('b', { at: '2026-11-01T00:00:01.000Z' }) });
    assert.deepEqual(readdirSync(directory).sort(), ['usage-2026-10.jsonl', 'usage-2026-11.jsonl']);
    assert.equal(statSync(path.join(directory, 'usage-2026-10.jsonl')).mode & 0o777, 0o600);
    assert.equal(november.spend({ since: '2026-11-01T00:00:00.000Z' }), 110);
  });

  it('a month boundary in a running process drops the old month and reads the new one', () => {
    let now = new Date('2026-10-31T23:59:00Z');
    const ledger = open(fresh(), { now: () => now });
    ledger.record({ agentId: 'ava', sessionId: 's', record: call('a', { at: '2026-10-31T23:58:00.000Z' }) });
    now = new Date('2026-11-01T00:01:00Z');
    ledger.refresh();
    assert.equal(ledger.spend({ since: '2026-10-01T00:00:00.000Z' }), 0);
  });

  it('a reserve made last month is settled in last month\'s file', () => {
    const directory = fresh();
    let now = new Date('2026-10-31T23:59:00Z');
    const ledger = open(directory, { now: () => now });
    const id = ledger.reserve({ agentId: 'ava', sessionId: 's', provider: 'p' });
    now = new Date('2026-11-01T00:01:00Z');
    ledger.settle(id);
    const october = readFileSync(path.join(directory, 'usage-2026-10.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(october.map((entry) => entry.type), ['reserve', 'settle']);
  });

  it('skips a torn line a crash left, still reads the line appended onto it, and says so', () => {
    const directory = fresh();
    const file = path.join(directory, 'usage-2026-10.jsonl');
    const whole = JSON.stringify({ v: 1, type: 'usage', id: 'a', at: '2026-10-27T01:00:00.000Z', agentId: 'ava', sessionId: 's', provider: 'p', inputTokens: 5 });
    writeFileSync(file, `${whole}\n{"v":1,"type":"usage","id":"b","inpu`);
    const warnings = [];
    const ledger = open(directory, { warn: (line) => warnings.push(line) });
    ledger.refresh();
    ledger.record({ agentId: 'ava', sessionId: 's', record: call('c') });
    const other = open(directory, { warn: (line) => warnings.push(line) });
    other.refresh();
    assert.equal(other.spend({ since: MONTH }), 115);
    assert.equal(ledger.spend({ since: MONTH }), 115);
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /skipped 1 line of .*usage-2026-10\.jsonl/);
  });

  it('waits for a line still being written instead of reading half of it', () => {
    const directory = fresh();
    const ledger = open(directory);
    ledger.refresh();
    const file = path.join(directory, 'usage-2026-10.jsonl');
    const line = JSON.stringify({ v: 1, type: 'usage', id: 'z', at: '2026-10-27T01:00:00.000Z', agentId: 'ava', sessionId: 's', provider: 'p', inputTokens: 9 });
    appendFileSync(file, line.slice(0, 20));
    ledger.refresh();
    assert.equal(ledger.spend({ since: MONTH }), 0);
    appendFileSync(file, `${line.slice(20)}\n`);
    ledger.refresh();
    assert.equal(ledger.spend({ since: MONTH }), 9);
  });

  it('a write that cannot reach the disk throws, so the caller can refuse', { skip: process.getuid?.() === 0 }, () => {
    const directory = fresh();
    chmodSync(directory, 0o500);
    const ledger = open(directory);
    assert.throws(() => ledger.reserve({ agentId: 'ava', sessionId: 's', provider: 'p' }), /EACCES|permission/i);
    chmodSync(directory, 0o700);
  });
});
