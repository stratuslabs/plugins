// init, now, status and allow: everything except restore and the timer.
//
// The backup's own state lives in <home>/backup/: settings.json (the remote,
// the branch, allowed findings), status.json (the last run), and repo/, a
// bare clone that holds the history. None of it is ever in a snapshot.

import { execFileSync } from 'node:child_process';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitSnapshot, hideUrlCredentials, isUsableBranch, git, initRepository, listTree, localRef, push, restoreRefs, revParse, saveBranchRefs, syncWithRemote, writeBlob } from './git.js';
import { assertRecipients, encryptSnapshot, isEncryptedTree } from './encrypt.js';
import { KEY_PATTERNS, REDACTED, collectKnownSecrets, credentialSourcesState, needlesFor, redactBuffer, scanBuffer, scanLimits } from './secrets.js';
import { buildSnapshot } from './snapshot.js';

export const backupDir = (home) => path.join(home, 'backup');
const settingsFile = (home) => path.join(backupDir(home), 'settings.json');
const statusFile = (home) => path.join(backupDir(home), 'status.json');
const encryptionCacheFile = (home) => path.join(backupDir(home), 'encryption-cache.json');
// Left by a re-init whose rollback did not finish: the repository may hold
// refs or an origin from the remote it did not switch to, so runs stop until
// an init succeeds.
const reinitFile = (home) => path.join(backupDir(home), 'needs-init');
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

// And every remote rule reads the user part one way: up to the last @, as
// ssh and URL parsers do (`u@x@github.com` is user `u@x` at github.com). A
// URL's user part runs to the last @ before the path; an scp-like one has no
// colon, since git ends the host at the first colon.
const URL_USER = String.raw`(?:[^/]*@)?`;
const SCP_USER = String.raw`(?:[^/:]*@)?`;

