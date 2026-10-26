import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLocalCommandExecutor, defineLocalCommandTool } from '@stratusagent/executor-local';

import { createPlugin, sandboxProfile, sandboxSettings, toolchainReads } from '../index.js';

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
  const run = async (command, executor = registered.executor, env = {}) => {
    const result = await executor.execute({ id: 'c1', toolName: 'shell.run', input: { command } }, shellIn(workspace, env), session);
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
  const online = sandboxProfile({ write: ['/w'], read: [], network: true });
  // IP traffic only: a bare network* would also reach every Unix socket the
  // user can open, the Docker socket included.
  assert.doesNotMatch(online, /\(allow network\*\)/);
  assert.match(online, /\(allow network-outbound \(remote ip\)/);
  // A path that would end the string early is refused, not spliced in.
  assert.throws(() => sandboxProfile({ write: ['/w") (allow file-write* (subpath "/'], read: [], network: true }), /cannot express/);
});

test('the active Xcode is readable whatever its bundle is named, and nothing else is added', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-xcode-')));
  const versioned = path.join(root, 'Xcode_26.6.app');
  await mkdir(path.join(versioned, 'Contents', 'Developer'), { recursive: true });
  await symlink(versioned, path.join(root, 'Xcode.app'));
  const tools = path.join(root, 'CommandLineTools');
  await mkdir(tools);
  // A versioned name, as on GitHub's macOS runners.
  assert.deepEqual(toolchainReads(path.join(versioned, 'Contents', 'Developer')), [versioned]);
  // xcode-select prints a trailing newline.
  assert.deepEqual(toolchainReads(`${path.join(root, 'Xcode.app', 'Contents', 'Developer')}\n`), [versioned]);
  // A symlinked bundle is allowed where it really is.
  assert.deepEqual(toolchainReads(path.join(root, 'Xcode.app', 'Contents', 'Developer')), [versioned]);
  // Command Line Tools sit under /Library, already readable: no bundle, nothing added.
  assert.deepEqual(toolchainReads(tools), []);
  assert.deepEqual(toolchainReads(path.join(root, 'notes.application', 'Developer')), []);
  for (const unusable of [undefined, '', 'Xcode.app/Contents/Developer', 42]) {
    assert.deepEqual(toolchainReads(unusable), [], String(unusable));
  }
  const profile = sandboxProfile({ write: ['/w'], read: [], network: false, toolchains: [versioned] });
  assert.match(profile, new RegExp(`\\(allow file-read\\* [^\\n]*\\(subpath "${versioned}"\\)`));
  assert.doesNotMatch(profile.split('\n').find((line) => line.startsWith('(allow file-write*')), /Xcode/);
});

