import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus, memoryPassSessionId } from '@stratusagent/core';

import { readUpkeepConfig } from '../lib/config.js';
import { createUpkeep, FAILURE_DELAYS_MINUTES, MAX_FAILURES, RETRY_SOON_MS } from '../lib/upkeep.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-11-02T12:00:00.000Z');

const outcome = (status, extra = {}) => ({ passId: 'p', status, saved: 0, superseded: 0, more: false, ...extra });

/**
 * A host for the upkeep: a real bus, a clock the test moves, a memory pass
 * handle that answers from a script, and a fleet reader over fixed rows.
 */
const harness = ({ config = { agents: { atlas: {} } }, sessions = [], answer, startFails = [], fleetFailures = 0 } = {}) => {
  let fleetFailuresLeft = fleetFailures;
  let clock = T0;
  const bus = new EventBus();
  const asked = [];
  const started = [];
  const logs = [];
  const fleetReads = [];
  const passes = {
    async start(agentId, mode) {
      started.push([agentId, mode]);
      if (startFails.includes(agentId)) {
        throw new Error(`memoryPasses.start: there is no agent ${agentId}.`);
      }
      return { startedAt: new Date(clock).toISOString() };
    },
    async run(request) {
      asked.push({ ...request, at: clock });
      return (answer ?? (() => outcome('nothing-new')))(request, asked.length);
    },
  };
  const fleet = {
    async sessions(options = {}) {
      fleetReads.push(options);
      if (fleetFailuresLeft > 0) {
        fleetFailuresLeft -= 1;
        throw new Error('index locked');
      }
      const rows = sessions.filter((row) => options.agentId === undefined || row.agentId === options.agentId);
      return options.limit === undefined ? rows : rows.slice(0, options.limit);
    },
  };
  const upkeep = createUpkeep({
    agents: readUpkeepConfig(config, { defaultTimeZone: 'UTC' }),
    passes,
    fleet,
    bus,
    log: (line) => logs.push(['log', line]),
    warn: (line) => logs.push(['warn', line]),
    now: () => clock,
    tickMs: 0,
  });
  return {
    bus,
    upkeep,
    asked,
    started,
    logs,
    fleetReads,
    advance: async (ms) => {
      clock += ms;
      await upkeep.drain();
    },
    at: () => clock,
    /** A turn that ran on a session and ended. */
    turn: async (sessionId, { agentId = 'atlas', trimmed = false, failed = false, created = true } = {}) => {
      if (created) {
        await bus.emit({ type: 'session.created', sessionId, agentId });
      }
      if (trimmed) {
        await bus.emit({ type: 'session.context-trimmed', sessionId, droppedMessages: 4, floor: 12 });
      }
      await bus.emit(failed ? { type: 'session.failed', sessionId, error: 'boom' } : { type: 'session.completed', sessionId });
      await upkeep.drain();
    },
  };
};

test('start turns upkeep on for each listed agent in its mode, and a start the host refuses leaves that agent out', async () => {
  const h = harness({
    config: { agents: { atlas: { mode: 'write' }, ghost: {} } },
    startFails: ['ghost'],
  });
  await h.upkeep.start();
  assert.deepEqual(h.started, [['atlas', 'write'], ['ghost', 'shadow']]);
  assert.ok(h.logs.some(([kind, line]) => kind === 'warn' && line.includes('ghost') && line.includes('no agent ghost')));

  await h.turn('s-ghost', { agentId: 'ghost' });
  await h.advance(31 * MINUTE);
  assert.deepEqual(h.asked, []);
  h.upkeep.stop();
});

test('a session is asked about quietMinutes after its last turn ends, and a new turn restarts the wait', async () => {
  const h = harness({ config: { model: 'claude-haiku-4-5', agents: { atlas: { save: { from: ['public', 'private'] } } } } });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.advance(29 * MINUTE);
  assert.equal(h.asked.length, 0);

  await h.turn('s-1', { created: false });
  await h.advance(29 * MINUTE);
  assert.equal(h.asked.length, 0, 'the second turn restarted the 30 minutes');

  await h.advance(1 * MINUTE);
  assert.equal(h.asked.length, 1);
  const [request] = h.asked;
  assert.ok(request.signal instanceof AbortSignal);
  delete request.signal;
  assert.deepEqual(request, {
    kind: 'save',
    agentId: 'atlas',
    sessionId: 's-1',
    reason: 'quiet',
    from: ['public', 'private'],
    scheduled: false,
    model: 'claude-haiku-4-5',
    mode: 'shadow',
    at: T0 + 59 * MINUTE,
  });

  // nothing-new: off the list, never asked again without a new turn.
  await h.advance(120 * MINUTE);
  assert.equal(h.asked.length, 1);
  h.upkeep.stop();
});

