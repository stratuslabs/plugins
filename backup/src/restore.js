// Restore writes a snapshot into a directory that is empty or absent, never
// over live state. Files are written into a staging directory beside the
// target and renamed into place at the end, so a failed restore leaves no
// half-written home behind.

import { chmod, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git, initRepository, listTree, readBlob, revParse, syncWithRemote } from './git.js';

const SAFE_SEGMENT = /^(?!\.{1,2}$)[^/\0]+$/;
const PRIVATE_FILES = new Set(['config.json', 'memory.jsonl', 'whitelist.json']);

const isEmptyOrAbsent = async (dir) => {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
};

/** The same table the gateway creates, so a restored fleet.db opens as its own. */
const writeSchedules = (file, jsonl) => {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, next_fire_at TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO schedules (id, agent_id, next_fire_at, body, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const line of jsonl.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      insert.run(row.id, row.agent_id, row.next_fire_at, row.body, row.created_at);
    }
  } finally {
    db.close();
  }
};

/**
 * Restores `commit` (default: the branch's latest) of the configured
 * repository, or of `remote`/`branch` when this machine has none, into
 * `target`. Returns the manifest so the caller can say what to re-enter.
 */
export const restore = async (target, { repo, remote, branch, commit, offline = false } = {}) => {
  const destination = path.resolve(target);
  if (!(await isEmptyOrAbsent(destination))) {
    throw new Error(`${destination} is not empty. Restore only writes into an empty or new directory, never over a home.`);
  }

  let scratchRepo;
  if (repo === undefined) {
    if (!remote || !branch) throw new Error('Name the backup with --remote <url> --branch <name>, or run restore on a machine where `stratus-backup init` ran.');
    scratchRepo = await mkdtemp(path.join(os.tmpdir(), 'stratus-backup-restore-'));
    repo = path.join(scratchRepo, 'repo');
    await initRepository(repo, remote);
  }
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, `.${path.basename(destination)}.restoring-`));
  try {
    // --offline restores what this machine has and never contacts origin.
    if (branch !== undefined && !offline) {
      const listed = await git(repo, ['ls-remote', '--heads', 'origin', branch], { allowFailure: true });
      if (listed.code !== 0) {
        // Restoring what this machine cached when the remote may hold newer
        // snapshots would bring back stale state and call it a recovery.
        throw new Error(
          'Could not check origin for newer snapshots (git ls-remote failed). Not restoring a copy that may be stale; '
            + 'rerun when the remote is reachable, or pass --offline to restore the latest snapshot this machine has.',
        );
      }
      if (listed.code === 0 && listed.stdout.trim()) await syncWithRemote(repo, branch);
    }
    const ref = commit ?? (branch !== undefined ? `refs/heads/${branch}` : undefined);
    if (ref === undefined) throw new Error('Name a --branch or a --commit to restore.');
    const resolved = await revParse(repo, ref);
    if (resolved === undefined) throw new Error(`No snapshot found at ${ref}.`);

    let manifest = {};
    let schedules;
    for (const item of await listTree(repo, resolved)) {
      if (item.type !== 'blob' || (item.mode !== '100644' && item.mode !== '100755')) {
        throw new Error(`The snapshot holds ${item.path} as ${item.type} ${item.mode}; a backup only ever holds plain files. Not restoring.`);
      }
      if (item.path === 'manifest.json') {
        manifest = JSON.parse((await readBlob(repo, item.oid)).toString('utf8'));
        continue;
      }
      const segments = item.path.split('/');
      if (segments[0] !== 'home' || segments.length < 2 || !segments.every((segment) => SAFE_SEGMENT.test(segment))) {
        throw new Error(`The snapshot holds an unexpected path, ${JSON.stringify(item.path)}. Not restoring.`);
      }
      const relative = segments.slice(1);
      const bytes = await readBlob(repo, item.oid);
      if (relative.length === 1 && relative[0] === 'schedules.jsonl') {
        schedules = bytes.toString('utf8');
        continue;
      }
      const file = path.join(staging, ...relative);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const mode = item.mode === '100755' ? 0o755 : PRIVATE_FILES.has(relative.at(-1)) ? 0o600 : 0o644;
      await writeFile(file, bytes, { mode, flag: 'wx' });
      await chmod(file, mode);
    }
    if (schedules !== undefined) {
      writeSchedules(path.join(staging, 'fleet.db'), schedules);
      await chmod(path.join(staging, 'fleet.db'), 0o600);
    }
    await chmod(staging, 0o700);
    if (!(await isEmptyOrAbsent(destination))) {
      throw new Error(`${destination} stopped being empty while restoring. Nothing was written to it.`);
    }
    // rmdir, not rm: it only ever removes an empty directory.
    await rmdir(destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rename(staging, destination);
    return { commit: resolved, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (scratchRepo) await rm(scratchRepo, { recursive: true, force: true });
  }
};
