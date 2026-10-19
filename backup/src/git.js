// The git target. A bare repository beside the home holds the history;
// every commit is built with plumbing (hash-object --no-filters,
// update-index, write-tree, commit-tree), so no .gitignore, .gitattributes,
// filter, or hook anywhere can change what is stored. History is only ever
// appended to: nothing here force-pushes or rewrites a ref backwards.

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

const AUTHOR = {
  GIT_AUTHOR_NAME: 'stratus-backup',
  GIT_AUTHOR_EMAIL: 'stratus-backup@localhost',
  GIT_COMMITTER_NAME: 'stratus-backup',
  GIT_COMMITTER_EMAIL: 'stratus-backup@localhost',
};

/**
 * Text with every URL's userinfo and query hidden. A URL's userinfo (a user
 * and a token or password) and its query (`?access_token=...`) can both carry
 * a credential, and git echoes the whole remote URL in its fatal errors, so
 * neither is shown; a fragment goes with the query. Only whitespace ends a
 * URL here: a quote or an `@` may be part of a credential, so the userinfo
 * runs to the last `@` before the path, and a quote git wraps the URL in is
 * hidden along with the query. scp-style `git@host:path` has no password and
 * is left as written.
 */
export const hideUrlCredentials = (text) => String(text)
  .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1***@')
  .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, (_, base) => `${base}?***`);

/** Most bytes a buffered git call keeps of its output. Tests lower it. */
export const limits = { output: 1024 * 1024 * 512 };

/** Runs git against the backup repository with hooks pointed at nothing. */
export const git = (repo, args, { input, env = {}, allowFailure = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
      {
        env: { ...process.env, ...AUTHOR, GIT_DIR: repo, GIT_TERMINAL_PROMPT: '0', ...env },
        encoding: 'buffer',
        maxBuffer: limits.output,
      },
      (error, stdout, stderr) => {
        const result = { code: error ? (error.code ?? 1) : 0, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), raw: stdout };
        if (error && !allowFailure) {
          reject(new Error(hideUrlCredentials(`git ${args[0]} failed: ${result.stderr.trim() || error.message}`)));
        } else {
          resolve(result);
        }
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });

export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A branch name this accepts: the plain characters above, and git's own ref
 * rules on top (git check-ref-format): no "..", and no ending in "." or
 * ".lock". Checked at init so a bad name never reaches the settings.
 */
export const isUsableBranch = (branch) =>
  typeof branch === 'string' && BRANCH_PATTERN.test(branch) && !branch.includes('..') && !branch.endsWith('.') && !branch.endsWith('.lock');

export const localRef = (branch) => `refs/heads/${branch}`;
const remoteRef = (branch) => `refs/remotes/origin/${branch}`;

export const revParse = async (repo, ref) => {
  const result = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : undefined;
};

/** The branch's local and remote-tracking refs as they stand, to put back with restoreRefs. */
export const saveBranchRefs = async (repo, branch) => {
  const saved = [];
  for (const ref of [localRef(branch), remoteRef(branch)]) saved.push([ref, await revParse(repo, ref)]);
  return saved;
};

/**
 * Puts refs back as saveBranchRefs found them, deleting any that did not
 * exist. Every ref is tried; if any could not be put back, this throws.
 */
export const restoreRefs = async (repo, saved) => {
  const failed = [];
  for (const [ref, oid] of saved) {
    const result = await git(repo, oid === undefined ? ['update-ref', '-d', ref] : ['update-ref', ref, oid], { allowFailure: true });
    if (result.code !== 0) failed.push(ref);
  }
  if (failed.length > 0) throw new Error(`could not put back ${failed.join(', ')}`);
};

export const initRepository = async (repo, remote) => {
  await git(repo, ['init', '--bare', '--quiet', repo], { env: { GIT_DIR: undefined } });
  const existing = await git(repo, ['remote', 'get-url', 'origin'], { allowFailure: true });
  if (existing.code === 0) {
    // --replace-all, not `remote set-url`: set-url fails outright when origin
    // has several URLs, and git pushes to every one of them.
    await git(repo, ['config', '--replace-all', 'remote.origin.url', remote]);
    // set-url moves only the fetch URL. A push URL left from before would
    // send every snapshot to the old destination, so the new remote is the
    // only place origin pushes to.
    await git(repo, ['config', '--unset-all', 'remote.origin.pushurl'], { allowFailure: true });
  } else {
    await git(repo, ['remote', 'add', 'origin', remote]);
  }
};

