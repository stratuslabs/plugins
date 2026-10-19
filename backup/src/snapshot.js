// Builds the snapshot of a home: a list of { path, bytes, executable }
// entries under `home/`, plus `manifest.json`. Nothing is written anywhere;
// the git layer commits what this returns.
//
// What goes in: souls, skills, the trusted config (redacted), state.json,
// each agent's memory.jsonl and whitelist.json, and the schedules from
// fleet.db as JSON lines. What never does: credentials.json, the control
// API token and address, locks, logs, the derived memory index, sessions,
// and workspaces. Sessions and workspaces hold arbitrary tool output, and
// a scan cannot promise to find a secret in that, so they wait for an
// encrypted target.

import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redactConfig } from './secrets.js';

/** Migrations after which the home is in the per-agent layout this reads. */
export const REQUIRED_MIGRATIONS = ['0003-per-agent-state-layout', '0004-per-agent-workspaces'];

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const READ_ATTEMPTS = 4;

export class UnstableFileError extends Error {}

const sameStat = (a, b) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev;

/**
 * Reads one regular file and proves it held still while being read: the
 * descriptor's size, times and inode match before and after, and the path
 * still names the same inode. `follow` allows the path itself to be a link
 * (a soul, or a config chosen with --config); otherwise a link is refused.
 */
export const readStable = async (file, { follow = false } = {}) => {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW);
    const handle = await open(file, flags);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`${file} is not a regular file.`);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const named = await stat(file);
      if (sameStat(before, after) && bytes.length === after.size && named.ino === after.ino && named.dev === after.dev) {
        return { bytes, mode: after.mode, nlink: after.nlink };
      }
    } finally {
      await handle.close();
    }
  }
  throw new UnstableFileError(`${file} kept changing while it was read.`);
};

const exists = async (file) => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

const readJsonIfPresent = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`${file} could not be read as JSON: ${error.message}`);
  }
};

/**
 * Refuses a home whose upgrade move has not run: its grants and sessions
 * would still be at the old paths, and a snapshot of the new layout would
 * silently miss them.
 */
export const assertMigrated = async (home) => {
  const stamp = await readJsonIfPresent(path.join(home, 'state.json'));
  const applied = Array.isArray(stamp?.applied) ? stamp.applied : [];
  const missing = REQUIRED_MIGRATIONS.filter((id) => !applied.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `${home} has not finished its upgrade (${missing.join(', ')} not applied), so a backup would miss state still at the old paths. `
        + 'Run `stratus update` or start the daemon once, then try again.',
    );
  }
};

/** The trusted config file in force: --config, then STRATUS_CONFIG, then the home's own. */
export const resolveConfigPath = (home, { configPath, env = process.env, cwd = process.cwd() } = {}) => {
  const explicit = configPath ?? env.STRATUS_CONFIG;
  if (explicit) return { file: path.resolve(cwd, explicit), source: configPath ? '--config' : 'STRATUS_CONFIG' };
  return { file: path.join(home, 'config.json'), source: 'default' };
};

const frontmatterHasId = (text) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match !== null && /^(id|name):\s*\S/m.test(match[1]);
};

/** Whether every directory on the walk still is the one that was checked. */
const sameDirectories = async (chain) => {
  for (const { dir, dev, ino } of chain) {
    const info = await lstat(dir).catch(() => undefined);
    if (!info || !info.isDirectory() || info.dev !== dev || info.ino !== ino) return false;
  }
  return true;
};

/**
 * Walks a skills tree: regular files only, no nested .git, no links, no
 * hard-linked files. readdir and open follow a link, so each directory, the
 * root included, is checked with lstat first, and the whole chain of
 * directories down to it is checked again after it is listed and after each
 * file is read: a directory swapped for a link meanwhile is skipped, along
 * with anything read through it. Node has no openat, so a swap made and
 * undone between two checks is not seen; that takes a writer racing the walk
 * on purpose, which could as well copy the file into the skills tree.
 * `hooks.beforeList(dir)` and `hooks.beforeLstat(path)` are test seams.
 */
