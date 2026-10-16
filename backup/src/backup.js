// init, now, status and allow: everything except restore and the timer.
//
// The backup's own state lives in <home>/backup/: settings.json (the remote,
// the branch, allowed findings), status.json (the last run), and repo/, a
// bare clone that holds the history. None of it is ever in a snapshot.

import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BRANCH_PATTERN, commitSnapshot, git, initRepository, localRef, push, revParse, syncWithRemote } from './git.js';
import { KEY_PATTERNS, REDACTED, collectKnownSecrets, needlesFor, redactBuffer, scanBuffer } from './secrets.js';
import { buildSnapshot } from './snapshot.js';

export const backupDir = (home) => path.join(home, 'backup');
const settingsFile = (home) => path.join(backupDir(home), 'settings.json');
const statusFile = (home) => path.join(backupDir(home), 'status.json');
export const repoDir = (home) => path.join(backupDir(home), 'repo');

const writeJson = async (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
};

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`${file} could not be read: ${error.message}`);
  }
};

export const readSettings = async (home) => {
  const settings = await readJson(settingsFile(home));
  if (!settings) throw new Error('Backups are not set up on this machine. Run `stratus-backup init <remote>` first.');
  return { allow: [], ...settings };
};

export const defaultBranch = () => {
  const name = os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '');
  return name || 'home';
};