/**
 * Whether origin has this exact branch. ls-remote matches a pattern against
 * the tail of each ref, so `mini` would also match `x/mini`; the full ref is
 * asked for and the answer checked by name. Returns { code, exists }.
 */
export const remoteHasBranch = async (repo, branch, { allowFailure = false } = {}) => {
  const ref = localRef(branch);
  const listed = await git(repo, ['ls-remote', 'origin', ref], { allowFailure });
  const exists = listed.stdout.split('\n').some((line) => line.split('\t')[1] === ref);
  return { code: listed.code, exists };
};

/**
 * Brings the remote branch in and makes sure this machine is still its only
 * writer. A branch that moved somewhere this machine never committed means
 * another writer: the run stops rather than push over it or merge with it.
 */
export const syncWithRemote = async (repo, branch) => {
  const { exists } = await remoteHasBranch(repo, branch);
  if (!exists) return { remote: undefined };
  await git(repo, ['fetch', '--quiet', 'origin', `+${localRef(branch)}:${remoteRef(branch)}`]);
  const remote = await revParse(repo, remoteRef(branch));
  const local = await revParse(repo, localRef(branch));
  if (local === undefined) {
    await git(repo, ['update-ref', localRef(branch), remote]);
    return { remote };
  }
  if (local === remote) return { remote };
  const ancestor = await git(repo, ['merge-base', '--is-ancestor', remote, local], { allowFailure: true });
  if (ancestor.code !== 0) {
    throw new Error(
      `Branch ${branch} on the remote has commits this machine did not make. Each machine needs its own branch; `
        + 'pick another with `stratus-backup init <remote> --branch <name>`. Nothing was pushed.',
    );
  }
  return { remote };
};

/**
 * Commits the entries as the branch's next snapshot. Returns the new commit,
 * or undefined when the tree is identical to the last one.
 */
export const commitSnapshot = async (repo, branch, entries, message) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'stratus-backup-index-'));
  const indexEnv = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    const lines = [];
    for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const { stdout } = await git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], { input: entry.bytes });
      lines.push(`${entry.executable ? '100755' : '100644'} ${stdout.trim()}\t${entry.path}`);
    }
    await git(repo, ['update-index', '-z', '--add', '--index-info'], {
      input: Buffer.from(lines.map((line) => `${line}\0`).join('')),
      env: indexEnv,
    });
    const tree = (await git(repo, ['write-tree'], { env: indexEnv })).stdout.trim();
    const parent = await revParse(repo, localRef(branch));
    if (parent !== undefined) {
      const parentTree = (await git(repo, ['rev-parse', `${parent}^{tree}`])).stdout.trim();
      if (parentTree === tree) return undefined;
    }
    const args = ['commit-tree', tree, '-m', message];
    if (parent !== undefined) args.push('-p', parent);
    const commit = (await git(repo, args)).stdout.trim();
    // The old value makes this a compare-and-swap: a concurrent run loses
    // instead of silently dropping the other's commit.
    await git(repo, ['update-ref', localRef(branch), commit, parent ?? '']);
    return commit;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/** Pushes the branch. Never with force: a rejected push is a failed run. */
export const push = async (repo, branch) => {
  await git(repo, ['push', '--quiet', 'origin', `${localRef(branch)}:${localRef(branch)}`]);
};

/** Every blob in a commit's tree: { path, mode, oid }. */
export const listTree = async (repo, commit) => {
  const { raw } = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, oid] = line.slice(0, tab).split(' ');
      return { mode, type, oid, path: line.slice(tab + 1) };
    });
};

export const readBlob = async (repo, oid) => (await git(repo, ['cat-file', 'blob', oid])).raw;

/**
 * Writes a blob to a new file (`wx`: never over one already there), streamed
 * from git so a file of any size the backup took can be restored. A buffered
 * read stops at `limits.output`.
 */
export const writeBlobTo = (repo, oid, file, mode) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['-c', `core.hooksPath=${os.devNull}`, 'cat-file', 'blob', oid],
      { env: { ...process.env, ...AUTHOR, GIT_DIR: repo, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((done) => child.on('close', done));
    child.on('error', reject);
    pipeline(child.stdout, createWriteStream(file, { flags: 'wx', mode }))
      .then(() => exited)
      .then((code) => (code === 0 ? resolve() : reject(new Error(hideUrlCredentials(`git cat-file failed: ${stderr.trim() || `exit ${code}`}`)))))
      .catch(reject);
  });
