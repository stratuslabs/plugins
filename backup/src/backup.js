// init, now, status and allow: everything except restore and the timer.
//
// The backup's own state lives in <home>/backup/: settings.json (the remote,
// the branch, allowed findings), status.json (the last run), and repo/, a
// bare clone that holds the history. None of it is ever in a snapshot.

import { execFileSync } from 'node:child_process';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitSnapshot, hideUrlCredentials, isUsableBranch, git, initRepository, localRef, push, restoreRefs, revParse, saveBranchRefs, syncWithRemote } from './git.js';
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

// Every check that asks "is this GitHub?" uses this one host rule:
// github.com, www.github.com or ssh.github.com, in any case, with or without
// the trailing DNS dot (`github.com.` is the same host).
const GH = String.raw`(?:www\.|ssh\.)?github\.com\.?`;

/** owner/name for a github.com remote, in any of the URL forms git accepts. */
export const githubRepoOf = (remote) => {
  // git drops a URL's query and fragment before it connects, so the lookup
  // drops them too: `owner/repo.git#label` pushes to owner/repo.
  remote = String(remote).replace(/[?#].*$/s, '');
  const match = new RegExp(String.raw`^(?:(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?${GH}(?::\d+)?\/|(?:[^@/:]+@)?${GH}:)\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$`, 'i').exec(remote);
  return match ? `${match[1]}/${match[2]}` : undefined;
};

/** True when the remote's host is github.com, whether or not its path parses. */
const pointsAtGithub = (remote) => new RegExp(String.raw`^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?${GH}(?:[:/]|$)`, 'i').test(remote);

const GITHUB_HOST = new RegExp(`^${GH}$`, 'i');

/** Host and path of an SSH remote (ssh://, git+ssh://, or scp-like host:path), else undefined. */
const sshTargetOf = (remote) => {
  remote = String(remote).replace(/[?#].*$/s, '');
  const url = /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^/:]+)(?::\d+)?\/+(.*)$/i.exec(remote);
  if (url) return { host: url[1].replace(/^\[|\]$/g, ''), path: url[2] };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return undefined;
  // git reads `host:path` as SSH only when no slash comes before the colon.
  const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^@/:]+):(.*)$/s.exec(remote);
  return scp ? { host: scp[1].replace(/^\[|\]$/g, ''), path: scp[2] } : undefined;
};

/**
 * The hostname ssh connects to for `host`, from the user's ssh config. An
 * answer this cannot get is a refusal: the remote may be GitHub under
 * another name. A custom ssh in GIT_SSH_COMMAND or core.sshCommand that
 * reads another config is not followed.
 */