/** owner/name for a github.com remote, in any of the URL forms git accepts. */
export const githubRepoOf = (remote) => {
  const match = /^(?:(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remote);
  return match ? `${match[1]}/${match[2]}` : undefined;
};

/** True when the remote's host is github.com, whether or not its path parses. */
const pointsAtGithub = (remote) => /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com(?:[:/]|$)/i.test(remote);

/**
 * Refuses a GitHub repository anyone can read. The check is unauthenticated
 * on purpose: if GitHub answers it without credentials, so it would for
 * anyone. Run before every push, since a repository can be made public later.
 */
export const assertNotPublic = async (remote, fetchImpl = globalThis.fetch) => {
  const repo = githubRepoOf(remote);
  if (repo === undefined) {
    if (pointsAtGithub(remote)) throw new Error('Could not tell which GitHub repository the remote names, so could not confirm it is private. Nothing was pushed.');
    return;
  }
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}`, { headers: { 'user-agent': 'stratus-backup' } });
  } catch (error) {
    throw new Error(`Could not confirm ${repo} is private (${error.message}). Nothing was pushed.`);
  }
  if (response.status === 404) return;
  if (response.status === 200) {
    throw new Error(`${repo} is a public repository. A backup holds souls and memories; use a private repository. Nothing was pushed.`);
  }
  throw new Error(`Could not confirm ${repo} is private (GitHub answered ${response.status}). Nothing was pushed.`);
};

/**
 * Every URL git may actually use for the remote: as written, after git's
 * url.<base>.insteadOf rewrites, and, once the repository exists, origin's
 * fetch and push URLs (pushInsteadOf included).
 */
const urlsGitUses = async (remote, repo) => {
  const urls = new Set([remote]);
  const add = (result) => {
    const url = result.stdout.trim();
    if (result.code === 0 && url) urls.add(url);
  };
  add(await git(os.devNull, ['ls-remote', '--get-url', remote], { allowFailure: true, env: { GIT_DIR: undefined } }));
  if (repo !== undefined) {
    add(await git(repo, ['remote', 'get-url', 'origin'], { allowFailure: true }));
    add(await git(repo, ['remote', 'get-url', '--push', 'origin'], { allowFailure: true }));
  }
  return [...urls];
};

const assertNoneArePublic = async (remote, repo, fetchImpl) => {
  for (const url of await urlsGitUses(remote, repo)) await assertNotPublic(url, fetchImpl);
};

export const init = async (home, remote, { branch = defaultBranch(), fetchImpl } = {}) => {
  if (!BRANCH_PATTERN.test(branch)) throw new Error(`${JSON.stringify(branch)} is not a usable branch name.`);
  await assertNoneArePublic(remote, undefined, fetchImpl);
  await mkdir(backupDir(home), { recursive: true, mode: 0o700 });
  const previous = await readJson(settingsFile(home));
  const repo = repoDir(home);
  await initRepository(repo, remote);
  let existing;
  try {
    await assertNoneArePublic(remote, repo, fetchImpl);
    ({ remote: existing } = await syncWithRemote(repo, branch));
  } catch (error) {
    // Settings are not changed, so origin must not be either: put back the
    // remote the settings still name, so later runs push where they check.
    if (previous?.remote) await initRepository(repo, previous.remote).catch(() => {});
    throw error;
  }
  await writeJson(settingsFile(home), { remote, branch, allow: previous?.allow ?? [] });
  return { branch, adopted: existing !== undefined };
};

const lockText = async (file) => readFile(file, 'utf8').catch(() => '');

/** Creates file holding this pid, all at once, or fails with EEXIST: never an empty lock. */
const createLock = async (file) => {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, String(process.pid), { mode: 0o600 });
  try {
    await link(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
};

const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * Removes the lock only if it still names the dead pid that was read, under
 * a second lock, so two runs that both found the same stale lock cannot
 * delete each other's fresh one.
 */
const reclaimStale = async (file, seen) => {
  const guard = `${file}.reclaim`;
  try {
    await createLock(guard);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = Number((await lockText(guard)).trim());
    if (isAlive(holder)) throw new Error(`Another backup is running (pid ${holder}).`);
    // Left by a run that died mid-takeover: clear it and let the caller try again.
    await rm(guard, { force: true });
    return;
  }
  try {
    if ((await lockText(file)) === seen) await rm(file, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
};

/** One run at a time. A lock left by a process that is gone is taken over. */
export const takeLock = async (home, { onStale } = {}) => {
  const file = path.join(backupDir(home), 'run.lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await createLock(file);
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const seen = await lockText(file);
      const pid = Number(seen.trim());
      if (isAlive(pid)) throw new Error(`Another backup is running (pid ${pid}).`);
      await onStale?.();
      await reclaimStale(file, seen);
    }
  }
  throw new Error('Could not take the backup lock.');
};

export class FindingsError extends Error {
  constructor(findings) {
    const lines = findings.map((finding) => `  ${finding.file}:${finding.line}  ${finding.kind}  (id ${finding.id})`);
    super(
      'Found text shaped like a secret, so nothing was committed or pushed:\n'
        + `${lines.join('\n')}\n`
        + 'Remove it at the source (for a memory, have the agent forget it). '
        + 'If one is not a secret, run `stratus-backup allow <id>`.',
    );
    this.findings = findings;
  }
}

/**
 * A path is committed as written, so it is checked as well as the bytes. A
 * known secret in a path cannot be replaced without breaking restore, so it
 * stops the run; the message shows the path with the secret replaced.
 */
const assertPathsHoldNoKnownSecret = (entries, needles) => {
  const leaking = entries
    .map((entry) => redactBuffer(Buffer.from(entry.path), needles))
    .filter(({ count }) => count > 0)
    .map(({ buffer }) => `  ${buffer.toString()}`);
  if (leaking.length > 0) {
    throw new Error(
      'A file name holds a stored secret, so nothing was committed or pushed:\n'
        + `${leaking.join('\n')}\n`
        + 'Rename the file so its name does not hold the secret.',
    );
  }
};

/** Key-shaped text in a path. The finding names the path with the match replaced. */
const scanPath = (entryPath) => {
  const findings = scanBuffer(entryPath, Buffer.from(entryPath));
  if (findings.length === 0) return [];
  let shown = entryPath;
  for (const [, pattern] of KEY_PATTERNS) shown = shown.replace(pattern, REDACTED);
  return findings.map((finding) => ({ ...finding, file: `${shown} (file name)`, line: 1 }));
};

/**
 * Takes a snapshot, replaces every known secret, scans what is left, and
 * commits and pushes it. Returns { commit, pushed, unchanged }.
 */
export const now = async (home, { configPath, env, cwd, fetchImpl, clock = () => new Date() } = {}) => {
  const settings = await readSettings(home);
  const release = await takeLock(home);
  const startedAt = clock().toISOString();
  try {
    await assertNoneArePublic(settings.remote, repoDir(home), fetchImpl);
    const { entries, manifest } = await buildSnapshot(home, { configPath, env, cwd });
    const needles = needlesFor(await collectKnownSecrets(home));
    let replaced = 0;
    const redacted = entries.map((entry) => {
      const { buffer, count } = redactBuffer(entry.bytes, needles);
      replaced += count;
      return { ...entry, bytes: buffer };
    });
    const manifestEntry = {
      path: 'manifest.json',
      bytes: redactBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), needles).buffer,
      executable: false,
    };
    redacted.push(manifestEntry);
    assertPathsHoldNoKnownSecret(redacted, needles);
    const allowed = new Set(settings.allow);
    const findings = redacted
      .flatMap((entry) => [...scanBuffer(entry.path, entry.bytes), ...scanPath(entry.path)])
      .filter((f) => !allowed.has(f.id));
    if (findings.length > 0) throw new FindingsError(findings);

    const repo = repoDir(home);
    const { remote } = await syncWithRemote(repo, settings.branch);
    const commit = await commitSnapshot(repo, settings.branch, redacted, `Snapshot ${startedAt}`);
    const head = await revParse(repo, localRef(settings.branch));
    const pushed = head !== remote;
    if (pushed) await push(repo, settings.branch);
    const result = { commit: head, pushed, unchanged: commit === undefined, replaced, skipped: manifest.skipped, manifest };
    await writeJson(statusFile(home), { lastRun: startedAt, ok: true, commit: head, pushed, unchanged: result.unchanged, skipped: manifest.skipped.length });
    return result;
  } catch (error) {
    await writeJson(statusFile(home), { lastRun: startedAt, ok: false, error: error.message }).catch(() => {});
    throw error;
  } finally {
    await release();
  }
};

export const status = async (home) => {
  const settings = await readJson(settingsFile(home));
  const last = await readJson(statusFile(home));
  return { configured: settings !== undefined, settings, last };
};

export const allow = async (home, id) => {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`${JSON.stringify(id)} is not a finding id (16 hex characters from a failed run).`);
  const settings = await readSettings(home);
  if (!settings.allow.includes(id)) settings.allow.push(id);
  await writeJson(settingsFile(home), settings);
};
