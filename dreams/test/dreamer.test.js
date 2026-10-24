import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaimStore } from '../lib/claims.js';
import { parseDreamsConfig } from '../lib/config.js';
import { createDreamer } from '../lib/dreamer.js';
import { SANDBOX_EXEC } from '../lib/sandbox.js';

const fakeTimers = () => {
  const pending = new Set();
  return {
    pending,
    setTimeout(fn, ms) {
      const handle = { fn, ms };
      pending.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    setInterval() {
      return { unref() {} };
    },
    clearInterval() {},
    fire(predicate) {
      for (const handle of [...pending]) {
        if (predicate(handle)) {
          pending.delete(handle);
          handle.fn();
        }
      }
    },
  };
};

// Stands in for the loopback key proxy: records what it was given.
const fakeProxies = () => {
  const opened = [];
  const keyProxy = async ({ apiKey }) => {
    const proxy = { apiKey, token: `run-token-${opened.length + 1}`, baseUrl: `http://127.0.0.1:${40000 + opened.length}`, closed: false };
    proxy.close = async () => {
      proxy.closed = true;
    };
    opened.push(proxy);
    return proxy;
  };
  return { opened, keyProxy };
};

// kill(-pid, 0) throws ESRCH unless the group is in `alive`.
const groupKill = (alive, kills, stubborn = new Set()) => (target, signal) => {
  if (signal !== 0) {
    kills.push([target, signal]);
  }
  if (!alive.has(-target)) {
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  }
  if (signal === 'SIGKILL' && !stubborn.has(-target)) {
    alive.delete(-target);
  }
};

const fixture = ({ agents, now, guard = async () => {}, onSpawn = () => {}, secrets = { ava: { anthropicApiKey: 'sk-test' } }, alive = new Set(), stubborn = new Set() }) => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'dreams-state-'));
  const claims = createClaimStore(() => state);
  const timers = fakeTimers();
  const runs = [];
  const kills = [];
  const warnings = [];
  const proxies = fakeProxies();
  let pid = 900_000;
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = (pid += 1);
    child.kill = () => {};
    const call = { command, args, options, child };
    if (args.includes('report')) {
      setImmediate(() => child.emit('exit', 0, null));
    } else {
      onSpawn(call, claims);
      runs.push(call);
    }
    return child;
  };
  const dreamer = createDreamer({
    agents: parseDreamsConfig({ agents }).agents,
    claims,
    stateDir: () => state,
    spawn,
    guard,
    secrets: async () => secrets,
    tools: { overnight: '/opt/x/bin/overnight', read: [], deny: () => [], searchPath: '/usr/bin:/bin' },
    now: () => now.value,
    timers,
    sleep: async () => {},
    keyProxy: proxies.keyProxy,
    warn: (message) => warnings.push(message),
    kill: groupKill(alive, kills, stubborn),
  });
  return { dreamer, claims, runs, kills, timers, proxies, warnings, alive };
};

const experimentDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dreams-exp-')));
  mkdirSync(path.join(dir, 'workspace'));
  return dir;
};

const exit = async (run, code = 0, signal = null) => {
  run.child.emit('exit', code, signal);
  // finish() awaits the report child, which exits on the next tick.
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const night = (h, mi = 0, day = 23) => ({ value: new Date(2026, 9, day, h, mi) });

test('an experiment is claimed, durably, before its process starts', async () => {
  const exp = experimentDir();
  appendFileSync(path.join(exp, 'experiments.jsonl'), '{"experiment_id":0}\n');
  const seen = [];
  const { dreamer, runs } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '6h' }] } },
    now: night(23, 5),
    onSpawn: (call, claims) => seen.push(createClaimStore(() => call.options.env.HOME.split('/agents/')[0]).night('ava', '2026-10-23')),
  });
  await dreamer.tick();
  assert.equal(runs.length, 1);
  assert.equal(seen[0].length, 1, 'the claim is on disk when spawn is called');
  assert.equal(seen[0][0].index, 0);
  assert.equal(seen[0][0].offset, 20, 'the offset is the log size at the start');
  assert.equal(seen[0][0].result, undefined);
});

