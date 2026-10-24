import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaimStore } from '../lib/claims.js';
import { parseDreamsConfig } from '../lib/config.js';
import { createDreamer } from '../lib/dreamer.js';
import { SANDBOX_EXEC } from '../lib/sandbox.js';
import { LOCK_BUSY, TETHER } from '../lib/tether.js';

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

// Runs start under the tether: record the command it was given to run,
// and the signals the daemon sends the tether.
let pids = 900_000;
const fakeChild = (kills) => {
  const child = new EventEmitter();
  child.pid = (pids += 1);
  child.kill = (signal) => kills.push(signal);
  return child;
};
const unwrap = (command, args, options, child) => {
  if (command === process.execPath && args[0] === TETHER) {
    const split = args.indexOf('--');
    return { command: args[split + 1], args: args.slice(split + 2), tether: { lock: args[1], grace: args[2] }, options, child };
  }
  return { command, args, options, child };
};

const fixture = ({ agents, now, guard = async () => {}, onSpawn = () => {}, secrets = { ava: { anthropicApiKey: 'sk-test' } }, holdReports = false }) => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'dreams-state-'));
  const claims = createClaimStore(() => state);
  const timers = fakeTimers();
  const runs = [];
  const kills = [];
  const warnings = [];
  const proxies = fakeProxies();
  const reports = [];
  const reportCalls = [];
  const spawn = (command, args, options) => {
    const child = fakeChild(kills);
    const call = unwrap(command, args, options, child);
    if (call.args.includes('report')) {
      reportCalls.push(call);
      if (holdReports) {
        reports.push(child);
      } else {
        setImmediate(() => child.emit('exit', 0, null));
      }
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
    secrets: typeof secrets === 'function' ? secrets : async () => secrets,
    tools: { overnight: '/opt/x/bin/overnight', read: [], deny: () => [], searchPath: '/usr/bin:/bin' },
    now: () => now.value,
    timers,
    keyProxy: proxies.keyProxy,
    warn: (message) => warnings.push(message),
  });
  return { dreamer, claims, runs, kills, timers, proxies, warnings, reports, reportCalls };
};

// A second daemon on the first one's state.
const restarted = (agents, now, state, { claims = createClaimStore(() => state), warnings = [] } = {}) => {
  const runs = [];
  const kills = [];
  const dreamer = createDreamer({
    agents: parseDreamsConfig({ agents }).agents,
    claims,
    stateDir: () => state,
    spawn: (command, args, options) => {
      const child = fakeChild(kills);
      runs.push(unwrap(command, args, options, child));
      return child;
    },
    guard: async () => {},
    secrets: async () => ({ ava: { anthropicApiKey: 'sk-test' }, bo: { anthropicApiKey: 'sk-test' } }),
    keyProxy: fakeProxies().keyProxy,
    tools: { overnight: '/opt/x/bin/overnight', read: [], deny: () => [], searchPath: '/usr/bin' },
    now: () => now.value,
    timers: fakeTimers(),
    warn: (message) => warnings.push(message),
  });
  return { dreamer, runs, kills, warnings };
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
  // Under the tether, with a pipe from the daemon on its stdin.
  assert.equal(run.tether.grace, '30000');
  assert.equal(run.options.stdio[0], 'pipe');
  assert.equal(run.options.detached, undefined, 'the tether puts the experiment in its own group');
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
  const { dreamer: second, runs, kills } = restarted(agents, now, state);
  await second.begin();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args[4], b, 'the interrupted experiment is skipped');
  assert.deepEqual(kills, [], 'nothing from the old daemon is looked for or signalled');
  const [spent] = createClaimStore(() => state).night('ava', '2026-10-23');
  assert.equal(spent.result.status, 'interrupted');
  assert.equal(spent.result.summary.attempts, 1, 'and what it got done is still summarized');
});

test('the window end asks the tether to stop the run, once', async () => {
  const exp = experimentDir();
  const { dreamer, runs, kills, timers, claims } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '8h' }] } },
    now: night(23, 0),
  });
  await dreamer.tick();
  timers.fire((handle) => handle.ms === 8 * 3600_000);
  assert.deepEqual(kills, ['SIGTERM'], 'the tether owns the grace and the SIGKILL');
  const stopped = dreamer.stop();
  assert.deepEqual(kills, ['SIGTERM'], 'a stop after that asks nothing more');
  await exit(runs[0], null, 'SIGKILL');
  await stopped;
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
  assert.deepEqual(kills, ['SIGTERM']);
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
  const { dreamer, runs, claims, proxies } = fixture({
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
  assert.deepEqual(proxies.opened.map((proxy) => proxy.closed), proxies.opened.map(() => true), 'a proxy opened for it is closed');
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
  const { dreamer: second, runs } = restarted({ ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: b, budget: '1h' }, { path: a, budget: '1h' }] } }, now, state);
  await second.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args[4], b, 'B runs, not A again');
  const spent = createClaimStore(() => state).night('ava', '2026-10-23');
  assert.deepEqual(spent.map((entry) => [entry.index, entry.path]), [[0, a], [1, b]]);
});

