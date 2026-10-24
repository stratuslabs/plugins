import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { clampBudget, nightAt } from './window.js';
import { SANDBOX_EXEC, experimentProfile, real } from './sandbox.js';
import { summarizeFile } from './summary.js';

/**
 * Runs each agent's experiment dreams in its window: at most `maxPerNight`
 * a night, in config order, one at a time per agent, each claimed durably
 * before its process starts and stopped at the window's end.
 */

export const TICK_MS = 60_000;
export const KILL_GRACE_MS = 30_000;
const REPORT_TIMEOUT_MS = 120_000;

const sizeOf = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};


export const createDreamer = ({
  agents,
  claims,
  stateDir,
  spawn,
  tools,
  guard,
  secrets,
  now = () => new Date(),
  log = () => {},
  warn = () => {},
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Is this pid still the experimenter we started on this path?
  owns = (pid, experimentPath) => {
    const ps = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return ps.status === 0 && ps.stdout.includes('overnight') && ps.stdout.includes(experimentPath);
  },
}) => {
  // The experimenter starts claude and bash as children: signal the group.
  const killGroup = (pid, signal) => {
    try {
      kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  const groupAlive = (pid) => {
    try {
      kill(-pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
  const POLL_MS = 250;
  const waitGone = async (pid, ms) => {
    for (let waited = 0; groupAlive(pid) && waited < ms; waited += POLL_MS) {
      await sleep(POLL_MS);
    }
    return !groupAlive(pid);
  };
  // Leftover groups from a previous daemon that would not die: the agent
  // starts nothing while one is alive, so two runs never share a path.
  const lingering = new Map();
  let recovering = Promise.resolve();
  const running = new Map();
  const said = new Set();
  let interval;
  let stopping = false;

  const once = (key, write, message) => {
    if (!said.has(key)) {
      said.add(key);
      write(message);
    }
  };

  const dirsFor = (agentId, experimentDir) => {
    const id = createHash('sha256').update(experimentDir).digest('hex').slice(0, 12);
    const root = path.join(stateDir(), 'agents', agentId, id);
    const dirs = { home: path.join(root, 'home'), tmp: path.join(root, 'tmp'), logs: path.join(root, 'logs') };
    for (const dir of Object.values(dirs)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dirs;
  };

  const childEnv = (dirs, apiKey) => ({
    PATH: tools.searchPath,
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    CLAUDE_CONFIG_DIR: path.join(dirs.home, '.claude'),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...(tools.pythonUserBase ? { PYTHONUSERBASE: tools.pythonUserBase } : {}),
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
  });

  const sandboxed = (experimentDir, dirs, argv) => [
    SANDBOX_EXEC,
    ['-p', experimentProfile({ experimentDir, home: dirs.home, tmp: dirs.tmp, read: tools.read, deny: tools.deny() }), tools.overnight, ...argv],
  ];

  const report = (experimentDir, dirs, env) => new Promise((resolve) => {
    const [command, args] = sandboxed(experimentDir, dirs, ['report', experimentDir]);
    const child = spawn(command, args, { cwd: experimentDir, env, stdio: 'ignore' });
    const timer = timers.setTimeout(() => child.kill('SIGKILL'), REPORT_TIMEOUT_MS);
    child.on('error', () => resolve(undefined));
    child.on('exit', (code) => {
      timers.clearTimeout(timer);
      resolve(code === 0 ? path.join(experimentDir, 'report.html') : undefined);
    });
  });

  const start = async (agentId, agent) => {
    const window = nightAt(agent.window, now());
    if (!window) {
      return;
    }
    const spent = claims.night(agentId, window.night);
    if (spent.length >= Math.min(agent.maxPerNight, agent.experiments.length)) {
      return;
    }
    // The claim's index is its order tonight; which experiment it is goes
    // by path, so a config reordered mid-night never reruns a spent one.
    const index = spent.length;
    const spentPaths = new Set(spent.map((claimed) => claimed.path));
    const experiment = agent.experiments.find((candidate) => !spentPaths.has(real(candidate.path)));
    if (!experiment) {
      return;
    }
    const budget = clampBudget(experiment.budgetSeconds, window.end, now());
    if (budget === undefined) {
      once(`${agentId}:${window.night}:short`, log, `dreams: ${agentId} night ${window.night}: too little of the window is left to start experiment ${index + 1}, so none runs tonight.`);
      return;
    }
    const experimentDir = real(experiment.path);
    const entry = { index, path: experimentDir, offset: sizeOf(path.join(experimentDir, 'experiments.jsonl')), budgetSeconds: budget, claimedAt: now().toISOString() };
    try {
      await guard(experimentDir);
    } catch (error) {
      claims.claim(agentId, window.night, { ...entry, result: { status: 'refused', reason: error.message } });
      warn(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} refused: ${error.message}`);
      return;
    }
    const apiKey = (await secrets())?.[agentId]?.anthropicApiKey;
    // The last await before the claim: a stop that came in while this start
    // was checking its path spends nothing and spawns nothing.
    if (stopping) {
      return;
    }
    const dirs = dirsFor(agentId, experimentDir);
    const env = childEnv(dirs, apiKey);
    const argv = ['run', experimentDir, '--budget', `${budget}s`, '--agent', 'claude', '--direction', experiment.direction,
      ...(experiment.maxExperiments ? ['--max-experiments', String(experiment.maxExperiments)] : [])];
    const [command, args] = sandboxed(experimentDir, dirs, argv);
    const logFile = path.join(dirs.logs, `${window.night}-${index + 1}.log`);

    // Spent before it runs: a daemon that dies after this line moves on to
    // the next experiment on restart and never replays this one.
    claims.claim(agentId, window.night, entry);

    const out = openSync(logFile, 'a', 0o600);
    let child;
    try {
      child = spawn(command, args, { cwd: experimentDir, env, detached: true, stdio: ['ignore', out, out] });
    } finally {
      closeSync(out);
    }
    claims.update(agentId, window.night, index, { pid: child.pid });
    log(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} started (${experimentDir}, budget ${budget}s, pid ${child.pid}).`);
    const run = { child, reason: undefined, killTimer: undefined };
    running.set(agentId, run);
    const terminate = (reason) => {
      if (run.reason) {
        return;
      }
      run.reason = reason;
      killGroup(child.pid, 'SIGTERM');
      run.killTimer = timers.setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    };
    run.terminate = terminate;
    const windowTimer = timers.setTimeout(() => terminate('stopped-at-window-end'), Math.max(0, window.end.getTime() - now().getTime()));
    run.done = new Promise((resolve) => {
      let finished = false;
      const finish = async (exitCode, signal, error) => {
        if (finished) {
          return;
        }
        finished = true;
        timers.clearTimeout(windowTimer);
        if (run.killTimer) {
          timers.clearTimeout(run.killTimer);
        }
        const reportPath = error || stopping ? undefined : await report(experimentDir, dirs, env);
        const summary = summarizeFile(path.join(experimentDir, 'experiments.jsonl'), entry.offset);
        claims.finish(agentId, window.night, index, {
          status: error ? 'failed-to-start' : run.reason ?? 'finished',
          ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}),
          ...(signal ? { signal } : {}),
          ...(error ? { error: error.message } : {}),
          endedAt: now().toISOString(),
          log: logFile,
          ...(reportPath ? { report: reportPath } : {}),
          summary,
        });
        log(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} ${error ? 'failed to start' : 'ended'}: ${summary.attempts} attempts, ${summary.kept} kept.`);
        running.delete(agentId);
        resolve();
        if (!stopping) {
          void tick();
        }
      };
      child.once('error', (error) => void finish(null, null, error));
      child.once('exit', (code, signal) => void finish(code, signal));
    });
  };

  const tick = async () => {
    await recovering;
    if (stopping) {
      return;
    }
    for (const [agentId, agent] of agents) {
      if (running.has(agentId)) {
        continue;
      }
      const leftover = lingering.get(agentId);
      if (leftover !== undefined) {
        if (groupAlive(leftover)) {
          continue;
        }
        lingering.delete(agentId);
      }
      if (stopping) {
        return;
      }
      const placeholder = { starting: undefined };
      running.set(agentId, placeholder);
      placeholder.starting = start(agentId, agent);
      try {
        await placeholder.starting;
      } catch (error) {
        once(`${agentId}:error:${error.message}`, warn, `dreams: ${agentId}: ${error.message}`);
      } finally {
        if (running.get(agentId) === placeholder) {
          running.delete(agentId);
        }
      }
    }
  };

  /**
   * A claim with no result is an experiment the last daemon did not see
   * end. Its process may still be running, detached: stop it if it is
   * still ours, then record what it got done.
   */
  const recover = async () => {
    for (const agentId of agents.keys()) {
      for (const [night, entries] of Object.entries(claims.nights(agentId))) {
        for (const entry of entries.filter((candidate) => !candidate.result)) {
          // The same stop as at the window's end: SIGTERM, the grace, then
          // SIGKILL, and wait for the group to be gone.
          if (entry.pid && owns(entry.pid, entry.path)) {
            killGroup(entry.pid, 'SIGTERM');
            if (!await waitGone(entry.pid, KILL_GRACE_MS)) {
              killGroup(entry.pid, 'SIGKILL');
              if (!await waitGone(entry.pid, KILL_GRACE_MS)) {
                lingering.set(agentId, entry.pid);
                warn(`dreams: ${agentId}: process group ${entry.pid} from a previous daemon survived SIGKILL; nothing starts for this agent until it is gone.`);
              }
            }
          }
          claims.finish(agentId, night, entry.index, {
            status: 'interrupted',
            endedAt: now().toISOString(),
            summary: summarizeFile(path.join(entry.path, 'experiments.jsonl'), entry.offset),
          });
          log(`dreams: ${agentId} night ${night}: experiment ${entry.index + 1} was interrupted by a daemon stop and is not run again tonight.`);
        }
      }
    }
  };

  return {
    running,
    tick,
    recover,
    begin() {
      stopping = false;
      recovering = recover().catch((error) => warn(`dreams: recovery failed: ${error.message}`));
      interval = timers.setInterval(() => void tick(), TICK_MS);
      interval.unref?.();
      return tick();
    },
    async stop() {
      stopping = true;
      if (interval) {
        timers.clearInterval(interval);
      }
      const terminateAll = () => {
        const runs = [...running.values()].filter((run) => run.child);
        for (const run of runs) {
          run.terminate('stopped-by-daemon');
        }
        return runs;
      };
      const runs = terminateAll();
      // A start still checking its path finishes before stop returns: it
      // sees stopping and spawns nothing. Anything it did spawn is stopped too.
      await Promise.allSettled([...running.values()].filter((run) => run.starting).map((run) => run.starting));
      await Promise.all([...runs, ...terminateAll()].map((run) => run.done));
    },
  };
};