test('the run is sandboxed, uses claude only, has a clean env and a budget cut to the window', async () => {
  const exp = experimentDir();
  const { dreamer, runs, proxies } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '8h', direction: 'minimize', maxExperiments: 3 }] } },
    now: night(3, 0, 24),
  });
  await dreamer.tick();
  const [run] = runs;
  assert.equal(run.command, SANDBOX_EXEC);
  assert.equal(run.args[0], '-p');
  assert.deepEqual(run.args.slice(2), [
    '/opt/x/bin/overnight', 'run', exp, '--budget', `${4 * 3600 - 15 * 60}s`, '--agent', 'claude', '--direction', 'minimize', '--max-experiments', '3',
  ]);
  assert.equal(run.options.detached, true);
  assert.deepEqual(Object.keys(run.options.env).sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  // The real key stays in the daemon: the run gets a loopback proxy and a
  // token for it that is worthless anywhere else.
  assert.equal(proxies.opened.length, 1);
  assert.equal(proxies.opened[0].apiKey, 'sk-test');
  assert.equal(run.options.env.ANTHROPIC_BASE_URL, proxies.opened[0].baseUrl);
  assert.equal(run.options.env.ANTHROPIC_API_KEY, proxies.opened[0].token);
  assert.ok(!Object.values(run.options.env).includes('sk-test'), 'the real key is nowhere in the env');
  assert.ok(run.options.env.CLAUDE_CONFIG_DIR.startsWith(run.options.env.HOME));
  assert.notEqual(run.options.env.HOME, os.homedir());
});

test('at most maxPerNight run, one at a time, in config order; the next night starts over', async () => {
  const [a, b, c] = [experimentDir(), experimentDir(), experimentDir()];
  const now = night(23, 0);
  const { dreamer, runs } = fixture({
    agents: { ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: a, budget: '1h' }, { path: b, budget: '1h' }, { path: c, budget: '1h' }] } },
    now,
  });
  await dreamer.tick();
  await dreamer.tick();
  assert.equal(runs.length, 1, 'one at a time');
  assert.equal(runs[0].args[4], a);
  await exit(runs[0]);
  assert.equal(runs.length, 2, 'the next one starts when the first ends');
  assert.equal(runs[1].args[4], b);
  await exit(runs[1]);
  await dreamer.tick();
  assert.equal(runs.length, 2, 'maxPerNight holds');
  now.value = new Date(2026, 9, 24, 12, 0);
  await dreamer.tick();
  assert.equal(runs.length, 2, 'nothing outside the window');
  now.value = new Date(2026, 9, 24, 23, 30);
  await dreamer.tick();
  assert.equal(runs.length, 3);
  assert.equal(runs[2].args[4], a, 'a new night starts from the top');
});

test('a daemon that died mid-run moves on to the next experiment and never replays the spent one', async () => {
  const [a, b] = [experimentDir(), experimentDir()];
  const agents = { ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: a, budget: '1h' }, { path: b, budget: '1h' }] } };
  const now = night(23, 10);
  const first = fixture({ agents, now });
  await first.dreamer.tick();
  appendFileSync(path.join(a, 'experiments.jsonl'), '{"experiment_id":1,"score":2,"best_score":2,"improved":true,"description":"x"}\n');
  // The daemon is gone; its child never reports. A new daemon on the same state:
  const state = first.runs[0].options.env.HOME.split('/agents/')[0];
  const runs = [];
  const second = createDreamer({
    agents: parseDreamsConfig({ agents }).agents,
    claims: createClaimStore(() => state),
    stateDir: () => state,
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.pid = 1;
      runs.push({ args, options, child });
      return child;
    },
    guard: async () => {},
    secrets: async () => ({ ava: { anthropicApiKey: 'sk-test' } }),
    keyProxy: fakeProxies().keyProxy,
    tools: { overnight: '/opt/x/bin/overnight', read: [], deny: () => [], searchPath: '/usr/bin' },
    now: () => now.value,
    timers: fakeTimers(),
    kill: groupKill(new Set(), []),
  });
  await second.recover();
  await second.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args[4], b, 'the interrupted experiment is skipped');
  const [spent] = createClaimStore(() => state).night('ava', '2026-10-23');
  assert.equal(spent.result.status, 'interrupted');
  assert.equal(spent.result.summary.attempts, 1, 'and what it got done is still summarized');
});

test('the window end stops the process group: SIGTERM, then SIGKILL after the grace', async () => {
  const exp = experimentDir();
  const { dreamer, runs, kills, timers, claims } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '8h' }] } },
    now: night(23, 0),
  });
  await dreamer.tick();
  const pid = runs[0].child.pid;
  timers.fire((handle) => handle.ms === 8 * 3600_000);
  assert.deepEqual(kills, [[-pid, 'SIGTERM']]);
  timers.fire((handle) => handle.ms === 30_000);
  assert.deepEqual(kills, [[-pid, 'SIGTERM'], [-pid, 'SIGKILL']]);
  await exit(runs[0], null, 'SIGKILL');
  const [entry] = claims.night('ava', '2026-10-23');
  assert.equal(entry.result.status, 'stopped-at-window-end');
  assert.equal(entry.result.signal, 'SIGKILL');
});

