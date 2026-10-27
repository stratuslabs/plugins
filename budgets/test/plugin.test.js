import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { EventBus, HostRefusalError } from '@stratusagent/core';

import { createPlugin } from '../index.js';
import { UsageLedger } from '../ledger.js';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'budgets-plugin-'));

/** The seams the daemon hands a plugin, over a temp directory. */
const host = async (config, { directory = fresh(), omit = [], prepare = () => directory } = {}) => {
  const bus = new EventBus();
  const guards = [];
  const context = {
    bus,
    tools: undefined,
    providerCalls: { register: (guard) => guards.push(guard) },
    stateDirectory: { prepare },
    log: () => {},
    warn: () => {},
  };
  for (const key of omit) delete context[key];
  const plugin = await createPlugin(config);
  await plugin.setup(context);
  const ask = (agentId, sessionId = `s-${agentId}`) => guards[0]({ agentId, sessionId, provider: 'anthropic' });
  const spent = (agentId, sessionId, tokens, id = undefined) => bus.emit({
    type: 'session.usage',
    sessionId,
    agentId,
    records: [{ turnId: 't', provider: 'anthropic', model: 'm', inputTokens: tokens, ...(id ? { id, at: new Date().toISOString() } : {}) }],
  });
  return { plugin, bus, guards, ask, spent, directory };
};

/** True when the call went ahead, false when the budget refused it. */
const allowed = (promise) => promise.then(() => true, (error) => {
  if (!(error instanceof HostRefusalError)) throw error;
  return false;
});

