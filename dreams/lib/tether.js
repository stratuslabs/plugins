#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Ties a run's life to the daemon that started it. The daemon starts this
 * script as the leader of a new process group, with a pipe on its stdin
 * that the daemon never writes to. The script runs the experiment in the
 * same group and:
 *
 * - when the pipe closes (the daemon's stop closes it, and so does a
 *   daemon that crashed or was killed), or on SIGTERM, stops the whole
 *   group: SIGTERM, the grace, then SIGKILL;
 * - when the experiment's leader exits, stops whatever it left in the
 *   group, then exits the way the leader did;
 * - holds the experiment's run lock while it lives, so a run left over
 *   from a daemon that just died keeps a new one out of its directory
 *   until it is gone. A second tether on a held lock exits 75 and runs
 *   nothing.
 *
 * Nothing outlives the daemon, so nothing has to be found and adopted
 * after a restart. Code in the sandbox cannot signal this script: the
 * profile only allows signals within the sandbox.
 *
 * Usage: tether.js <lock-file> <grace-ms> -- <command> [args...]
 */

export const TETHER = fileURLToPath(import.meta.url);
export const LOCK_BUSY = 75;

// macOS open(2) flags Node does not name. The plugin refuses Linux.
const O_EXLOCK = 0x20;
const lockFlags = constants.O_RDWR | O_EXLOCK | constants.O_NONBLOCK;

/** True while a live tether holds this lock. */
export const isLocked = (lockFile) => {
  let fd;
  try {
    fd = openSync(lockFile, lockFlags);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') {
      return true;
    }
    throw error;
  }
  closeSync(fd);
  return false;
};

const POLL_MS = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async (argv) => {
  const split = argv.indexOf('--');
  const [lockFile, graceArg] = argv.slice(0, split);
  const [command, ...args] = argv.slice(split + 1);
  const grace = Number(graceArg);
  if (split !== 2 || !lockFile || !Number.isFinite(grace) || !command) {
    process.stderr.write('usage: tether.js <lock-file> <grace-ms> -- <command> [args...]\n');
    process.exit(64);
  }

  try {
    // Held until this process exits; children do not inherit it.
    openSync(lockFile, lockFlags | constants.O_CREAT, 0o600);
  } catch (error) {
    if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') {
      process.stderr.write(`dreams: a run from an earlier daemon is still in this experiment (${lockFile}); not starting.\n`);
      process.exit(LOCK_BUSY);
    }
    throw error;
  }

  // Every way to ask for a stop is listened for before anything is started:
  // a SIGTERM that landed between the spawn and its handler would kill
  // only this script and leave the group running with nobody watching it.
  let group;
  let requested = false;
  let stopping;
  const groupAlive = () => {
    if (group === undefined) {
      return false;
    }
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
  const signalGroup = (signal) => {
    try {
      process.kill(-group, signal);
    } catch {
      // Already gone.
    }
  };
  const waitGone = async (ms) => {
    for (let waited = 0; groupAlive() && waited < ms; waited += POLL_MS) {
      await sleep(POLL_MS);
    }
    return !groupAlive();
  };
  // SIGTERM, the grace, SIGKILL, the grace. Asked before the spawn, it is
  // remembered, and the spawn never happens.
  const stopGroup = () => {
    requested = true;
    if (group === undefined) {
      return Promise.resolve();
    }
    stopping ??= (async () => {
      if (!groupAlive()) {
        return;
      }
      signalGroup('SIGTERM');
      if (await waitGone(grace)) {
        return;
      }
      signalGroup('SIGKILL');
      if (!await waitGone(grace)) {
        process.stderr.write(`dreams: process group ${group} survived SIGKILL.\n`);
      }
    })();
    return stopping;
  };

  // The daemon closes the pipe to ask for a stop, and a daemon that is
  // gone closes it too. SIGTERM does the same.
  process.on('SIGTERM', () => void stopGroup());
  process.on('SIGHUP', () => {});
  process.on('SIGINT', () => {});
  for (const event of ['end', 'close', 'error']) {
    process.stdin.on(event, () => void stopGroup());
  }
  process.stdin.resume();
  // Give a close that was already waiting in the pipe its turn.
  await new Promise((resolve) => setImmediate(resolve));
  if (requested) {
    process.exit(128 + 15);
  }

  // The experiment leads a group of its own, so this script can tell
  // whether anything in it is still alive without counting itself.
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  group = child.pid;
  const leaderExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => {
      process.stderr.write(`dreams: could not start ${command}: ${error.message}\n`);
      resolve({ code: 127, signal: null });
    });
  });
  if (requested) {
    void stopGroup();
  }

  const { code, signal } = await leaderExit;
  // Whatever the leader left behind goes with it.
  await stopGroup();
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
};

// Run as a script, not when the daemon imports TETHER and isLocked.
const invoked = () => {
  try {
    return realpathSync(process.argv[1]) === TETHER;
  } catch {
    return false;
  }
};
if (invoked()) {
  await main(process.argv.slice(2));
}