test('a failed turn counts as a turn ending', async () => {
  const h = harness();
  await h.upkeep.start();
  await h.turn('s-1', { failed: true });
  await h.advance(30 * MINUTE);
  assert.deepEqual(h.asked.map((r) => r.sessionId), ['s-1']);
  h.upkeep.stop();
});

test('a floor that rose during a turn makes the session due as soon as that turn ends, with reason floor', async () => {
  const h = harness();
  await h.upkeep.start();
  await h.turn('s-1', { trimmed: true });
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].reason, 'floor');
  assert.equal(h.asked[0].at, T0);

  // The floor is spent: the next turn waits for quiet again.
  await h.turn('s-1', { created: false });
  assert.equal(h.asked.length, 1);
  await h.advance(30 * MINUTE);
  assert.equal(h.asked.length, 2);
  assert.equal(h.asked[1].reason, 'quiet');
  h.upkeep.stop();
});

test('done with more is asked again at once; done without more leaves the list', async () => {
  const answers = [outcome('done', { saved: 2, more: true }), outcome('done', { saved: 1, more: true }), outcome('done', { saved: 0 })];
  const h = harness({ answer: (_request, n) => answers[n - 1] ?? outcome('nothing-new') });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.advance(30 * MINUTE);
  assert.equal(h.asked.length, 3);
  assert.ok(h.asked.every((r) => r.at === T0 + 30 * MINUTE));
  await h.advance(600 * MINUTE);
  assert.equal(h.asked.length, 3);
  h.upkeep.stop();
});

test('turn-running keeps the session, asked again a quiet wait later or when that turn ends', async () => {
  const h = harness({ answer: (_r, n) => (n === 1 ? outcome('skipped', { reason: 'turn-running' }) : outcome('nothing-new')) });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.advance(30 * MINUTE);
  assert.equal(h.asked.length, 1);
  await h.advance(30 * MINUTE);
  assert.equal(h.asked.length, 2, 'asked again a quiet wait after the refusal');
  h.upkeep.stop();
});

test('not-started from a host that is still loading and pass-running are asked again a minute later, at no cost', async () => {
  const answers = [outcome('skipped', { reason: 'not-started' }), outcome('skipped', { reason: 'pass-running' }), outcome('nothing-new')];
  const h = harness({ answer: (_r, n) => answers[n - 1] });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.advance(30 * MINUTE);
  await h.advance(RETRY_SOON_MS);
  await h.advance(RETRY_SOON_MS);
  assert.deepEqual(h.asked.map((r) => r.at - T0), [30 * MINUTE, 30 * MINUTE + RETRY_SOON_MS, 30 * MINUTE + 2 * RETRY_SOON_MS]);
  h.upkeep.stop();
});

test('a refusal that only a config change can lift takes the session off the list', async () => {
  for (const reason of ['conversation-kind', 'unattended', 'sub-agent', 'store-unsupported', 'no-session']) {
    const h = harness({ answer: () => outcome('skipped', { reason }) });
    await h.upkeep.start();
    await h.turn('s-1');
    await h.advance(30 * MINUTE);
    await h.advance(600 * MINUTE);
    assert.equal(h.asked.length, 1, reason);
    h.upkeep.stop();
  }
});

test('a failing session backs off 5, 10, 20, 40 minutes, then hourly, and leaves after 6 failures in a row until its next turn', async () => {
  assert.deepEqual(FAILURE_DELAYS_MINUTES, [5, 10, 20, 40, 60]);
  assert.equal(MAX_FAILURES, 6);
  const h = harness({ answer: () => outcome('failed', { reason: 'model' }) });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.advance(30 * MINUTE);
  for (const minutes of [5, 10, 20, 40, 60]) {
    await h.advance(minutes * MINUTE - 1);
    const before = h.asked.length;
    await h.advance(1);
    assert.equal(h.asked.length, before + 1, `retried after ${minutes} minutes`);
  }
  assert.equal(h.asked.length, 6);
  assert.ok(h.logs.some(([kind, line]) => kind === 'warn' && line.includes('s-1') && line.includes('6')));
  await h.advance(600 * MINUTE);
  assert.equal(h.asked.length, 6, 'off the list after 6 failures');

  await h.turn('s-1', { created: false });
  await h.advance(30 * MINUTE);
  assert.equal(h.asked.length, 7, 'its next turn puts it back');
  h.upkeep.stop();
});