const refused = async (promise, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HostRefusalError, `a deliberate refusal, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
};

describe('budgets plugin', () => {
  for (const seam of ['providerCalls', 'stateDirectory']) {
    it(`fails its setup naming ${seam} when the host has none, rather than loading a limit nothing enforces`, async () => {
      await assert.rejects(host({ daily: 5 }, { omit: [seam] }), new RegExp(seam));
    });
  }

  it('refuses a bad config when it is created, before it can load', async () => {
    await assert.rejects(async () => createPlugin({ daily: 0 }), /daily/);
  });

  it('allows calls under the limit and refuses the one after the limit is reached, with a sentence for the person', async () => {
    const { guards, ask, spent } = await host({ daily: 100, reservePerCall: 0 });
    assert.equal(guards.length, 1);
    await ask('ava');
    await spent('ava', 's-ava', 60, 'r1');
    await ask('ava');
    await spent('ava', 's-ava', 40, 'r2');
    await refused(ask('ava'), /^Agent ava has used its daily model budget \(100 of 100 weighted tokens\)/);
    await ask('bob');
  });

  it('counts one call once when its usage is announced twice', async () => {
    const { ask, spent } = await host({ daily: 100, reservePerCall: 0 });
    await spent('ava', 's', 60, 'same');
    await spent('ava', 's', 60, 'same');
    await ask('ava');
  });

  it('holds a reserve while a call is in flight, so concurrent calls cannot all slip under the limit', async () => {
    const { ask } = await host({ home: { daily: 600 }, reservePerCall: 600 });
    await ask('ava', 's1');
    await refused(ask('bob', 's2'), /^This Stratus install has used its daily model budget \(600 of 600/);
  });

  it('lets exactly one of two processes through when both check the last of a limit at once', async () => {
    // Process B makes its whole check at each point inside A's, the way the
    // daemon and a `stratus run` can interleave on one ledger.
    const config = { home: { daily: 600 }, reservePerCall: 600 };
    for (let point = 1; point <= 5; point += 1) {
      const directory = fresh();
      const b = await host(config, { directory });
      let calls = 0;
      let bAllowed;
      const a = await host(config, {
        directory,
        prepare: () => {
          calls += 1;
          if (calls === point && bAllowed === undefined) bAllowed = allowed(b.ask('bob', 's-b'));
          return directory;
        },
      });
      calls = 0;
      const aAllowed = await allowed(a.ask('ava', 's-a'));
      bAllowed = await (bAllowed ?? allowed(b.ask('bob', 's-b')));
      assert.equal([aAllowed, bAllowed].filter(Boolean).length, 1, `B checking at A's directory read ${point}: A ${aAllowed}, B ${bAllowed}`);
      const after = new UsageLedger({ directory: () => directory });
      after.refresh();
      assert.equal(after.spend({ since: '1970-01-01T00:00:00.000Z', reservePerCall: 600 }), 600, `only the call that went ahead holds a reserve (point ${point})`);
    }
  });

  it('goes ahead when another process\'s reserve lands just after its own, because that process sees this one first', async () => {
    const directory = fresh();
    const other = new UsageLedger({ directory: () => directory });
    const lines = () => readdirSync(directory).flatMap((file) => readFileSync(path.join(directory, file), 'utf8').trim().split('\n')).filter(Boolean).map((line) => JSON.parse(line));
    let theirs;
    const a = await host({ home: { daily: 600 }, reservePerCall: 600 }, {
      directory,
      prepare: () => {
        // The other process checked before our reserve, and its reserve
        // lands as soon as ours is in the file.
        if (theirs === undefined && lines().some((line) => line.type === 'reserve' && line.agentId === 'ava')) {
          theirs = other.reserve({ agentId: 'bob', sessionId: 's-b', provider: 'anthropic' });
        }
        return directory;
      },
    });
    await a.ask('ava', 's-a');
    assert.ok(theirs, 'the other reserve was written');
    assert.deepEqual(lines().filter((line) => line.type === 'reserve').map((line) => line.agentId), ['ava', 'bob']);
  });

  it('settles the reserve with the call\'s usage, a stopped or parked turn, or the session\'s next call', async () => {
    // Any reserve left open other than the asker's own reaches this limit.
    const { ask, spent, bus } = await host({ home: { daily: 600 }, reservePerCall: 600 });
    await ask('ava', 's1');
    await spent('ava', 's1', 10, 'u1');
    await ask('bob', 's2');
    await bus.emit({ type: 'session.failed', sessionId: 's2', agentId: 'bob', error: 'boom' });
    await ask('ava', 's3');
    await ask('ava', 's3');
    await bus.emit({ type: 'session.completed', sessionId: 's3', agentId: 'ava', output: '' });
    await ask('cal', 's4');
    await bus.emit({ type: 'session.updated', sessionId: 's4', status: 'running' });
    await refused(ask('dee', 's5'), /610 of 600/);
    await bus.emit({ type: 'session.updated', sessionId: 's4', status: 'pending_approval' });
    await ask('dee', 's5');
  });

  it('charges a reserve a crashed process left open, so a restart cannot spend it again', async () => {
    const directory = fresh();
    const dead = new UsageLedger({ directory: () => directory });
    dead.reserve({ agentId: 'ava', sessionId: 's-old', provider: 'anthropic' });
    const { ask, spent } = await host({ daily: 1000, reservePerCall: 600 }, { directory });
    await spent('ava', 's-new', 400, 'u');
    await refused(ask('ava', 's-new'), /1,000 of 1,000/);
  });

  it('records usage for every agent even with no limit, and never refuses then', async () => {
    const { ask, spent, directory } = await host({});
    await spent('ava', 's', 10_000_000, 'u');
    await ask('ava');
    const ledger = new UsageLedger({ directory: () => directory });
    ledger.refresh();
    assert.equal(ledger.spend({ since: '1970-01-01T00:00:00.000Z' }), 10_000_000);
  });

  it('refuses a covered agent\'s call when the ledger cannot be written, and not an uncovered one', { skip: process.getuid?.() === 0 }, async () => {
    const directory = fresh();
    const { ask } = await host({ agents: { ava: { daily: 100 } } }, { directory });
    chmodSync(directory, 0o500);
    try {
      await assert.rejects(ask('ava'), (error) => !(error instanceof HostRefusalError) && /could not write/.test(error.message));
      await ask('bob');
    } finally {
      chmodSync(directory, 0o700);
    }
    await ask('ava');
  });

  it('keeps usage it could not write, refuses a covered call until it is written, then writes it first', { skip: process.getuid?.() === 0 }, async () => {
    const directory = fresh();
    const { ask, spent } = await host({ daily: 100, reservePerCall: 0 }, { directory });
    await ask('ava');
    const [file] = readdirSync(directory);
    chmodSync(path.join(directory, file), 0o400);
    try {
      await spent('ava', 's-ava', 30, 'u1');
      await assert.rejects(ask('ava', 's-other'), /could not write/);
    } finally {
      chmodSync(path.join(directory, file), 0o600);
    }
    await ask('ava', 's-other');
    const onDisk = new UsageLedger({ directory: () => directory });
    onDisk.refresh();
    assert.equal(onDisk.spend({ since: '1970-01-01T00:00:00.000Z' }), 30, 'the guard wrote the kept usage before allowing the call');
    await spent('ava', 's-ava', 70, 'u2');
    await refused(ask('ava'), /100 of 100/);
  });

  it('stops listening when disposed', async () => {
    const { plugin, bus, directory } = await host({});
    await plugin.dispose();
    await bus.emit({ type: 'session.usage', sessionId: 's', agentId: 'ava', records: [{ turnId: 't', provider: 'p', inputTokens: 5, id: 'x' }] });
    const ledger = new UsageLedger({ directory: () => directory });
    ledger.refresh();
    assert.equal(ledger.spend({ since: '1970-01-01T00:00:00.000Z' }), 0);
  });
});