export const walkSkills = async (dir, relative, entries, skipped, hooks = {}, parents = []) => {
  let names;
  let chain;
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink()) {
      skipped.push({ path: relative, reason: 'symbolic link' });
      return;
    }
    if (!info.isDirectory()) {
      skipped.push({ path: relative, reason: 'not a directory' });
      return;
    }
    chain = [...parents, { dir, dev: info.dev, ino: info.ino }];
    await hooks.beforeList?.(dir);
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!(await sameDirectories(chain))) {
    skipped.push({ path: relative, reason: 'changed while it was read' });
    return;
  }
  names.sort();
  for (const name of names) {
    const full = path.join(dir, name);
    const rel = `${relative}/${name}`;
    // A worktree or submodule has a .git file, not a directory, and its
    // gitdir pointer names a local path, so the name decides before the type.
    if (name === '.git') {
      skipped.push({ path: rel, reason: 'nested git metadata' });
      continue;
    }
    await hooks.beforeLstat?.(full);
    let info;
    try {
      info = await lstat(full);
    } catch (error) {
      // Removed or renamed since the listing: a skill being installed or
      // cleaned up, skipped like any other entry that changed mid-walk.
      if (error.code !== 'ENOENT') throw error;
      skipped.push({ path: rel, reason: 'changed while it was read' });
      continue;
    }
    if (info.isDirectory()) {
      await walkSkills(full, rel, entries, skipped, hooks, chain);
    } else if (info.isSymbolicLink()) {
      skipped.push({ path: rel, reason: 'symbolic link' });
    } else if (!info.isFile()) {
      skipped.push({ path: rel, reason: 'not a regular file' });
    } else if (info.nlink > 1) {
      skipped.push({ path: rel, reason: 'hard link' });
    } else {
      try {
        await hooks.beforeRead?.(full);
        const { bytes, mode, nlink } = await readStable(full);
        if (!(await sameDirectories(chain))) throw new UnstableFileError(`${full} moved while it was read.`);
        // The file opened may not be the one checked above: judge its own link count.
        if (nlink > 1) {
          skipped.push({ path: rel, reason: 'hard link' });
          continue;
        }
        entries.push({ path: rel, bytes, executable: (mode & 0o111) !== 0 });
      } catch (error) {
        if (!(error instanceof UnstableFileError) && error.code !== 'ELOOP') throw error;
        skipped.push({ path: rel, reason: 'changed while it was read' });
      }
    }
  }
};

/** Fails the run when a directory on the way to a required file was swapped. */
const assertSameDirectories = async (chain, file) => {
  if (!(await sameDirectories(chain))) {
    throw new UnstableFileError(`A directory on the way to ${file} changed while it was read (replaced by a link, say). Not running; try again.`);
  }
};

/**
 * A required state file: missing is fine, anything else unusual fails the
 * run. `chain` is the directories checked on the way to it, rechecked after
 * the read, since open follows a directory swapped for a link.
 */
const addRequired = async (entries, file, rel, { chain = [], hooks = {}, ...options } = {}) => {
  await hooks.beforeRead?.(file);
  // Missing is only believed once the directories on the way are the ones
  // checked: a replaced agent directory lacking the file would otherwise
  // be committed as that file deleted. A file that is there but cannot be
  // opened (a dangling soul link) still fails the run.
  if (!(await exists(file))) {
    await assertSameDirectories(chain, file);
    return undefined;
  }
  const { bytes, mode, nlink } = await readStable(file, options);
  await assertSameDirectories(chain, file);
  if (nlink > 1) throw new Error(`${file} has another hard link. Break the link (copy the file over itself) and try again.`);
  entries.push({ path: rel, bytes, executable: false });
  return { bytes, mode };
};