const sshHostnameOf = (host) => {
  const refuse = (why) => new Error(`Could not tell where SSH host ${host} connects (${why}), so could not confirm the remote is not a public GitHub repository. Nothing was pushed.`);
  if (host.startsWith('-')) throw refuse('a host cannot start with "-"');
  let output;
  try {
    output = execFileSync('ssh', ['-G', host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch (error) {
    throw refuse(error.code === 'ENOENT' ? 'ssh is not installed' : 'ssh -G failed');
  }
  const line = output.split('\n').find((entry) => /^hostname\s/i.test(entry));
  if (!line) throw refuse('ssh -G named no hostname');
  return line.replace(/^hostname\s+/i, '').trim();
};

/**
 * Refuses a GitHub repository anyone can read. The check is unauthenticated
 * on purpose: if GitHub answers it without credentials, so it would for
 * anyone. Run before every push, since a repository can be made public later.
 */
export const assertNotPublic = async (remote, fetchImpl = globalThis.fetch) => {
  const repo = githubRepoOf(remote);
  if (repo === undefined) {
    if (pointsAtGithub(remote)) throw new Error('Could not tell which GitHub repository the remote names, so could not confirm it is private. Nothing was pushed.');
    // An SSH host can be an alias (`Host gh-work` with `HostName github.com`),
    // so the host git will reach is the one ssh resolves, not the one written.
    const target = sshTargetOf(remote);
    if (target !== undefined) {
      const reached = sshHostnameOf(target.host);
      if (GITHUB_HOST.test(reached)) return assertNotPublic(`git@github.com:${target.path}`, fetchImpl);
    }
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
  // A remote can have several URLs, and git pushes to every push URL.
  const add = (result) => {
    if (result.code !== 0) return;
    for (const line of result.stdout.split('\n')) {
      const url = line.trim();
      if (url) urls.add(url);
    }
  };
  add(await git(os.devNull, ['ls-remote', '--get-url', remote], { allowFailure: true, env: { GIT_DIR: undefined } }));
  if (repo !== undefined) {
    add(await git(repo, ['remote', 'get-url', '--all', 'origin'], { allowFailure: true }));
    add(await git(repo, ['remote', 'get-url', '--push', '--all', 'origin'], { allowFailure: true }));
  }
  return [...urls];
};

const assertNoneArePublic = async (remote, repo, fetchImpl) => {
  for (const url of await urlsGitUses(remote, repo)) await assertNotPublic(url, fetchImpl);
};

/**
 * A re-init that failed and could not put origin back leaves it naming a
 * remote the settings do not, so a run checks before it syncs or pushes.
 */
const assertOriginMatches = async (repo, remote) => {
  const result = await git(repo, ['config', '--get', 'remote.origin.url'], { allowFailure: true });
  if (result.code !== 0 || result.stdout.trim() !== remote) {
    throw new Error('The backup repository\'s origin is not the remote the settings name, so nothing was pushed. Run init again with the remote you want.');
  }
};

const pushUrlsOf = async (repo) => {
  const result = await git(repo, ['config', '--get-all', 'remote.origin.pushurl'], { allowFailure: true });
  return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : [];
};

export const init = async (home, remote, { branch = defaultBranch(), fetchImpl } = {}) => {
  if (!isUsableBranch(branch)) throw new Error(`${JSON.stringify(branch)} is not a usable branch name.`);
  await assertNoneArePublic(remote, undefined, fetchImpl);
  await mkdir(backupDir(home), { recursive: true, mode: 0o700 });
  // Changing origin and the settings is one step a running backup must not
  // see half of, so init takes the same lock a run does.
  const release = await takeLock(home);
  try {
    const previous = await readJson(settingsFile(home));
    const repo = repoDir(home);
    // initRepository clears origin's push URLs, so a failed re-init has to
    // put back the ones it had, not only the fetch URL.
    const previousPushUrls = await pushUrlsOf(repo);
    // syncWithRemote may adopt the new remote's branch; a rollback must drop
    // it, or a later run could push that history to the old remote.
    const previousRefs = await saveBranchRefs(repo, branch);
    await initRepository(repo, remote);
    let existing;
    try {
      await assertNoneArePublic(remote, repo, fetchImpl);
      ({ remote: existing } = await syncWithRemote(repo, branch));
      await writeJson(settingsFile(home), { remote, branch, allow: previous?.allow ?? [] });
    } catch (error) {
      await restoreRefs(repo, previousRefs).catch(() => {});
      // Settings are not changed, so origin must not be either: put back the
      // remote the settings still name, so later runs push where they check.
      if (previous?.remote) {
        await initRepository(repo, previous.remote)
          .then(async () => { for (const url of previousPushUrls) await git(repo, ['config', '--add', 'remote.origin.pushurl', url]); })
          .catch(() => {});
      }
      throw error;
    }
    return { branch, adopted: existing !== undefined };
  } finally {
    await release();
  }
};

const lockText = async (file) => readFile(file, 'utf8').catch(() => '');

/**
 * When a process started, as ps prints it, or undefined if ps cannot say.
 * Stored beside the pid so a pid the OS later hands to another process is
 * not mistaken for the backup that wrote the lock.
 */
const processStart = (pid) => {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return text || undefined;
  } catch {
    return undefined;
  }
};

/** Creates file holding this pid and its start time, all at once, or fails with EEXIST: never an empty lock. */
const createLock = async (file) => {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const started = processStart(process.pid);
  await writeFile(temporary, started ? `${process.pid}\n${started}` : String(process.pid), { mode: 0o600 });
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
 * Whether the process that wrote a lock still runs: its pid is alive and,
 * when the lock recorded one, that pid started when the writer did. A lock
 * from an older version holds only the pid and is judged by it alone, as
 * is any lock when ps cannot report a start time.
 */
const holderOf = (text) => {
  const [first, ...rest] = text.split('\n');
  const pid = Number(first.trim());
  const started = rest.join('\n').trim() || undefined;
  if (!isAlive(pid)) return { pid, live: false };
  if (started === undefined) return { pid, live: true };
  const current = processStart(pid);
  return { pid, live: current === undefined || current === started };
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
    const holder = holderOf(await lockText(guard));
    if (holder.live) throw new Error(`Another backup is running (pid ${holder.pid}).`);
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
      const holder = holderOf(seen);
      if (holder.live) throw new Error(`Another backup is running (pid ${holder.pid}).`);
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
    .map((result, index) => ({ ...result, entry: entries[index] }))
    .filter(({ count }) => count > 0)
    // Shown as every other path is: a different key-shaped token in the
    // same name must not ride out in this message.
    .map(({ entry }) => `  ${shownPath(entry.path, needles)}`);
  if (leaking.length > 0) {
    throw new Error(
      'A file name holds a stored secret, so nothing was committed or pushed:\n'
        + `${leaking.join('\n')}\n`
        + 'Rename the file so its name does not hold the secret.',
    );
  }
};

/** Snapshots read before a run whose credentials keep changing gives up. */
const SNAPSHOT_ATTEMPTS = 3;

const sameSet = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));

/** A path as it may be shown: stored secrets and key-shaped text replaced. */
const shownPath = (entryPath, needles) => {
  let shown = redactBuffer(Buffer.from(entryPath), needles).buffer.toString();
  for (const [, pattern] of KEY_PATTERNS) shown = shown.replace(pattern, REDACTED);
  return shown;
};

/** An error message as it may be stored or shown, redacted the way a path is. */
const shownError = async (home, message, earlier = new Set()) => {
  const secrets = await collectKnownSecrets(home).catch(() => new Set());
  try {
    return shownPath(hideUrlCredentials(message), needlesFor(new Set([...earlier, ...secrets])));
  } catch {
    return 'The backup failed, and its error could not be shown without a stored secret in it.';
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
export const now = async (home, { configPath, env, cwd, fetchImpl, clock = () => new Date(), afterSnapshot } = {}) => {
  await readSettings(home);
  const release = await takeLock(home);
  const startedAt = clock().toISOString();
  // Secrets read before the snapshot also redact a failure: one rotated away
  // mid-run may still be named in the error.
  let before = new Set();
  try {
    // Read again under the lock: an init that finished meanwhile may have moved the remote.
    const settings = await readSettings(home);
    await assertOriginMatches(repoDir(home), settings.remote);
    await assertNoneArePublic(settings.remote, repoDir(home), fetchImpl);
    // The secrets are read before and after the snapshot. If they differ, a
    // credential rotated while the files were read, maybe more than once, and
    // a value seen only in between is in neither set, so the snapshot is read
    // again until both reads agree. Every value seen is still replaced: a
    // file may hold the one rotated away.
    let entries;
    let manifest;
    let seen = new Set();
    for (let attempt = 1; ; attempt += 1) {
      const start = await collectKnownSecrets(home);
      seen = new Set([...seen, ...start]);
      before = seen;
      ({ entries, manifest } = await buildSnapshot(home, { configPath, env, cwd }));
      await afterSnapshot?.();
      const end = await collectKnownSecrets(home);
      seen = new Set([...seen, ...end]);
      if (sameSet(start, end)) break;
      if (attempt === SNAPSHOT_ATTEMPTS) {
        throw new Error(
          `Stored credentials changed while each of ${SNAPSHOT_ATTEMPTS} snapshots was read, so one may hold a value `
            + 'neither read saw. Nothing was pushed; run again once they settle.',
        );
      }
    }
    const needles = needlesFor(seen);
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
    // The CLI prints from the returned manifest, so it is the redacted one.
    const shownManifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
    redacted.push(manifestEntry);
    assertPathsHoldNoKnownSecret(redacted, needles);
    const allowed = new Set(settings.allow);
    const findings = redacted
      // A content finding names its file too, so the file is shown the way a
      // path finding shows it: key-shaped text in the name replaced.
      .flatMap((entry) => [
        ...scanBuffer(entry.path, entry.bytes).map((finding) => ({ ...finding, file: shownPath(entry.path, needles) })),
        ...scanPath(entry.path),
      ])
      .filter((f) => !allowed.has(f.id));
    if (findings.length > 0) throw new FindingsError(findings);

    const repo = repoDir(home);
    const { remote } = await syncWithRemote(repo, settings.branch);
    const commit = await commitSnapshot(repo, settings.branch, redacted, `Snapshot ${startedAt}`);
    const head = await revParse(repo, localRef(settings.branch));
    const pushed = head !== remote;
    if (pushed) {
      // Building and redacting the snapshot takes a while, and the
      // repository's visibility can change meanwhile, so check again last.
      await assertNoneArePublic(settings.remote, repo, fetchImpl);
      await push(repo, settings.branch);
    }
    // Skipped paths are printed and logged, so they get the same redaction the manifest did.
    const skipped = manifest.skipped.map((item) => ({ ...item, path: shownPath(item.path, needles) }));
    const result = { commit: head, pushed, unchanged: commit === undefined, replaced, skipped, manifest: shownManifest };
    await writeJson(statusFile(home), { lastRun: startedAt, ok: true, commit: head, pushed, unchanged: result.unchanged, skipped: manifest.skipped.length });
    return result;
  } catch (error) {
    // A filesystem error can name a file after a stored secret, and this
    // message goes to status.json, the CLI and the nightly log.
    error.message = await shownError(home, error.message, before);
    await writeJson(statusFile(home), { lastRun: startedAt, ok: false, error: error.message }).catch(() => {});
    throw error;
  } finally {
    await release();
  }
};

/** The remote as it may be shown: no userinfo or query (see hideUrlCredentials). */
export const shownRemote = (remote) => hideUrlCredentials(remote);

export const status = async (home) => {
  const settings = await readJson(settingsFile(home));
  const last = await readJson(statusFile(home));
  return { configured: settings !== undefined, settings, last };
};

export const allow = async (home, id) => {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`${JSON.stringify(id)} is not a finding id (16 hex characters from a failed run).`);
  await readSettings(home);
  // A read-modify-write of the settings, so it takes the lock init and runs
  // take: two allows keep both ids, and an init's new remote is not undone.
  const release = await takeLock(home);
  try {
    const settings = await readSettings(home);
    if (!settings.allow.includes(id)) settings.allow.push(id);
    await writeJson(settingsFile(home), settings);
  } finally {
    await release();
  }
};