test('stopping the daemon stops the run and records it', async () => {
  const exp = experimentDir();
  const { dreamer, runs, kills, claims } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
  });
  await dreamer.tick();
  const stopped = dreamer.stop();
  assert.deepEqual(kills, [[-runs[0].child.pid, 'SIGTERM']]);
  runs[0].child.emit('exit', null, 'SIGTERM');
  await stopped;
  assert.equal(claims.night('ava', '2026-10-23')[0].result.status, 'stopped-by-daemon');
  await dreamer.tick();
  assert.equal(runs.length, 1, 'nothing starts after stop');
});

test('a refused path is spent as refused and never spawned; too little window left starts nothing', async () => {
  const exp = experimentDir();
  const refused = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    guard: async () => {
      throw new Error('overlaps a workspace');
    },
  });
  await refused.dreamer.tick();
  assert.equal(refused.runs.length, 0);
  assert.equal(refused.claims.night('ava', '2026-10-23')[0].result.status, 'refused');

  const late = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(6, 40, 24),
  });
  await late.dreamer.tick();
  assert.equal(late.runs.length, 0);
  assert.deepEqual(late.claims.night('ava', '2026-10-23'), [], 'not claimed: nothing was spent');
});

test('a stop during a start that is still checking its path waits for it, and nothing spawns', { timeout: 5000 }, async () => {
  const exp = experimentDir();
  let release;
  const order = [];
  const { dreamer, runs, claims } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    guard: () => new Promise((resolve) => {
      release = resolve;
    }),
  });
  const ticking = dreamer.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = dreamer.stop().then(() => order.push('stopped'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, [], 'stop waits for the in-flight start');
  release();
  await ticking;
  await stopped;
  assert.equal(runs.length, 0, 'nothing spawns after stop');
  assert.deepEqual(claims.night('ava', '2026-10-23'), [], 'nothing spent: the next daemon runs it');
});

test('a reordered config after a restart still runs each experiment at most once a night', async () => {
  const [a, b] = [experimentDir(), experimentDir()];
  const now = night(23, 10);
  const first = fixture({ agents: { ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: a, budget: '1h' }, { path: b, budget: '1h' }] } }, now });
  await first.dreamer.tick();
  assert.equal(first.runs[0].args[4], a);
  // The daemon stops after A; the config is reordered before it restarts.
  const stopped = first.dreamer.stop();
  await exit(first.runs[0], null, 'SIGTERM');
  await stopped;
  const state = first.runs[0].options.env.HOME.split('/agents/')[0];
  const runs = [];
  const second = createDreamer({
    agents: parseDreamsConfig({ agents: { ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: b, budget: '1h' }, { path: a, budget: '1h' }] } } }).agents,
    claims: createClaimStore(() => state),
    stateDir: () => state,
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.pid = 2;
      runs.push({ args, options, child });
      return child;
    },
    guard: async () => {},
    secrets: async () => ({ ava: { anthropicApiKey: 'sk-test' } }),
    keyProxy: fakeProxies().keyProxy,
    tools: { overnight: '/opt/x/bin/overnight', read: [], deny: () => [], searchPath: '/usr/bin' },
    now: () => now.value,
    timers: fakeTimers(),
    kill: groupKill(new Set(), []),
  });
  await second.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args[4], b, 'B runs, not A again');
  const spent = createClaimStore(() => state).night('ava', '2026-10-23');
  assert.deepEqual(spent.map((entry) => [entry.index, entry.path]), [[0, a], [1, b]]);
});