test('the plugin reads the active developer directory once and puts its bundle in every profile', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-devdir-')));
  const bundle = path.join(root, 'Xcode-beta.app');
  await mkdir(path.join(bundle, 'Contents', 'Developer'), { recursive: true });
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  let asked = 0;
  const profiles = [];
  let registered;
  const plugin = createPlugin({}, {
    developerDir: () => { asked += 1; return `${path.join(bundle, 'Contents', 'Developer')}\n`; },
    spawn: (command, args) => { profiles.push(args[1]); throw new Error('not spawned in this test'); },
  });
  if (process.platform !== 'darwin') return;
  plugin.setup({
    executors: { register: (entry) => { registered = entry; } },
    workspaces: { forAgent: () => workspace, prepare: () => workspace, all: async () => [workspace] },
  });
  const session = { id: 's1', agent: { id: 'nova', name: 'Nova' }, status: 'running', messages: [] };
  for (let i = 0; i < 2; i += 1) {
    await registered.executor.execute({ id: `c${i}`, toolName: 'shell.run', input: { command: 'true' } }, shellIn(workspace), session);
  }
  assert.equal(asked, 1);
  assert.equal(profiles.length, 2);
  for (const profile of profiles) assert.match(profile, new RegExp(`\\(subpath "${bundle}"\\)`));
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
  // A HOME of the test's own: git refuses to run when ~/.gitconfig exists
  // but the sandbox can't read it, and this test is about the hook's walls,
  // not about the machine's git config.
  const home = path.join(workspace, 'home');
  await mkdir(home);
  const init = await run('git init -q app && cd app && git config user.name a && git config user.email a@b && echo 1 > f && git add f', undefined, { HOME: home });
  assert.equal(init.ok, true, init.out);
  const insideMarker = path.join(workspace, 'hook-ran-inside');
  await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > ${insideMarker}\necho ran > ${marker} 2>/dev/null\nexit 0\n`);
  await chmod(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
  const commit = await run('cd app && git commit -q -m m && git log --oneline | wc -l', undefined, { HOME: home });
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

test('the profile names each Mach service it allows instead of allowing every lookup', () => {
  const profile = sandboxProfile({ write: ['/w'], read: [], network: true });
  assert.doesNotMatch(profile, /\bmach-lookup(?! \(global-name ")/, 'a bare mach-lookup allows every service');
  assert.match(profile, /^\(allow mach-lookup [^\n]*\(global-name "com\.apple\.trustd"\)/m);
  assert.doesNotMatch(profile, /pasteboard|SecurityServer|securityd/);
  // Preferences go through cfprefsd outside the file rules; without it a
  // command reads only the plist files the profile lets it read.
  assert.doesNotMatch(profile, /cfprefsd/);
});

test('a command cannot read the clipboard or the keychain, and still resolves names and users', { skip: !onMac || !existsSync('/usr/bin/pbpaste') }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { run, root } = await setup();
  const before = execFileSync('/usr/bin/pbpaste');
  const marker = `sandbox-clipboard-probe-${process.pid}`;
  execFileSync('/usr/bin/pbcopy', { input: marker });
  const keychain = path.join(root, 'probe.keychain-db');
  try {
    // Control: the host reads both, so a refusal below is the wall.
    assert.equal(execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' }), marker);
    execFileSync('/usr/bin/security', ['create-keychain', '-p', 'probe', keychain]);
    execFileSync('/usr/bin/security', ['add-generic-password', '-a', 'probe', '-s', 'sandbox-probe', '-w', marker, '-A', keychain]);
    assert.equal(execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'sandbox-probe', '-w', keychain], { encoding: 'utf8' }).trim(), marker);

    const clipboard = await run('/usr/bin/pbpaste');
    assert.doesNotMatch(clipboard.out, new RegExp(marker));
    const secret = await run(`/usr/bin/security find-generic-password -s sandbox-probe -w '${keychain}'`);
    assert.doesNotMatch(secret.out, new RegExp(marker));
    const who = await run('/usr/bin/id -un');
    assert.equal(who.ok, true, who.out);
    assert.equal(who.out.trim(), os.userInfo().username);
  } finally {
    execFileSync('/usr/bin/pbcopy', { input: before });
    try { execFileSync('/usr/bin/security', ['delete-keychain', keychain]); } catch {}
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

test('a cwd or write path inside the workspace that was swapped for a symlink out of it is refused, not allowed', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-swap-')));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'home');
  await mkdir(workspace);
  await mkdir(outside);
  // An agent can do this between two calls: cd .. && rm -rf project && ln -s "$HOME" project
  const project = path.join(workspace, 'project');
  await symlink(outside, project);
  assert.throws(() => sandboxSettings({}, 'nova', workspace, project), /resolves outside/);
  assert.throws(() => sandboxSettings({ writePaths: [project] }, 'nova', workspace, undefined), /resolves outside/);
  // Through a symlinked workspace path too.
  const linked = path.join(root, 'linked');
  await symlink(workspace, linked);
  assert.throws(() => sandboxSettings({}, 'nova', linked, path.join(linked, 'project')), /resolves outside/);

  // A real directory inside the workspace is still fine, and adds nothing the workspace doesn't cover.
  const sub = path.join(workspace, 'sub');
  await mkdir(sub);
  assert.deepEqual(sandboxSettings({}, 'nova', workspace, sub).write, [workspace]);
  // A cwd the operator configured outside the workspace is still allowed where it is.
  assert.deepEqual(sandboxSettings({}, 'nova', workspace, outside).write, [workspace, outside]);

  // The same swap under a configured write path: the cwd lives in a writable repo folder.
  const code = path.join(root, 'code');
  await mkdir(code);
  const repo = path.join(code, 'repo');
  await symlink(outside, repo);
  assert.throws(() => sandboxSettings({ writePaths: [code] }, 'nova', workspace, repo), /resolves outside/);
  // ...and a real repo folder there is covered by the write path it's in.
  const real2 = path.join(code, 'real');
  await mkdir(real2);
  assert.deepEqual(sandboxSettings({ writePaths: [code] }, 'nova', workspace, real2).write, [workspace, code]);
});

test('the executor refuses a command whose cwd was swapped out of the workspace', { skip: !onMac }, async () => {
  const { workspace, outside } = await setup();
  const project = path.join(workspace, 'project');
  await symlink(outside, project);
  let registered;
  createPlugin({}).setup({
    executors: { register: (entry) => { registered = entry; } },
    workspaces: { forAgent: () => workspace, prepare: () => workspace, all: async () => [workspace] },
  });
  const session = { id: 's1', agent: { id: 'nova', name: 'Nova' }, status: 'running', messages: [] };
  const result = await registered.executor.execute({ id: 'c1', toolName: 'shell.run', input: { command: 'echo pwned > secret.txt' } }, shellIn(project), session);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'token\n');
});

test('a read path inside a writable path that was swapped for a symlink out of it is refused, not allowed', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-readswap-')));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'ssh');
  await mkdir(workspace);
  await mkdir(outside);
  const shared = path.join(workspace, 'shared');
  await symlink(outside, shared);
  assert.throws(() => sandboxSettings({ readPaths: [shared] }, 'nova', workspace, undefined), /resolves outside/);
  // A real folder there is fine, and one outside every writable path is read where it points.
  const real3 = path.join(root, 'workspace', 'docs');
  await mkdir(real3);
  assert.deepEqual(sandboxSettings({ readPaths: [real3] }, 'nova', workspace, undefined).read, [real3]);
  const link = path.join(root, 'opt-link');
  await symlink(outside, link);
  assert.deepEqual(sandboxSettings({ readPaths: [link] }, 'nova', workspace, undefined).read, [outside]);
});

test('with the network on, a command reaches TCP but not a Unix socket outside the sandbox', { skip: !onMac }, async () => {
  const net = await import('node:net');
  const { run, outside } = await setup();
  const socketPath = path.join(outside, 'd.sock');
  const unix = net.createServer((c) => c.end('UNIX-REACHED\n'));
  const tcp = net.createServer((c) => c.end('TCP-REACHED\n'));
  await new Promise((resolve) => unix.listen(socketPath, resolve));
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  try {
    const port = tcp.address().port;
    const viaTcp = await run(`/usr/bin/nc -w 2 127.0.0.1 ${port} </dev/null`);
    assert.match(viaTcp.out, /TCP-REACHED/, viaTcp.out);
    const viaUnix = await run(`/usr/bin/nc -w 2 -U '${socketPath}' </dev/null`);
    assert.doesNotMatch(viaUnix.out, /UNIX-REACHED/);
  } finally {
    unix.close();
    tcp.close();
  }
});

test('a command cannot read preferences through cfprefsd', { skip: !onMac }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { run } = await setup();
  const domain = `com.stratuslabs.sandbox-probe-${process.pid}`;
  const marker = `prefs-probe-${process.pid}`;
  execFileSync('/usr/bin/defaults', ['write', domain, 'k', marker]);
  try {
    assert.equal(execFileSync('/usr/bin/defaults', ['read', domain, 'k'], { encoding: 'utf8' }).trim(), marker);
    const read = await run(`/usr/bin/defaults read ${domain} k`);
    assert.doesNotMatch(read.out, new RegExp(marker));
  } finally {
    try { execFileSync('/usr/bin/defaults', ['delete', domain]); } catch {}
  }
});

test('the DNS broker is reachable only with the network on', () => {
  const on = sandboxProfile({ write: ['/w'], read: [], network: true });
  const off = sandboxProfile({ write: ['/w'], read: [], network: false });
  assert.match(on, /\(global-name "com\.apple\.dnssd\.service"\)/);
  assert.doesNotMatch(off, /dnssd/);
  assert.doesNotMatch(off, /mDNSResponder/);
});

test('POSIX shared memory is allowed by name, read-only, never as a whole', () => {
  const profile = sandboxProfile({ write: ['/w'], read: [], network: true });
  assert.doesNotMatch(profile, /ipc-posix-shm(?=[ )])(?!-)/, 'a bare ipc-posix-shm allows every object');
  assert.doesNotMatch(profile, /ipc-posix-shm-write/);
  assert.match(profile, /\(ipc-posix-name "apple\.shm\.notification_center"\)/);
});

test('a command cannot open shared memory another process of the same user created', { skip: !onMac || !existsSync('/usr/bin/python3') }, async () => {
  const { spawn } = await import('node:child_process');
  const { run } = await setup();
  const name = `/stratus-sbx-${process.pid}`;
  const host = [
    'import _posixshmem, os, mmap, sys, time',
    `name = ${JSON.stringify(name)}`,
    'fd = _posixshmem.shm_open(name, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)',
    'os.ftruncate(fd, 16)',
    'm = mmap.mmap(fd, 16)',
    'm[:9] = b"SHM-READ!"',
    'print("ready", flush=True)',
    'try:\n    sys.stdin.read()\nfinally:\n    _posixshmem.shm_unlink(name)',
  ].join('\n');
  const owner = spawn('/usr/bin/python3', ['-c', host], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => { owner.stdout.once('data', resolve); owner.once('exit', reject); });
    const probe = `/usr/bin/python3 -c 'import _posixshmem, os, mmap; fd = _posixshmem.shm_open("${name}", os.O_RDONLY, 0); print(bytes(mmap.mmap(fd, 16, prot=mmap.PROT_READ)[:9]))'`;
    const read = await run(probe);
    assert.doesNotMatch(read.out, /SHM-READ!/, read.out);
    assert.match(read.out, /Operation not permitted|PermissionError/, read.out);
  } finally {
    owner.stdin.end();
    await new Promise((resolve) => owner.once('exit', resolve));
  }
});
