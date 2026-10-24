import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPlugin } from '../index.js';
import { experimentProfile, installRoot, sandboxAvailable, SANDBOX_EXEC } from '../lib/sandbox.js';

const tmp = (prefix) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));

const tool = (dir, name) => {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const file = path.join(dir, 'bin', name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
};

const context = ({ workspaces = [], protectedPaths = [] } = {}) => {
  const state = tmp('dreams-state-');
  const registered = { tools: [], channels: [] };
  return {
    registered,
    state,
    tools: { register: (entry) => registered.tools.push(entry) },
    channels: { register: (entry) => registered.channels.push(entry), transportSecrets: async () => ({ ava: { anthropicApiKey: 'sk-test' } }) },
    stateDirectory: { prepare: () => state },
    workspaces: { all: async () => workspaces },
    protectedPaths: { all: async () => protectedPaths },
    log() {},
    warn() {},
  };
};

let pids = 950_000;
// A tether asked to stop (its stdin closed) exits by the leader's SIGTERM.
const fakeSpawn = (calls, { sandbox = true } = {}) => (command, args, options) => {
  const child = new EventEmitter();
  child.pid = (pids += 1);
  child.kill = (signal) => setImmediate(() => child.emit('exit', null, signal));
  child.stdin = { on() {}, end: () => setImmediate(() => child.emit('exit', null, 'SIGTERM')) };
  calls.push({ command, args, options });
  if (args.includes('report')) {
    setImmediate(() => child.emit('exit', 0, null));
  }
  if (args[1] === '(version 1)(allow default)') {
    setImmediate(() => child.emit('exit', sandbox ? 0 : 71, null));
  }
  return child;
};

test('the plugin refuses to load anywhere but macOS', () => {
  assert.throws(() => createPlugin({}, { platform: 'linux' }).setup(context()), /not macOS.*Linux is refused/s);
});

test('it carries the agents it dreams for as a channel, and starts nothing in setup', () => {
  const ctx = context();
  const calls = [];
  createPlugin({ agents: { ava: { window: '23:00-07:00', experiments: [{ path: '/x/exp' }] } } }, { platform: 'darwin', spawn: fakeSpawn(calls) }).setup(ctx);
  assert.deepEqual(ctx.registered.channels.map((entry) => [entry.adapter.name, entry.agents]), [['dreams', ['ava']]]);
  assert.deepEqual(ctx.registered.tools.map((entry) => [entry.name, entry.risk, entry.outputTrust]), [['dreams.report', 'safe', 'external']]);
  assert.equal(calls.length, 0);
});

test('start refuses where no sandbox can be applied', async () => {
  const ctx = context();
  const plugin = createPlugin({ agents: { ava: { window: '23:00-07:00', experiments: [{ path: '/x/exp' }] } } }, { platform: 'darwin', spawn: fakeSpawn([], { sandbox: false }) });
  plugin.setup(ctx);
  await assert.rejects(ctx.registered.channels[0].adapter.start(), /cannot apply a sandbox here/);
});

const startedAt = async ({ workspaces = [], protectedPaths = [], exp }) => {
  const tools = tmp('dreams-tools-');
  const ctx = context({ workspaces, protectedPaths });
  const calls = [];
  const plugin = createPlugin(
    {
      agents: { ava: { window: '00:00-23:59', experiments: [{ path: exp, budget: '1h' }] } },
      overnightPath: tool(tools, 'overnight'),
      claudePath: tool(path.join(tools, 'claude'), 'claude'),
    },
    { platform: 'darwin', spawn: fakeSpawn(calls), home: tmp('dreams-home-'), now: () => new Date(2026, 9, 23, 12, 0) },
  );
  plugin.setup(ctx);
  await ctx.registered.channels[0].adapter.start();
  await plugin.dispose();
  return { calls: calls.filter((call) => call.args.includes('run')), ctx };
};

test('an experiment inside, or around, an agent workspace or protected path is refused, not run', async () => {
  const workspace = tmp('dreams-ws-');
  const inside = path.join(workspace, 'exp');
  mkdirSync(inside);
  const refused = await startedAt({ workspaces: [workspace], exp: inside });
  assert.equal(refused.calls.length, 0);
  const report = await refused.ctx.registered.tools[0].execute({}, { agent: { id: 'ava' } });
  assert.equal(report.experiments[0].status, 'refused');
  assert.match(report.experiments[0].reason, /overlaps/);

  const around = tmp('dreams-around-');
  mkdirSync(path.join(around, 'nested-protected'));
  assert.equal((await startedAt({ protectedPaths: [path.join(around, 'nested-protected')], exp: around })).calls.length, 0);

  const fine = tmp('dreams-fine-');
  assert.equal((await startedAt({ workspaces: [workspace], exp: fine })).calls.length, 1);
});

test('dreams.report answers for the calling agent only', async () => {
  const exp = tmp('dreams-exp-');
  const { ctx } = await startedAt({ exp });
  const [reportTool] = ctx.registered.tools;
  assert.equal((await reportTool.execute({}, { agent: { id: 'ava' } })).experiments.length, 1);
  assert.deepEqual((await reportTool.execute({}, { agent: { id: 'bo' } })).experiments, []);
  await assert.rejects(reportTool.execute({}, undefined), /calling agent/);
});

test('a tool installed straight in the home directory is not opened to the experiment', () => {
  const home = tmp('dreams-home-');
  assert.throws(() => installRoot(tool(home, 'claude'), path.join(home, 'bin')), /home directory or above/);
  assert.equal(installRoot('/opt/homebrew/bin/claude', home), '/opt/homebrew');
});

test('the profile writes only what the experimenter writes, and denies secrets after every allow', () => {
  const profile = experimentProfile({ experimentDir: '/e', home: '/s/home', tmp: '/s/tmp', read: ['/opt/py'], deny: ['/u/.ssh'] });
  const write = profile.split('\n').find((line) => line.startsWith('(allow file-write*'));
  assert.match(write, /\(subpath "\/e\/workspace"\) \(subpath "\/e\/best"\) \(literal "\/e\/experiments.jsonl"\) \(literal "\/e\/report.html"\)/);
  assert.doesNotMatch(write, /evaluate|program|"\/e"\)/);
  const lines = profile.split('\n');
  const denyAt = lines.findIndex((line) => line.startsWith('(deny file-read* file-write*'));
  assert.ok(denyAt > lines.findIndex((line) => line.startsWith('(allow file-read*')));
  assert.equal(lines.at(-1), '(allow file-read* file-write* (subpath "/s/home") (subpath "/s/tmp"))');
  assert.throws(() => experimentProfile({ experimentDir: '/e"x', home: '/h', tmp: '/t' }), /cannot express/);
});

