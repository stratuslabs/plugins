import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLocalCommandExecutor, defineLocalCommandTool } from '@stratusagent/executor-local';

import { createPlugin, sandboxProfile, sandboxSettings } from '../index.js';

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

/** A minimal shell tool, run the way tool-shell runs one: replaced env, cwd in the workspace. */
const shellIn = (cwd, env = {}) => defineLocalCommandTool({
  name: 'shell.run',
  risk: 'gated',
  parameters: { type: 'object' },
  createCommand: async (input) => ({
    command: '/bin/sh',
    args: ['-c', String(input.command)],
    cwd,
    envMode: 'replace',
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: os.homedir(), ...env },
    timeoutMs: 20_000,
  }),
});

const setup = async (config = {}) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-')));
  const workspace = path.join(root, 'agents', 'nova', 'workspace');
  await mkdir(workspace, { recursive: true });
  const outside = path.join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'token\n');
  let registered;
  createPlugin(config).setup({
    executors: { register: (entry) => { registered = entry; } },
    workspaces: { forAgent: () => workspace, prepare: () => workspace, all: async () => [workspace] },
  });
  const session = { id: 's1', agent: { id: 'nova', name: 'Nova' }, status: 'running', messages: [] };
  const run = async (command, executor = registered.executor) => {
    const result = await executor.execute({ id: 'c1', toolName: 'shell.run', input: { command } }, shellIn(workspace), session);
    return { ok: result.ok, out: `${result.output?.stdout ?? ''}${result.output?.stderr ?? ''}` };
  };
  return { root, workspace, outside, run, host: createLocalCommandExecutor() };
};

test('the profile denies by default and allows exactly what it was given', () => {
  const profile = sandboxProfile({ write: ['/w'], read: ['/r'], network: false });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/w"\)/);
  assert.match(profile, /\(subpath "\/r"\)/);
  assert.doesNotMatch(profile, /network/);
  assert.match(profile, /\(allow signal \(target same-sandbox\)\)/);
  assert.doesNotMatch(profile, /\bsignal\b(?! \(target same-sandbox\))/);
  assert.match(sandboxProfile({ write: ['/w'], read: [], network: true }), /\(allow network\*\)/);
  // A path that would end the string early is refused, not spliced in.
  assert.throws(() => sandboxProfile({ write: ['/w") (allow file-write* (subpath "/'], read: [], network: true }), /cannot express/);
});

test('settings add shared and per-agent paths, and network is on unless turned off', () => {
  const config = { readPaths: ['/opt/shared'], network: true, agents: { nova: { readPaths: ['/opt/nova'], network: false } } };
  const nova = sandboxSettings(config, 'nova', '/tmp', undefined, '/home/op');
  assert.deepEqual(nova.read.map((target) => path.basename(target)), ['shared', 'nova']);
  assert.equal(nova.network, false);
  assert.equal(sandboxSettings(config, 'blair', '/tmp').network, true);
  assert.deepEqual(sandboxSettings({ readPaths: ['~/.config/x'] }, 'nova', '/tmp', undefined, '/home/op').read, [path.join('/home/op', '.config', 'x')]);
});

test('inside the sandbox an agent works in its workspace and nowhere else', { skip: !onMac }, async () => {
  const { workspace, outside, run, host } = await setup();
  // Work in the workspace runs.
  const ok = await run('echo hi > a.txt && cat a.txt && mkdir -p sub && echo x > sub/b.txt && cat sub/b.txt');
  assert.equal(ok.ok, true, ok.out);
  assert.match(ok.out, /hi\nx/);

  // The same commands that escape on the host fail inside. Each is checked
  // on the host first, so a pass proves the wall and not a broken command.
  const escapes = [
    `cat ${outside}/secret.txt`,
    `echo pwned > ${outside}/written.txt`,
    `ln -s ${outside} link && cat link/secret.txt`,
    `ls ${os.homedir()}`,
  ];
  for (const command of escapes) {
    const free = await run(command, host);
    assert.equal(free.ok, true, `control: ${command} should work on the host (${free.out})`);
    await run(`rm -f link`, host);
    const caged = await run(command);
    assert.equal(caged.ok, false, `should be refused in the sandbox: ${command}`);
  }
  assert.equal(existsSync(path.join(outside, 'written.txt')), true, 'the host control did write');
  await writeFile(path.join(outside, 'written.txt'), 'before\n');
  await run(`echo pwned > ${outside}/written.txt`);
  assert.equal(await readFile(path.join(outside, 'written.txt'), 'utf8'), 'before\n');
  assert.equal(workspace.length > 0, true);
});

test('a git hook runs inside the same walls', { skip: !onMac || !existsSync('/usr/bin/git') }, async () => {
  const { workspace, outside, run } = await setup();
  const marker = path.join(outside, 'hook-ran');
  const repo = path.join(workspace, 'app');
  await mkdir(path.join(repo), { recursive: true });
  const init = await run('git init -q app && cd app && git config user.name a && git config user.email a@b && echo 1 > f && git add f');
  assert.equal(init.ok, true, init.out);
  const insideMarker = path.join(workspace, 'hook-ran-inside');
  await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > ${insideMarker}\necho ran > ${marker} 2>/dev/null\nexit 0\n`);
  await chmod(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
  const commit = await run('cd app && git commit -q -m m && git log --oneline | wc -l');
  assert.equal(commit.ok, true, commit.out);
  assert.equal(existsSync(insideMarker), true, 'the hook ran (inside)');
  assert.equal(existsSync(marker), false, 'the hook could not write outside the workspace');
});

test('a symlinked workspace is allowed where it really is', { skip: !onMac }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-link-')));
  const realWorkspace = path.join(root, 'real');
  await mkdir(realWorkspace);
  const linked = path.join(root, 'linked');
  await symlink(realWorkspace, linked);
  const settings = sandboxSettings({}, 'nova', linked, undefined);
  assert.deepEqual(settings.write, [realWorkspace]);
});

test('a command can signal its own children but no process outside the sandbox', { skip: !onMac }, async () => {
  const { run } = await setup();
  const { spawn } = await import('node:child_process');
  const host = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    // Control: the host itself may signal it, so a refusal below is the wall.
    assert.equal(process.kill(host.pid, 0), true);
    const outside = await run(`kill -0 ${host.pid}`);
    assert.equal(outside.ok, false, `signalling a host process should be refused (${outside.out})`);
    const own = await run('sleep 30 & kill $! && echo killed');
    assert.equal(own.ok, true, own.out);
    assert.match(own.out, /killed/);
  } finally {
    host.kill();
  }
});

test('no workspace refuses the command even when a cwd or write paths are known', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-nows-')));
  const cwd = path.join(root, 'cwd');
  await mkdir(cwd);
  for (const config of [{}, { writePaths: [path.join(root, 'extra')] }]) {
    let registered;
    createPlugin(config).setup({
      executors: { register: (entry) => { registered = entry; } },
      workspaces: { forAgent: () => undefined, prepare: () => undefined, all: async () => [] },
    });
    const session = { id: 's1', agent: { id: 'nova', name: 'Nova' }, status: 'running', messages: [] };
    const result = await registered.executor.execute({ id: 'c1', toolName: 'shell.run', input: { command: 'echo hi > a.txt' } }, shellIn(cwd), session);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /no workspace/);
  }
  // Nothing was created where the command would have run.
  assert.equal(existsSync(path.join(cwd, '.tmp')), false);
  assert.equal(existsSync(path.join(cwd, 'a.txt')), false);
});