test('recovery waits for a leftover process group to exit, with SIGKILL after the grace, before anything new starts', async () => {
  const [a, b] = [experimentDir(), experimentDir()];
  const agents = { ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: a, budget: '1h' }, { path: b, budget: '1h' }] } };
  const now = night(23, 10);
  const first = fixture({ agents, now });
  await first.dreamer.tick();
  const leftover = first.runs[0].child.pid;
  const state = first.runs[0].options.env.HOME.split('/agents/')[0];
  const alive = new Set([leftover]);
  const kills = [];
  const runs = [];
  const second = createDreamer({
    agents: parseDreamsConfig({ agents }).agents,
    claims: createClaimStore(() => state),
    stateDir: () => state,
    spawn: (command, args, options) => {
      runs.push({ args, aliveAtSpawn: alive.has(leftover) });
      const child = new EventEmitter();
      child.pid = 3;
      return child;
    },
    guard: async () => {},
    secrets: async () => ({ ava: { anthropicApiKey: 'sk-test' } }),
    keyProxy: fakeProxies().keyProxy,
    tools: { overnight: '/opt/x/bin/overnight', read: [], deny: () => [], searchPath: '/usr/bin' },
    now: () => now.value,
    timers: fakeTimers(),
    sleep: async () => {},
    owns: (pid) => pid === leftover,
    kill: (target, signal) => {
      if (signal !== 0) {
        kills.push([target, signal]);
      }
      if (!alive.has(-target)) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      if (signal === 'SIGKILL') {
        alive.delete(-target);
      }
    },
  });
  await second.begin();
  assert.deepEqual(kills, [[-leftover, 'SIGTERM'], [-leftover, 'SIGKILL']], 'it ignored SIGTERM, so it got SIGKILL');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].aliveAtSpawn, false, 'the next experiment starts only after the group is gone');
});

test('the key proxy closes when the run ends', async () => {
  const exp = experimentDir();
  const { dreamer, runs, proxies } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
  });
  await dreamer.tick();
  assert.equal(proxies.opened[0].closed, false, 'open while the run is');
  await exit(runs[0]);
  assert.equal(proxies.opened[0].closed, true);
});

test('with no key stored nothing runs and nothing is spent: login mode is not supported', async () => {
  const exp = experimentDir();
  const { dreamer, runs, claims, proxies, warnings } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    secrets: {},
  });
  await dreamer.tick();
  await dreamer.tick();
  assert.equal(runs.length, 0);
  assert.equal(proxies.opened.length, 0);
  assert.deepEqual(claims.night('ava', '2026-10-23'), []);
  assert.equal(warnings.length, 1, 'said once');
  assert.match(warnings[0], /stratus channel set dreams --agent ava anthropicApiKey/);
});

test('a leader that exits leaving its group alive: the group is stopped before the run ends', async () => {
  const exp = experimentDir();
  const alive = new Set();
  const { dreamer, runs, kills, claims, proxies } = fixture({
    agents: { ava: { window: '23:00-07:00', maxPerNight: 1, experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    alive,
  });
  await dreamer.tick();
  const pid = runs[0].child.pid;
  alive.add(pid);
  // evaluate.sh left something in the background; the leader exits.
  await exit(runs[0], 0);
  assert.deepEqual(kills, [[-pid, 'SIGTERM'], [-pid, 'SIGKILL']], 'TERM, the grace, then KILL');
  assert.equal(alive.has(pid), false);
  const [entry] = claims.night('ava', '2026-10-23');
  assert.equal(entry.result.status, 'finished');
  assert.equal(entry.result.strays, 'stopped');
  assert.equal(proxies.opened[0].closed, true, 'the proxy outlives every member of the group');
});

test('a group that survives SIGKILL after its leader exits blocks that agent until it is gone', async () => {
  const [a, b] = [experimentDir(), experimentDir()];
  const alive = new Set();
  const stubborn = new Set();
  const { dreamer, runs, claims } = fixture({
    agents: { ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: a, budget: '1h' }, { path: b, budget: '1h' }] } },
    now: night(23, 0),
    alive,
    stubborn,
  });
  await dreamer.tick();
  const pid = runs[0].child.pid;
  // A member SIGKILL cannot end yet (say, stuck in uninterruptible I/O).
  alive.add(pid);
  stubborn.add(pid);
  await exit(runs[0], 0);
  assert.equal(claims.night('ava', '2026-10-23')[0].result.strays, 'survived');
  await dreamer.tick();
  assert.equal(runs.length, 1, 'nothing new starts while the group lives');
  stubborn.clear();
  alive.delete(pid);
  await dreamer.tick();
  assert.equal(runs.length, 2, 'and the next one starts once it is gone');
});

test('two agents never run the same experiment directory at once, even through a symlink', async () => {
  const exp = experimentDir();
  const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'dreams-link-')), 'exp');
  symlinkSync(exp, link);
  const { dreamer, runs } = fixture({
    agents: {
      ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] },
      bo: { window: '23:00-07:00', experiments: [{ path: link, budget: '1h' }] },
    },
    now: night(23, 0),
    secrets: { ava: { anthropicApiKey: 'sk-a' }, bo: { anthropicApiKey: 'sk-b' } },
  });
  await dreamer.tick();
  await dreamer.tick();
  assert.equal(runs.length, 1, 'the second agent waits for the path');
  await exit(runs[0]);
  assert.equal(runs.length, 2, 'and runs once it is free');
});