// The real walls. sandbox-exec cannot be applied inside another sandbox
// (sandbox_apply: Operation not permitted), so these run only where the
// probe succeeds, such as the daemon's own host.
const canSandbox = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && await sandboxAvailable(nodeSpawn);

test('inside the real sandbox: the experimenter writes workspace/ and its log, not evaluate.sh, and cannot read a secret', { skip: !canSandbox && 'sandbox-exec cannot be applied here' }, async () => {
  const exp = tmp('dreams-real-');
  mkdirSync(path.join(exp, 'workspace'));
  writeFileSync(path.join(exp, 'evaluate.sh'), 'echo 1\n');
  writeFileSync(path.join(exp, 'program.md'), 'program\n');
  const secrets = tmp('dreams-secret-');
  writeFileSync(path.join(secrets, 'key'), 'hunter2\n');
  const own = tmp('dreams-own-');
  const profile = experimentProfile({ experimentDir: exp, home: path.join(own, 'home'), tmp: path.join(own, 'tmp'), deny: [secrets] });
  mkdirSync(path.join(own, 'home'));
  mkdirSync(path.join(own, 'tmp'));
  const sh = (script) => new Promise((resolve) => {
    const child = nodeSpawn(SANDBOX_EXEC, ['-p', profile, '/bin/sh', '-c', script], { cwd: exp, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => resolve({ code, out }));
  });
  assert.equal((await sh(`echo ok > workspace/a && echo '{}' >> experiments.jsonl && mkdir -p best && cat program.md`)).code, 0);
  assert.notEqual((await sh('echo pwned > evaluate.sh')).code, 0);
  assert.notEqual((await sh('echo pwned > program.md')).code, 0);
  assert.notEqual((await sh(`cat ${secrets}/key`)).code, 0);
  assert.equal((await sh(`echo ok > ${own}/home/.claude.json && cat ${own}/home/.claude.json`)).code, 0);
  assert.notEqual((await sh(`cat ${os.homedir()}/.ssh/config ${os.homedir()}/.zshrc 2>/dev/null | head -c1 | grep -q .`)).code, 0);
  assert.equal(readFileSync(path.join(exp, 'evaluate.sh'), 'utf8'), 'echo 1\n');
});
