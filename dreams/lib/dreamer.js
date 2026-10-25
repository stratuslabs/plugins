import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { startKeyProxy } from './keyproxy.js';
import { clampBudget, nightAt } from './window.js';
import { SANDBOX_EXEC, experimentProfile, real } from './sandbox.js';
import { summarizeFile } from './summary.js';
import { LOCK_BUSY, TETHER, isLocked } from './tether.js';

/**
 * Runs each agent's experiment dreams in its window: at most `maxPerNight`
 * a night, in config order, one at a time per agent and per experiment
 * directory, each claimed durably before its process starts and stopped,
 * with its whole process group, at the window's end.
 *
 * A run never outlives the daemon: it runs under lib/tether.js, which
 * stops its group when the daemon's pipe to it closes. A restart finds
 * claims with no result, records them as interrupted and moves on; it has
 * nothing to find, signal or adopt.
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
  keyProxy = startKeyProxy,
}) => {
  // Experiment directories (real paths) with a run in them, across agents:
  // two runs in one directory would share workspace/ and experiments.jsonl.
  const busy = new Set();
  const running = new Map();
  // Agents with a claim from the last daemon whose run may still be stopping.
  const waiting = new Set();
  const said = new Set();
  let interval;
  let stopping = false;

  const once = (key, write, message) => {
    if (!said.has(key)) {
      said.add(key);
      write(message);
    }
  };

  // One lock per experiment directory, held by its run's tether: a run
  // from a daemon that just died keeps the directory until it is gone.
  const lockFor = (experimentDir) => {
    const dir = path.join(stateDir(), 'locks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${createHash('sha256').update(experimentDir).digest('hex').slice(0, 12)}.lock`);
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

  // Under a tether like the run: on the directory's lock, gone with the
  // daemon, and its whole group stopped at the timeout.
  const tethered = (lockFile, command, args) => [process.execPath, [TETHER, lockFile, String(KILL_GRACE_MS), '--', command, ...args]];

  const report = (experimentDir, dirs, env) => new Promise((resolve) => {
    const [command, args] = tethered(lockFor(experimentDir), ...sandboxed(experimentDir, dirs, ['report', experimentDir]));
    const child = spawn(command, args, { cwd: experimentDir, env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin?.on('error', () => {});
    const timer = timers.setTimeout(() => child.stdin.end(), REPORT_TIMEOUT_MS);
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
      // Another agent is running it: wait.
      return;
    }
    if (isLocked(lockFor(experimentDir))) {
      once(`${experimentDir}:locked`, log, `dreams: a run from an earlier daemon is still stopping in ${experimentDir}; waiting for it.`);
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
    const lockFile = lockFor(experimentDir);
    const logFile = path.join(dirs.logs, `${window.night}-${index + 1}.log`);

    // Spent before it runs: a daemon that dies after this line moves on to
    // the next experiment on restart and never replays this one.
    claims.claim(agentId, window.night, entry);

    let out;
    let child;
    try {
      // Inside the try: a log that can't be opened is recorded tonight,
      // not left looking like a run until the next restart.
      out = openSync(logFile, 'a', 0o600);
      // The tether's stdin is a pipe this daemon never writes to: when the
      // daemon is gone, it closes, and the tether stops the run.
      child = spawn(...tethered(lockFile, command, args), { cwd: experimentDir, env, stdio: ['pipe', out, out] });
    } catch (error) {
      claims.finish(agentId, window.night, index, { status: 'failed-to-start', error: error.message, endedAt: now().toISOString(), log: logFile });
      throw error;
    } finally {
      if (out !== undefined) {
        closeSync(out);
      }
    }
    // Nothing is ever written; an EPIPE after the tether exits is expected.
    child.stdin?.on('error', () => {});
    log(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} started (${experimentDir}, budget ${budget}s).`);
    const run = { child, reason: undefined };
    running.set(agentId, run);
    const terminate = (reason) => {
      if (run.reason || run.exited) {
        return;
      }
      run.reason = reason;
      // Closing the pipe asks the tether to stop the group (SIGTERM, the
      // grace, then SIGKILL). Unlike a signal, it can't arrive before the
      // tether is listening: the close waits in the pipe until it reads.
      child.stdin.end();
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
        try {
          // The tether exits only once the whole group has, so the proxy
          // token is worthless by the time it closes.
          await proxy.close();
          if (exitCode === LOCK_BUSY) {
            error = new Error(`a run from an earlier daemon still holds ${experimentDir}`);
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
        } catch (failure) {
          // A full disk or an unreadable log must not leave the agent and
          // the directory held, or a daemon stop waiting, forever.
          warn(`dreams: ${agentId} night ${window.night}: experiment ${index + 1} ended, but recording it failed: ${failure.message}`);
        }
        // Free the directory only after the report and summary have read it.
        busy.delete(experimentDir);
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
    if (stopping) {
      return;
    }
    if (waiting.size > 0) {
      recover([...waiting]);
    }
    for (const [agentId, agent] of agents) {
      if (running.has(agentId) || waiting.has(agentId)) {
        continue;
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
   * end. Its tether stops it when that daemon goes away, but that takes up
   * to two graces, and the run can still write until then. So while its
   * directory's lock is held, the claim waits and the agent starts nothing
   * else; each tick looks again. Once the lock is free, it is recorded with
   * what it got done. Claims that cannot be read stay unread: that agent's
   * next start reads them again and refuses, so it never reruns a spent one.
   */
  const recover = (agentIds = [...agents.keys()]) => {
    for (const agentId of agentIds) {
      // Held until this agent's claims are known to be settled, so a check
      // that throws keeps it waiting rather than letting it start.
      waiting.add(agentId);
      // One agent's unreadable claims or full disk does not stop the rest.
      try {
        let stillHeld = false;
        for (const [night, entries] of Object.entries(claims.nights(agentId))) {
          for (const entry of entries.filter((candidate) => !candidate.result)) {
            if (isLocked(lockFor(entry.path))) {
              stillHeld = true;
              once(`${agentId}:${night}:${entry.index}:held`, log, `dreams: ${agentId} night ${night}: experiment ${entry.index + 1} from the last daemon is still stopping; waiting for it.`);
              continue;
            }
            claims.finish(agentId, night, entry.index, {
              status: 'interrupted',
              endedAt: now().toISOString(),
              summary: summarizeFile(path.join(entry.path, 'experiments.jsonl'), entry.offset),
            });
            log(`dreams: ${agentId} night ${night}: experiment ${entry.index + 1} was interrupted by a daemon stop and is not run again tonight.`);
          }
        }
        if (!stillHeld) {
          waiting.delete(agentId);
        }
      } catch (error) {
        once(`${agentId}:recover:${error.message}`, warn, `dreams: ${agentId}: ${error.message}`);
      }
    }
  };

  return {
    running,
    tick,
    recover,
    begin() {
      stopping = false;
      try {
        recover();
      } catch (error) {
        warn(`dreams: recovery failed: ${error.message}`);
      }
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