/** owner/name for a github.com remote, in any of the URL forms git accepts. */
export const githubRepoOf = (remote) => {
  // git drops a URL's query and fragment before it connects, so the lookup
  // drops them too: `owner/repo.git#label` pushes to owner/repo.
  remote = String(remote).replace(/[?#].*$/s, '');
  const match = new RegExp(String.raw`^(?:(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/${URL_USER}${GH}(?::\d+)?\/|${SCP_USER}${GH}:)\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$`, 'i').exec(remote);
  return match ? `${match[1]}/${match[2]}` : undefined;
};

/** True when the remote's host is github.com, whether or not its path parses. */
const pointsAtGithub = (remote) => new RegExp(String.raw`^(?:[a-z+]+:\/\/${URL_USER}|${SCP_USER})${GH}(?:[:/]|$)`, 'i').test(remote);

const GITHUB_HOST = new RegExp(`^${GH}$`, 'i');

/** git's url_decode: %XX becomes that byte; anything else stays as written. */
const gitUrlDecode = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const hex = bytes.toString('latin1', i + 1, i + 3);
    if (bytes[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(bytes[i]);
    }
  }
  return Buffer.from(out).toString('utf8');
};

/**
 * What git hands ssh for an SSH remote (ssh://, git+ssh://, or scp-like
 * host:path): the destination `[user@]host`, the port, and the path; else
 * undefined. git decodes an ssh:// URL before it splits it, so this does too.
 */
const sshTargetOf = (remote) => {
  remote = String(remote).replace(/[?#].*$/s, '');
  if (/^(?:ssh|git\+ssh|ssh\+git):\/\//i.test(remote)) {
    const url = /^[^:]+:\/\/(?:([^/]*)@)?(\[[^\]]+\]|[^@/:]+)(?::(\d+))?\/+(.*)$/s.exec(gitUrlDecode(remote));
    if (!url) return undefined;
    const host = url[2].replace(/^\[|\]$/g, '');
    return { host, user: url[1], port: url[3], path: url[4] };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return undefined;
  // git reads `host:path` as SSH only when no slash comes before the colon.
  const scp = /^(?:([^/:]*)@)?(\[[^\]]+\]|[^@/:]+):(.*)$/s.exec(remote);
  return scp ? { host: scp[2].replace(/^\[|\]$/g, ''), user: scp[1], port: undefined, path: scp[3] } : undefined;
};

/**
 * The hostname ssh connects to for a target, from the user's ssh config,
 * asked with the destination and port git passes, so `Match user` and
 * `Match exec "%p"` blocks apply as they will for the push. An answer this
 * cannot get is a refusal: the remote may be GitHub under another name. A
 * custom ssh in GIT_SSH_COMMAND or core.sshCommand that reads another config
 * is not followed.
 */
const sshHostnameOf = ({ host, user, port }) => {
  const destination = user === undefined ? host : `${user}@${host}`;
  const refuse = (why) => new Error(`Could not tell where SSH host ${host} connects (${why}), so could not confirm the remote is not a public GitHub repository. Nothing was pushed.`);
  if (destination.startsWith('-')) throw refuse('a destination cannot start with "-"');
  let output;
  try {
    output = execFileSync('ssh', ['-G', ...(port === undefined ? [] : ['-p', port]), destination], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
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
      const reached = sshHostnameOf(target);
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
 * A re-init that failed and could not roll back leaves the repository
 * holding refs or an origin from a remote the settings do not name, so a run
 * checks before it syncs or pushes: the marker such a rollback leaves, and
 * origin itself, as a backstop for a marker that could not be written.
 */
export const assertRepositoryMatches = async (home, remote) => {
  const stop = 'Run init again with the remote you want.';
  if (await readFile(reinitFile(home)).then(() => true, (error) => error.code !== 'ENOENT')) {
    throw new Error(`An earlier init failed and could not undo its changes to the backup repository, so nothing was pushed. ${stop}`);
  }
  // git pushes to every URL origin has (every push URL, if it has any), so
  // origin must name the settings' remote and nothing else.
  const values = async (key) => {
    const result = await git(repoDir(home), ['config', '--get-all', key], { allowFailure: true });
    return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : [];
  };
  const urls = await values('remote.origin.url');
  const pushUrls = await values('remote.origin.pushurl');
  if (urls.length !== 1 || urls[0] !== remote || pushUrls.some((url) => url !== remote)) {
    throw new Error(`The backup repository's origin is not the remote the settings name, so nothing was pushed. ${stop}`);
  }
};

const pushUrlsOf = async (repo) => {
  const result = await git(repo, ['config', '--get-all', 'remote.origin.pushurl'], { allowFailure: true });
  return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : [];
};

/** Whether these settings make encrypted snapshots. Settings from before encryption existed are plaintext. */
export const isEncrypted = (settings) => Array.isArray(settings?.recipients) && settings.recipients.length > 0;

/**
 * Refuses a branch whose snapshots are in the other format: its history
 * stays as it is whatever comes next, so plaintext commits would sit under
 * encrypted ones (or the reverse) and look protected when they are not.
 */
const assertBranchFormat = async (repo, branch, encrypted) => {
  const tip = await revParse(repo, localRef(branch));
  if (tip === undefined) return;
  const holdsEncrypted = isEncryptedTree((await listTree(repo, tip)).map((item) => item.path));
  if (holdsEncrypted === encrypted) return;
  throw new Error(
    holdsEncrypted
      ? `Branch ${branch} holds encrypted snapshots. Plaintext ones would sit in the same history; use a new branch (--branch) or a new repository for them.`
      : `Branch ${branch} already holds plaintext snapshots, and they stay readable in its history whatever comes after. `
        + 'Use a new branch (--branch) or a new repository for encrypted backups, and delete the old branch once you have moved.',
  );
};

export const init = async (home, remote, { branch = defaultBranch(), recipients, plaintext = false, fetchImpl, beforeArm, afterRepositoryChanged } = {}) => {
  if (!isUsableBranch(branch)) throw new Error(`${JSON.stringify(branch)} is not a usable branch name.`);
  if (plaintext && recipients?.length > 0) throw new Error('Pick one: --recipient for encrypted snapshots, or --plaintext.');
  if (!plaintext) {
    if (!recipients?.length) {
      throw new Error(
        'Backups are encrypted by default. Run `stratus-backup keygen --out <file>`, keep that file somewhere other than this machine, '
          + 'and init again with --recipient <the age1... key it prints>. Or pass --plaintext for a readable backup that only redaction protects.',
      );
    }
    assertRecipients(recipients);
  }
  await assertNoneArePublic(remote, undefined, fetchImpl);
  await mkdir(backupDir(home), { recursive: true, mode: 0o700 });
  // Changing origin and the settings is one step a running backup must not
  // see half of, so init takes the same lock a run does.
  const release = await takeLock(home);
  try {
    const previous = await readJson(settingsFile(home));
    const repo = repoDir(home);
    // A failed rollback left refs or an origin this machine cannot vouch
    // for, and the remote may not have the branch to replace them, so the
    // init that clears the stop starts from a fresh repository. The suspect
    // one is moved aside, never deleted: it may hold local history.
    const suspect = await readFile(reinitFile(home)).then(() => true, (error) => error.code !== 'ENOENT');
    if (suspect) await rename(repo, `${repo}.suspect-${new Date().toISOString().replace(/[:.]/g, '-')}`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    // initRepository clears origin's push URLs, so a failed re-init has to
    // put back the ones it had, not only the fetch URL.
    const previousPushUrls = await pushUrlsOf(repo);
    // syncWithRemote may adopt the new remote's branch; a rollback must drop
    // it, or a later run could push that history to the old remote.
    const previousRefs = await saveBranchRefs(repo, branch);
    // The stop is armed before the repository changes and cleared only once
    // it is known good, so a rollback that fails while the backup directory
    // can no longer be written still leaves runs stopped. An init that
    // cannot arm it fails here, having changed nothing.
    await beforeArm?.();
    await writeFile(reinitFile(home), `${new Date().toISOString()}\n`, { mode: 0o600 });
    await initRepository(repo, remote);
    let existing;
    try {
      await afterRepositoryChanged?.();
      await assertNoneArePublic(remote, repo, fetchImpl);
      ({ remote: existing } = await syncWithRemote(repo, branch));
      await assertBranchFormat(repo, branch, !plaintext);
      await writeJson(settingsFile(home), { remote, branch, allow: previous?.allow ?? [], ...(plaintext ? { plaintext: true } : { recipients }) });
    } catch (error) {
      // Settings are not changed, so the repository must not be either: the
      // branch refs go back, and origin is put back to the remote the
      // settings still name, so later runs push where they check. Any step
      // that fails leaves the armed marker, which stops runs until an init
      // succeeds; a full rollback clears it, unless it was there before.
      let undone = await restoreRefs(repo, previousRefs).then(() => true, () => false);
      if (previous?.remote) {
        undone = await initRepository(repo, previous.remote)
          .then(async () => { for (const url of previousPushUrls) await git(repo, ['config', '--add', 'remote.origin.pushurl', url]); })
          .then(() => undone, () => false);
      }
      if (undone && !suspect) await rm(reinitFile(home), { force: true }).catch(() => {});
      throw error;
    }
    // Only a finished init clears the stop an earlier failed one left.
    await rm(reinitFile(home), { force: true });
    return { branch, adopted: existing !== undefined };
  } finally {
    await release();
  }
};

const lockText = async (file) => readFile(file, 'utf8').catch(() => '');

/**
 * When a process started, as ps prints it, or undefined if ps cannot say.
 * Stored beside the pid so a pid the OS later hands to another process is
 * not mistaken for the backup that wrote the lock. Always printed in UTC: ps
 * renders the time in the caller's zone, and a run from a shell with TZ set
 * and the nightly one (whose unit sets no TZ) must read the same text.
 */
const processStart = (pid) => {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return text || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Creates file holding this pid and its start time, all at once, or fails
 * with EEXIST: never an empty lock. Returns the text written, which is how
 * the holder later knows the lock is still its own.
 */
const createLock = async (file) => {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const started = processStart(process.pid);
  const text = started ? `${process.pid}\n${started}` : String(process.pid);
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await link(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return text;
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
      const mine = await createLock(file);
      // Released only while it still holds this run's text: a run that
      // wrongly judged this one gone may hold it by now.
      return async () => {
        if ((await lockText(file)) === mine) await rm(file, { force: true });
      };
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
    await assertRepositoryMatches(home, settings.remote);
    await assertNoneArePublic(settings.remote, repoDir(home), fetchImpl);
    // The credential files are checked before and after the snapshot. If
    // either changed, even away and back to the same values, a credential may
    // have been stored only while the files were read, and that value is in
    // neither read, so the snapshot is read again until one is taken while
    // no credential source changed at all. Every value seen is still
    // replaced: a file may hold the one rotated away.
    let entries;
    let manifest;
    let seen = new Set();
    for (let attempt = 1; ; attempt += 1) {
      const startState = await credentialSourcesState(home);
      const start = await collectKnownSecrets(home);
      seen = new Set([...seen, ...start]);
      before = seen;
      ({ entries, manifest } = await buildSnapshot(home, { configPath, env, cwd }));
      await afterSnapshot?.();
      const end = await collectKnownSecrets(home);
      seen = new Set([...seen, ...end]);
      if (sameSet(start, end) && (await credentialSourcesState(home)) === startState) break;
      if (attempt === SNAPSHOT_ATTEMPTS) {
        throw new Error(
          `Stored credentials changed while each of ${SNAPSHOT_ATTEMPTS} snapshots was read, so one may hold a value `
            + 'neither read saw. Nothing was pushed; run again once they settle.',
        );
      }
    }
    for (const entry of entries) {
      if (entry.bytes.length > scanLimits.fileBytes) {
        throw new Error(
          `${entry.path} is ${entry.bytes.length} bytes, more than the ${scanLimits.fileBytes} the backup can scan for secrets. `
            + 'Nothing was pushed; trim or remove the file and run again.',
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
    const encrypted = isEncrypted(settings);
    redacted.push(manifestEntry);
    // An encrypted snapshot commits paths only inside its ciphertext index.
    if (!encrypted) assertPathsHoldNoKnownSecret(redacted, needles);
    const allowed = new Set(settings.allow);
    const findings = redacted
      // A content finding names its file too, so the file is shown the way a
      // path finding shows it: key-shaped text in the name replaced.
      .flatMap((entry) => [
        ...scanBuffer(entry.path, entry.bytes).map((finding) => ({ ...finding, file: shownPath(entry.path, needles) })),
        ...scanPath(entry.path),
      ])
      .filter((f) => !allowed.has(f.id));
    // Ciphertext is the guarantee for an encrypted snapshot, so a finding
    // there is reported, not a reason to skip the night's backup.
    if (findings.length > 0 && !encrypted) throw new FindingsError(findings);
    const warnings = encrypted ? findings : [];

    const repo = repoDir(home);
    const { remote } = await syncWithRemote(repo, settings.branch);
    await assertBranchFormat(repo, settings.branch, encrypted);
    let staged = redacted;
    let saveCache;
    if (encrypted) {
      const parent = await revParse(repo, localRef(settings.branch));
      const parentTree = new Map(parent === undefined ? [] : (await listTree(repo, parent)).map((item) => [item.path, item.oid]));
      const sealed = await encryptSnapshot({
        entries: redacted.filter((entry) => entry !== manifestEntry),
        manifest: shownManifest,
        recipients: settings.recipients,
        cacheFile: encryptionCacheFile(home),
        parentTree,
      });
      const oids = new Map();
      staged = [];
      for (const entry of sealed.entries) {
        const oid = entry.oid ?? (await writeBlob(repo, entry.bytes));
        oids.set(entry.path, oid);
        staged.push({ path: entry.path, oid, executable: false });
      }
      saveCache = () => sealed.saveCache((file) => oids.get(file));
    }
    const commit = await commitSnapshot(repo, settings.branch, staged, `Snapshot ${startedAt}`);
    await saveCache?.();
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
    const result = { commit: head, pushed, unchanged: commit === undefined, replaced, skipped, manifest: shownManifest, encrypted, warnings };
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