test('a turn that ends while a pass runs keeps the session on the list, even when the pass found nothing left', async () => {
  let h;
  const answer = async (_request, n) => {
    if (n === 1) {
      // A message arrives and its turn ends while this pass is out.
      await h.bus.emit({ type: 'session.completed', sessionId: 's-1' });
    }
    return outcome('nothing-new');
  };
  h = harness({ answer });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.advance(30 * MINUTE);
  assert.equal(h.asked.length, 1);
  await h.advance(30 * MINUTE);
  assert.equal(h.asked.length, 2);
  h.upkeep.stop();
});

test('a session whose creation was missed is found through the fleet; other agents\' and pass sessions are never asked about', async () => {
  const h = harness({
    sessions: [
      // Older than the restart sweep reaches, so only the lookup can find it.
      { id: 's-old', agentId: 'atlas', status: 'completed', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' },
      { id: 's-blair', agentId: 'blair', status: 'completed', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: new Date(T0).toISOString() },
    ],
  });
  await h.upkeep.start();
  await h.turn('s-old', { created: false });
  await h.turn('s-blair', { created: false });
  await h.turn('s-unknown', { created: false });
  await h.bus.emit({ type: 'session.completed', sessionId: memoryPassSessionId('p-1') });
  await h.advance(30 * MINUTE);
  assert.deepEqual(h.asked.map((r) => r.sessionId), ['s-old']);
  // One lookup each for the three sessions it had not seen created; none for the pass's own.
  assert.equal(h.fleetReads.filter((read) => read.agentId === undefined).length, 3);
  h.upkeep.stop();
});

test('a restart sweep enrolls sessions updated in the last 7 days, each due a quiet wait after its last update', async () => {
  const iso = (ms) => new Date(ms).toISOString();
  const h = harness({
    sessions: [
      { id: 's-new', agentId: 'atlas', status: 'completed', createdAt: iso(T0 - 1000 * MINUTE), updatedAt: iso(T0 - 10 * MINUTE) },
      { id: 's-day', agentId: 'atlas', status: 'idle', createdAt: iso(T0 - 3000 * MINUTE), updatedAt: iso(T0 - 2000 * MINUTE) },
      { id: 's-stale', agentId: 'atlas', status: 'completed', createdAt: iso(T0 - 20000 * MINUTE), updatedAt: iso(T0 - 8 * 24 * 60 * MINUTE) },
      { id: 's-blair', agentId: 'blair', status: 'completed', createdAt: iso(T0 - 100 * MINUTE), updatedAt: iso(T0 - 50 * MINUTE) },
    ],
  });
  await h.upkeep.start();
  await h.upkeep.drain();
  assert.deepEqual(h.asked.map((r) => r.sessionId), ['s-day'], 'already quiet: asked at once');
  await h.advance(20 * MINUTE);
  assert.deepEqual(h.asked.map((r) => r.sessionId), ['s-day', 's-new']);
  await h.advance(600 * MINUTE);
  assert.equal(h.asked.length, 2);
  assert.deepEqual(h.fleetReads.filter((read) => read.agentId !== undefined).map((read) => read.agentId), ['atlas']);
  h.upkeep.stop();
});

test('a sweep the fleet fails is tried again on the next drain', async () => {
  const h = harness({
    sessions: [{ id: 's-1', agentId: 'atlas', status: 'completed', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0 - 40 * MINUTE).toISOString() }],
    fleetFailures: 1,
  });
  await h.upkeep.start();
  await h.upkeep.drain();
  assert.equal(h.asked.length, 0);
  assert.ok(h.logs.some(([kind, line]) => kind === 'warn' && line.includes('index locked')));
  await h.upkeep.drain();
  assert.deepEqual(h.asked.map((r) => r.sessionId), ['s-1']);
  h.upkeep.stop();
});

test('a request core rejects as malformed is logged and dropped, never retried in a loop', async () => {
  const h = harness({ answer: () => Promise.reject(new Error('memoryPasses.run: session s-1 is not atlas\'s.')) });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.advance(30 * MINUTE);
  await h.advance(600 * MINUTE);
  assert.equal(h.asked.length, 1);
  assert.ok(h.logs.some(([kind, line]) => kind === 'warn' && line.includes('not atlas')));
  h.upkeep.stop();
});