/** Schedules as one JSON line per row, ordered by id, so a snapshot diffs cleanly. */
export const exportSchedules = (fleetDb) => {
  const db = new DatabaseSync(fleetDb, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get();
    if (!table) return Buffer.alloc(0);
    const rows = db.prepare('SELECT id, agent_id, next_fire_at, body, created_at FROM schedules ORDER BY id').all();
    return Buffer.from(rows.map((row) => JSON.stringify({ ...row })).join('\n') + (rows.length > 0 ? '\n' : ''));
  } finally {
    db.close();
  }
};

/**
 * The whole snapshot. Returns plaintext entries (still unredacted except
 * the config, which is redacted structurally here) and the manifest facts
 * restore needs.
 */
export const buildSnapshot = async (home, { configPath, env, cwd, hooks = {} } = {}) => {
  await assertMigrated(home);
  const entries = [];
  const skipped = [];
  const manifest = { format: 1, config: undefined, redactedConfigPaths: [], soulsWithoutId: [], skipped };

  const config = resolveConfigPath(home, { configPath, env, cwd });
  const present = await exists(config.file);
  if (!present && config.source !== 'default') {
    // An absent default config is a valid home; an absent one that was named is a mistake to stop on.
    throw new Error(`The config named by ${config.source}, ${config.file}, does not exist, so the backup would leave it out. Not running.`);
  }
  if (present) {
    const { bytes } = await readStable(config.file, { follow: true });
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error(`${config.file} is not valid JSON, so it cannot be redacted. Fix it and try again.`);
    }
    if (parsed.memoryStore !== undefined && parsed.memoryStore !== 'file') {
      throw new Error(
        `The config selects memory store ${JSON.stringify(parsed.memoryStore)}. stratus-backup only knows the built-in file store, so it would back up no memories. Not running.`,
      );
    }
    const { config: redacted, replaced } = redactConfig(parsed);
    entries.push({ path: 'home/config.json', bytes: Buffer.from(`${JSON.stringify(redacted, null, 2)}\n`), executable: false });
    manifest.config = { source: config.source, path: config.file };
    manifest.redactedConfigPaths = replaced;
  }

  await addRequired(entries, path.join(home, 'state.json'), 'home/state.json');

  const agentsDir = path.join(home, 'agents');
  let agentNames = [];
  let agentsChain = [];
  try {
    const info = await lstat(agentsDir);
    if (info.isSymbolicLink()) throw new Error(`${agentsDir} is a symbolic link, which Stratus itself refuses. Not running.`);
    agentsChain = [{ dir: agentsDir, dev: info.dev, ino: info.ino }];
    await hooks.beforeList?.(agentsDir);
    agentNames = (await readdir(agentsDir)).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // readdir follows a directory swapped for a link after its lstat.
  await assertSameDirectories(agentsChain, agentsDir);
  for (const name of agentNames) {
    const full = path.join(agentsDir, name);
    const info = await lstat(full);
    if (name.endsWith('.md')) {
      // A soul may be a link: templates keep a soul edited in its own checkout.
      const soul = await addRequired(entries, full, `home/agents/${name}`, { follow: true, chain: agentsChain, hooks });
      if (soul && !frontmatterHasId(soul.bytes.toString('utf8'))) manifest.soulsWithoutId.push(name);
    } else if (info.isDirectory() && AGENT_ID.test(name)) {
      const chain = [...agentsChain, { dir: full, dev: info.dev, ino: info.ino }];
      for (const file of ['memory.jsonl', 'whitelist.json']) {
        await addRequired(entries, path.join(full, file), `home/agents/${name}/${file}`, { chain, hooks });
      }
    } else if (info.isSymbolicLink() && !name.endsWith('.md')) {
      throw new Error(`${full} is a symbolic link, which Stratus itself refuses. Not running.`);
    }
  }

  await walkSkills(path.join(home, 'skills'), 'home/skills', entries, skipped);

  const fleetDb = path.join(home, 'fleet.db');
  if (await exists(fleetDb)) {
    entries.push({ path: 'home/schedules.jsonl', bytes: exportSchedules(fleetDb), executable: false });
  }

  return { entries, manifest };
};
