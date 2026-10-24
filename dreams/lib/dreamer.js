import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { startKeyProxy } from './keyproxy.js';
import { clampBudget, nightAt } from './window.js';
import { SANDBOX_EXEC, experimentProfile, real } from './sandbox.js';
import { summarizeFile } from './summary.js';

/**
 * Runs each agent's experiment dreams in its window: at most `maxPerNight`
 * a night, in config order, one at a time per agent and per experiment
 * directory, each claimed durably before its process starts and stopped,
 * with its whole process group, at the window's end.
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
  keyProxy = startKeyProxy,
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
  // SIGTERM, the grace, SIGKILL, the grace: true once the group is gone.
  const stopGroup = async (pid) => {
    killGroup(pid, 'SIGTERM');
    if (await waitGone(pid, KILL_GRACE_MS)) {
      return true;
    }
    killGroup(pid, 'SIGKILL');
    return waitGone(pid, KILL_GRACE_MS);
  };
  // Groups that would not die, from a previous daemon or left behind by a
  // leader that exited: the agent starts nothing while one is alive, and
  // its experiment directory stays busy.
  const lingering = new Map();
  // Experiment directories (real paths) with a run in them, across agents:
  // two runs in one directory would share workspace/ and experiments.jsonl.
  const busy = new Set();
  // Agents whose claims could not be read at startup: they start nothing.
  const unrecovered = new Set();
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

  // ANTHROPIC_API_KEY here is the run's proxy token, never the real key.
  const childEnv = (dirs, proxy) => ({
    PATH: tools.searchPath,
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    CLAUDE_CONFIG_DIR: path.join(dirs.home, '.claude'),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...(tools.pythonUserBase ? { PYTHONUSERBASE: tools.pythonUserBase } : {}),
    ANTHROPIC_BASE_URL: proxy.baseUrl,
    ANTHROPIC_API_KEY: proxy.token,
  });

  const sandboxed = (experimentDir, dirs, argv) => [
    SANDBOX_EXEC,
    ['-p', experimentProfile({ experimentDir, home: dirs.home, tmp: dirs.tmp, read: tools.read, deny: tools.deny() }), tools.overnight, ...argv],
  ];

  const report = (experimentDir, dirs, env) => new Promise((resolve) => {
    const [command, args] = sandboxed(experimentDir, dirs, ['report', experimentDir]);
    const child = spawn(command, args, { cwd: experimentDir, env, stdio: 'ignore' });
    const timer = timers.setTimeout(() => child.kill('SIGKILL'), REPORT_TIMEOUT_MS);
    child.on('error', () => {
      timers.clearTimeout(timer);
      resolve(undefined);
    });
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
    if (busy.has(experimentDir)) {
      // Another agent is running it, or left a group behind in it: wait.
      return;
    }
    busy.add(experimentDir);
    let handedOff = false;
    try {
      handedOff = await launch(agentId, window, index, experiment, experimentDir, budget);
    } finally {
      if (!handedOff) {
        busy.delete(experimentDir);
      }
    }
  };

  /** True once a process is running and owns the directory's busy mark. */
  const launch = async (agentId, window, index, experiment, experimentDir, budget) => {
    const apiKey = (await secrets())?.[agentId]?.anthropicApiKey;
    if (!apiKey) {
      // Login mode is refused: a login in the run's config directory is as
      // readable to evaluate.sh as a key in its environment.
      once(`${agentId}:nokey`, warn, `dreams: ${agentId}: no Anthropic key is stored for this agent's dreams, so none run. Store one with: stratus channel set dreams --agent ${agentId} anthropicApiKey`);
      return false;
    }
    const entry = { index, path: experimentDir, offset: sizeOf(path.join(experimentDir, 'experiments.jsonl')), budgetSeconds: budget, claimedAt: now().toISOString() };
    try {
      await guard(experimentDir);
    } catch (error) {
      claims.claim(agentId, window.night, { ...entry, result: { status: 'refused', reason: error.message } });
      warn(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} refused: ${error.message}`);
      return false;
    }
    const proxy = await keyProxy({ apiKey });
    let child;
    try {
      child = await setUp(agentId, window, index, experiment, experimentDir, budget, entry, proxy);
    } catch (error) {
      await proxy.close();
      throw error;
    }
    if (child === undefined) {
      await proxy.close();
      return false;
    }
    return true;
  };

  /**
   * Everything between opening the run's key proxy and handing it to a
   * running process. It returns the child, or undefined when a stop came in
   * first; its caller closes the proxy whenever no child got it.
   */
  const setUp = async (agentId, window, index, experiment, experimentDir, budget, entry, proxy) => {
    // The last await before the claim: a stop that came in while this start
    // was checking its path spends nothing and spawns nothing.
    if (stopping) {
      return undefined;
    }
    // The key, the guard and the proxy all awaited: the window may have
    // closed, or shrunk, since the budget was cut.
    budget = clampBudget(experiment.budgetSeconds, window.end, now());
    if (budget === undefined) {
      once(`${agentId}:${window.night}:short`, log, `dreams: ${agentId} night ${window.night}: too little of the window is left to start experiment ${index + 1}, so none runs tonight.`);
      return undefined;
    }
    entry.budgetSeconds = budget;
    const dirs = dirsFor(agentId, experimentDir);
    const env = childEnv(dirs, proxy);
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
    } catch (error) {
      claims.finish(agentId, window.night, index, { status: 'failed-to-start', error: error.message, endedAt: now().toISOString(), log: logFile });
      throw error;
    } finally {
      closeSync(out);
    }
    claims.update(agentId, window.night, index, { pid: child.pid });
    log(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} started (${experimentDir}, budget ${budget}s, pid ${child.pid}).`);
    const run = { child, reason: undefined, killTimer: undefined };
    running.set(agentId, run);
    const terminate = (reason) => {
      // Once the leader has exited, finish() owns the group: its pid may be
      // reused when the group is gone, so nothing else signals it.
      if (run.reason || run.exited) {
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
        run.exited = true;
        timers.clearTimeout(windowTimer);
        if (run.killTimer) {
          timers.clearTimeout(run.killTimer);
        }
        // The leader is gone, but code evaluate.sh started may not be: the
        // run, and its proxy token, end only when the whole group has.
        let strays;
        if (!error && groupAlive(child.pid)) {
          strays = await stopGroup(child.pid) ? 'stopped' : 'survived';
          if (strays === 'survived') {
            lingering.set(agentId, { pid: child.pid, path: experimentDir });
            warn(`dreams: ${agentId}: process group ${child.pid} outlived its experimenter and survived SIGKILL; nothing starts for this agent or in ${experimentDir} until it is gone.`);
          }
        }
        await proxy.close();
        const reportPath = error || stopping ? undefined : await report(experimentDir, dirs, env);
        const summary = summarizeFile(path.join(experimentDir, 'experiments.jsonl'), entry.offset);
        claims.finish(agentId, window.night, index, {
          status: error ? 'failed-to-start' : run.reason ?? 'finished',
          ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}),
          ...(signal ? { signal } : {}),
          ...(error ? { error: error.message } : {}),
          ...(strays ? { strays } : {}),
          endedAt: now().toISOString(),
          log: logFile,
          ...(reportPath ? { report: reportPath } : {}),
          summary,
        });
        log(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} ${error ? 'failed to start' : 'ended'}: ${summary.attempts} attempts, ${summary.kept} kept.`);
        // Free the directory only after the report and summary have read it.
        if (strays !== 'survived') {
          busy.delete(experimentDir);
        }
        running.delete(agentId);
        resolve();
        if (!stopping) {
          void tick();
        }
      };
      child.once('error', (error) => void finish(null, null, error));
      child.once('exit', (code, signal) => void finish(code, signal));
    });
    return child;
  };

  const tick = async () => {
    await recovering;
    if (stopping) {
      return;
    }
    for (const [agentId, agent] of agents) {
      if (running.has(agentId) || unrecovered.has(agentId)) {
        continue;
      }
      const leftover = lingering.get(agentId);
      if (leftover !== undefined) {
        if (groupAlive(leftover.pid)) {
          continue;
        }
        lingering.delete(agentId);
        busy.delete(leftover.path);
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

  const recoverOne = async (agentId, night, entry) => {
    // The same stop as at the window's end: SIGTERM, the grace, then
    // SIGKILL, and wait for the group to be gone.
    if (entry.pid && owns(entry.pid, entry.path) && !await stopGroup(entry.pid)) {
      lingering.set(agentId, { pid: entry.pid, path: entry.path });
      busy.add(entry.path);
      warn(`dreams: ${agentId}: process group ${entry.pid} from a previous daemon survived SIGKILL; nothing starts for this agent or in ${entry.path} until it is gone.`);
    }
    claims.finish(agentId, night, entry.index, {
      status: 'interrupted',
      endedAt: now().toISOString(),
      summary: summarizeFile(path.join(entry.path, 'experiments.jsonl'), entry.offset),
    });
    log(`dreams: ${agentId} night ${night}: experiment ${entry.index + 1} was interrupted by a daemon stop and is not run again tonight.`);
  };

  /**
   * A claim with no result is an experiment the last daemon did not see
   * end. Its process may still be running, detached: stop it if it is
   * still ours, then record what it got done. A claim that fails to
   * recover does not stop the others: its agent is blocked while the
   * claim's group is alive, and the next daemon tries the claim again.
   */
  const recover = async () => {
    for (const agentId of agents.keys()) {
      let nights;
      try {
        nights = Object.entries(claims.nights(agentId));
      } catch (error) {
        unrecovered.add(agentId);
        warn(`dreams: ${agentId}: recovery failed, nothing starts for this agent until the daemon restarts: ${error.message}`);
        continue;
      }
      for (const [night, entries] of nights) {
        for (const entry of entries.filter((candidate) => !candidate.result)) {
          try {
            await recoverOne(agentId, night, entry);
          } catch (error) {
            if (entry.pid && groupAlive(entry.pid)) {
              lingering.set(agentId, { pid: entry.pid, path: entry.path });
              busy.add(entry.path);
            }
            warn(`dreams: ${agentId} night ${night}: recovery of experiment ${entry.index + 1} failed: ${error.message}`);
          }
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
      // Recovery may still be stopping an old group; it is not in running.
      await recovering;
      // A start still checking its path finishes before stop returns: it
      // sees stopping and spawns nothing. Anything it did spawn is stopped too.
      await Promise.allSettled([...running.values()].filter((run) => run.starting).map((run) => run.starting));
      await Promise.all([...runs, ...terminateAll()].map((run) => run.done));
    },
  };
};