test('after a restart, a run that is still stopping keeps its directory until its tether lets go', async () => {
  const exp = experimentDir();
  const now = night(23, 10);
  const first = fixture({ agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } }, now });
  await first.dreamer.tick();
  const state = first.runs[0].options.env.HOME.split('/agents/')[0];
  // The old run's tether is still in its grace and holds the lock. The
  // config moved the directory to another agent before the restart.
  const O_EXLOCK = 0x20;
  const held = openSync(first.runs[0].tether.lock, constants.O_CREAT | constants.O_RDWR | O_EXLOCK | constants.O_NONBLOCK, 0o600);
  const { dreamer, runs, kills } = restarted({ bo: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } }, now, state);
  await dreamer.begin();
  await dreamer.tick();
  assert.equal(runs.length, 0, 'nothing starts in the directory while the old run holds it');
  assert.deepEqual(createClaimStore(() => state).night('bo', '2026-10-23'), [], 'and nothing is spent');
  closeSync(held);
  await dreamer.tick();
  assert.equal(runs.length, 1, 'it starts once the old tether is gone');
  assert.equal(runs[0].tether.lock, first.runs[0].tether.lock, 'one lock per directory, whichever agent runs it');
  assert.deepEqual(kills, []);
});

test('a tether that finds the lock taken runs nothing and the experiment is recorded as failed to start', async () => {
  const exp = experimentDir();
  const { dreamer, runs, claims, reports, proxies } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    holdReports: true,
  });
  await dreamer.tick();
  await exit(runs[0], LOCK_BUSY);
  const [entry] = claims.night('ava', '2026-10-23');
  assert.equal(entry.result.status, 'failed-to-start');
  assert.match(entry.result.error, /earlier daemon/);
  assert.equal(reports.length, 0, 'no report for a run that never ran');
  assert.equal(proxies.opened[0].closed, true);
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

test('a setup failure after the key proxy opens closes it, and retries do not pile up proxies', async () => {
  const parent = experimentDir();
  // A quote can't be written into a sandbox profile, so experimentProfile throws.
  const exp = path.join(parent, 'say "hi"');
  mkdirSync(path.join(exp, 'workspace'), { recursive: true });
  const { dreamer, runs, proxies, warnings } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
  });
  await dreamer.tick();
  await dreamer.tick();
  assert.equal(runs.length, 0);
  assert.ok(proxies.opened.length >= 1);
  assert.deepEqual(proxies.opened.map((proxy) => proxy.closed), proxies.opened.map(() => true), 'every proxy opened for a failed setup is closed');
  assert.ok(warnings.some((message) => message.includes('cannot express the path')));
});

test('a daemon stop after the tether has exited signals nothing', async () => {
  const exp = experimentDir();
  const { dreamer, runs, kills, timers, reports } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    holdReports: true,
  });
  await dreamer.tick();
  runs[0].child.emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reports.length, 1, 'finish is waiting on the report');
  const stopped = dreamer.stop();
  reports[0].emit('exit', 0, null);
  await stopped;
  assert.deepEqual(kills, [], 'the pid may be reused by now: no signal');
  assert.equal([...timers.pending].length, 0, 'and no timer is left armed');
});

test('the experiment directory stays busy until its report and summary are done', async () => {
  const exp = experimentDir();
  const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'dreams-link-')), 'exp');
  symlinkSync(exp, link);
  const { dreamer, runs, reports } = fixture({
    agents: {
      ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] },
      bo: { window: '23:00-07:00', experiments: [{ path: link, budget: '1h' }] },
    },
    now: night(23, 0),
    secrets: { ava: { anthropicApiKey: 'sk-a' }, bo: { anthropicApiKey: 'sk-b' } },
    holdReports: true,
  });
  await dreamer.tick();
  runs[0].child.emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await dreamer.tick();
  assert.equal(runs.length, 1, 'the second agent waits while the first run is still reporting');
  reports[0].emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs.length, 2, 'and runs once the report is done');
});