test('tidy runs once a night inside the window, up to maxGroupsPerNight, stopping when nothing more waits', async () => {
  const tidyAnswers = [outcome('done', { superseded: 3, more: true }), outcome('done', { superseded: 2, more: true }), outcome('done', { more: false })];
  let tidyCount = 0;
  const h = harness({
    // T0 is 12:00Z; the window opens at 12:30 UTC.
    config: { agents: { atlas: { tidy: { window: '12:30-14:00', timeZone: 'UTC', maxGroupsPerNight: 10 } } } },
    answer: (request) => (request.kind === 'tidy' ? tidyAnswers[tidyCount++] ?? outcome('nothing-new') : outcome('nothing-new')),
  });
  await h.upkeep.start();
  await h.advance(29 * MINUTE);
  assert.equal(h.asked.length, 0);
  await h.advance(1 * MINUTE);
  assert.equal(h.asked.length, 3);
  const [first] = h.asked;
  delete first.signal;
  assert.deepEqual(first, { kind: 'tidy', agentId: 'atlas', mode: 'shadow', at: T0 + 30 * MINUTE });
  await h.advance(60 * MINUTE);
  assert.equal(h.asked.length, 3, 'once a night');
  await h.advance(23 * 60 * MINUTE);
  assert.equal(h.asked.length, 4, 'the next night tidies again');
  h.upkeep.stop();
});

test('tidy stops at maxGroupsPerNight; a failed night is not tried again until the next night', async () => {
  const h = harness({
    config: { agents: { atlas: { tidy: { window: '12:00-14:00', timeZone: 'UTC', maxGroupsPerNight: 2 } } } },
    answer: (request) => (request.kind === 'tidy' ? outcome('done', { more: true }) : outcome('nothing-new')),
  });
  await h.upkeep.start();
  await h.upkeep.drain();
  assert.equal(h.asked.length, 2);
  h.upkeep.stop();

  const failing = harness({
    config: { agents: { atlas: { tidy: { window: '12:00-14:00', timeZone: 'UTC' } } } },
    answer: () => outcome('failed', { reason: 'budget' }),
  });
  await failing.upkeep.start();
  await failing.upkeep.drain();
  await failing.advance(60 * MINUTE);
  assert.equal(failing.asked.length, 1);
  await failing.advance(24 * 60 * MINUTE);
  assert.equal(failing.asked.length, 2);
  failing.upkeep.stop();
});

test('tidy for a store without list-valued supersedes warns once and does not ask again that night', async () => {
  const h = harness({
    config: { agents: { atlas: { tidy: { window: '12:00-14:00', timeZone: 'UTC' } } } },
    answer: () => outcome('skipped', { reason: 'store-unsupported' }),
  });
  await h.upkeep.start();
  await h.upkeep.drain();
  await h.advance(30 * MINUTE);
  await h.advance(24 * 60 * MINUTE);
  assert.equal(h.asked.length, 2);
  assert.equal(h.logs.filter(([kind, line]) => kind === 'warn' && line.includes('supersedes')).length, 1);
  h.upkeep.stop();
});

test('tidy refused because the host is still loading is asked again a minute later the same night', async () => {
  let n = 0;
  const h = harness({
    config: { agents: { atlas: { tidy: { window: '12:00-14:00', timeZone: 'UTC' } } } },
    answer: () => (++n === 1 ? outcome('skipped', { reason: 'not-started' }) : outcome('nothing-new')),
  });
  await h.upkeep.start();
  await h.upkeep.drain();
  assert.equal(h.asked.length, 1);
  await h.advance(RETRY_SOON_MS);
  assert.equal(h.asked.length, 2);
  h.upkeep.stop();
});

test('stop aborts a running pass, stops listening, and asks nothing more', async () => {
  let seen;
  let release;
  const h = harness({
    answer: (request) => {
      seen = request.signal;
      return new Promise((resolve) => {
        release = () => resolve(outcome('interrupted'));
      });
    },
  });
  await h.upkeep.start();
  await h.turn('s-1');
  await h.turn('s-2');
  const running = h.advance(30 * MINUTE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.asked.length, 1);
  h.upkeep.stop();
  assert.equal(seen.aborted, true);
  release();
  await running;
  await h.turn('s-3');
  await h.advance(600 * MINUTE);
  assert.equal(h.asked.length, 1);
});
