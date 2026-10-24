import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TETHER, isLocked } from '../lib/tether.js';

// Real processes: the tether, a shell under it, and a stray the shell
// leaves behind in the group.

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'dreams-tether-'));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const until = async (predicate, ms = 5000) => {
  for (let waited = 0; waited < ms; waited += 25) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

// Resolves to how the child ended, or to 'still running' after ms.
const exited = (child, ms = 5000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve('still running'), ms);
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});

// The shell writes its own pid and its stray's to pids, then waits.
const strayScript = (pids, leaderExits = false) =>
  `sleep 300 & echo "$$ $!" > ${pids}; ${leaderExits ? 'exit 3' : 'wait'}`;

const readPids = async (file) => {
  await until(() => {
    try {
      return readFileSync(file, 'utf8').trim().split(' ').length === 2;
    } catch {
      return false;
    }
  });
  return readFileSync(file, 'utf8').trim().split(' ').map(Number);
};

const tether = (dir, script, grace = '200') =>
  spawn(process.execPath, [TETHER, path.join(dir, 'run.lock'), grace, '--', '/bin/sh', '-c', script], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });

test('closing the pipe from the daemon ends the whole group', async () => {
  const dir = tmp();
  const pids = path.join(dir, 'pids');
  const child = tether(dir, strayScript(pids));
  const [shell, stray] = await readPids(pids);
  const done = exited(child);
  child.stdin.end();
  assert.notEqual(await done, 'still running');
  assert.ok(await until(() => !alive(shell) && !alive(stray)), 'the shell and its stray are gone');
});

test('a daemon killed with SIGKILL takes its runs with it', async () => {
  const dir = tmp();
  const pids = path.join(dir, 'pids');
  const tetherPid = path.join(dir, 'tether-pid');
  // A stand-in daemon: starts a tether, records its pid, and waits.
  const daemon = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const t = spawn(process.execPath, ${JSON.stringify([TETHER, path.join(dir, 'run.lock'), '200', '--', '/bin/sh', '-c', strayScript(pids)])}, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    require('node:fs').writeFileSync(${JSON.stringify(tetherPid)}, String(t.pid));
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
  const [shell, stray] = await readPids(pids);
  const leader = Number(readFileSync(tetherPid, 'utf8'));
  daemon.kill('SIGKILL');
  assert.ok(await until(() => !alive(leader) && !alive(shell) && !alive(stray)), 'the tether, the shell and its stray are gone');
});

test('a leader that exits leaving a stray: the group is swept, then the tether exits with its code', async () => {
  const dir = tmp();
  const pids = path.join(dir, 'pids');
  const child = tether(dir, strayScript(pids, true));
  const done = exited(child);
  const [, stray] = await readPids(pids);
  assert.deepEqual(await done, { code: 3, signal: null });
  assert.equal(alive(stray), false, 'the stray was stopped before the tether exited');
  child.stdin.end();
});

test('SIGTERM from the daemon stops the group, and the tether exits by the leader\'s signal', async () => {
  const dir = tmp();
  const pids = path.join(dir, 'pids');
  const child = tether(dir, strayScript(pids));
  await readPids(pids);
  const done = exited(child);
  process.kill(child.pid, 'SIGTERM');
  assert.deepEqual(await done, { code: null, signal: 'SIGTERM' });
  child.stdin.end();
});

test('the run lock is held for the life of the tether, and a second tether on it refuses to start', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'run.lock');
  assert.equal(isLocked(lock), false, 'no lock file yet reads as free');
  const pids = path.join(dir, 'pids');
  const first = tether(dir, strayScript(pids));
  await readPids(pids);
  assert.equal(isLocked(lock), true);
  const second = tether(dir, 'echo ran > ' + path.join(dir, 'second'));
  assert.deepEqual(await exited(second), { code: 75, signal: null });
  assert.throws(() => readFileSync(path.join(dir, 'second')), /ENOENT/, 'its command never ran');
  second.stdin.end();
  const done = exited(first);
  first.stdin.end();
  assert.notEqual(await done, 'still running');
  assert.ok(await until(() => !isLocked(lock)), 'the lock is free once the tether is gone');
});