test('the window and budget are checked again after the async setup, before the claim', async () => {
  const exp = experimentDir();
  const closed = night(23, 0);
  const late = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: closed,
    secrets: async () => {
      closed.value = new Date(2026, 9, 24, 7, 5);
      return { ava: { anthropicApiKey: 'sk-test' } };
    },
  });
  await late.dreamer.tick();
  assert.equal(late.runs.length, 0, 'the window closed while setting up: nothing spawns');
  assert.deepEqual(late.claims.night('ava', '2026-10-23'), [], 'and nothing is spent');
  assert.deepEqual(late.proxies.opened.map((proxy) => proxy.closed), late.proxies.opened.map(() => true));

  const tight = night(23, 0);
  const cut = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '8h' }] } },
    now: tight,
    secrets: async () => {
      tight.value = new Date(2026, 9, 24, 6, 30);
      return { ava: { anthropicApiKey: 'sk-test' } };
    },
  });
  await cut.dreamer.tick();
  assert.equal(cut.runs.length, 1);
  const args = cut.runs[0].args;
  assert.equal(args[args.indexOf('--budget') + 1], '900s', 'the budget is cut to what is left now');
  assert.equal(cut.claims.night('ava', '2026-10-23')[0].budgetSeconds, 900);
});

test('a report that cannot be spawned clears its timeout', async () => {
  const exp = experimentDir();
  const { dreamer, runs, timers, reports, claims } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    holdReports: true,
  });
  await dreamer.tick();
  runs[0].child.emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reports.length, 1);
  reports[0].emit('error', new Error('spawn sandbox-exec ENOENT'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(claims.night('ava', '2026-10-23')[0].result, 'the run is finished');
  assert.deepEqual([...timers.pending].filter((handle) => handle.ms === 120_000), [], 'no report timer is left armed');
});

test('a claim file that cannot be read blocks only that agent, and never reads as nothing spent', async () => {
  const [a, b] = [experimentDir(), experimentDir()];
  const agents = {
    ava: { window: '23:00-07:00', experiments: [{ path: a, budget: '1h' }] },
    bo: { window: '23:00-07:00', experiments: [{ path: b, budget: '1h' }] },
  };
  const now = night(23, 10);
  const state = mkdtempSync(path.join(os.tmpdir(), 'dreams-state-'));
  mkdirSync(path.join(state, 'claims'));
  writeFileSync(path.join(state, 'claims', 'ava.json'), '{oops');
  const { dreamer, runs, warnings } = restarted(agents, now, state);
  await dreamer.begin();
  await dreamer.tick();
  assert.deepEqual(runs.map((run) => run.args[4]), [b]);
  assert.ok(warnings.some((message) => message.includes('ava') && message.includes('cannot read its claims')));
});

test('the report runs under the tether too, on the run\'s lock, and its timeout asks the tether to stop it', async () => {
  const exp = experimentDir();
  const { dreamer, runs, kills, timers, reportCalls } = fixture({
    agents: { ava: { window: '23:00-07:00', experiments: [{ path: exp, budget: '1h' }] } },
    now: night(23, 0),
    holdReports: true,
  });
  await dreamer.tick();
  runs[0].child.emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reportCalls.length, 1);
  assert.equal(reportCalls[0].command, SANDBOX_EXEC);
  assert.equal(reportCalls[0].tether?.lock, runs[0].tether.lock, 'nothing else starts in the directory while it reports');
  assert.equal(reportCalls[0].options.stdio[0], 'pipe', 'and it goes if the daemon does');
  timers.fire((handle) => handle.ms === 120_000);
  assert.deepEqual(kills, ['SIGTERM'], 'the tether stops the report\'s whole group');
  reportCalls[0].child.emit('exit', null, 'SIGTERM');
});

test('a run whose end cannot be recorded still frees its agent and directory, and stop still returns', async () => {
  const exp = experimentDir();
  const { dreamer, runs, claims, warnings } = fixture({
    agents: { ava: { window: '23:00-07:00', maxPerNight: 2, experiments: [{ path: exp, budget: '1h' }, { path: experimentDir(), budget: '1h' }] } },
    now: night(23, 0),
  });
  await dreamer.tick();
  const finish = claims.finish;
  claims.finish = () => {
    throw new Error('ENOSPC: no space left on device');
  };
  await exit(runs[0]);
  claims.finish = finish;
  assert.ok(warnings.some((message) => message.includes('ENOSPC')), 'the failure is said');
  assert.equal(dreamer.running.has('ava') && dreamer.running.get('ava').child === runs[0].child, false, 'the agent is free');
  assert.equal(runs.length, 2, 'and the next experiment starts');
  const stopped = dreamer.stop();
  runs[1].child.emit('exit', null, 'SIGTERM');
  await stopped;
});
