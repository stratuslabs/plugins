// Encrypted snapshots: every file is age ciphertext before it is committed,
// so the remote holds nothing readable without the identity, which never
// lives on this machine.
//
// A branch holds, at its root:
//   format.json   plaintext marker, { "format": "stratus-backup/age-v1" }
//   index.age     ciphertext of { entries: [{ path, blob, executable, sha256 }], manifest }
//   blobs/<id>.age   one file's ciphertext under a random name
// Real paths exist only inside index.age.
//
// age output is randomized, so an unchanged file must keep its committed
// ciphertext or every night would rewrite every blob. encryption-cache.json,
// beside the repository and never committed, maps each path to the sha256
// of its plaintext and the blob that holds it. The cache is keyed on the
// recipients: change them and everything is encrypted again.

import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';

export const FORMAT = 'stratus-backup/age-v1';
export const FORMAT_FILE = 'format.json';
export const INDEX_FILE = 'index.age';
const BLOB = /^blobs\/([0-9a-f]{32})\.age$/;

/**
 * What a snapshot holds, by kind. Each kind is encrypted or not on its own;
 * souls and memory are plaintext by default so their history stays readable
 * in git, and everything else is encrypted.
 */
export const CATEGORIES = ['souls', 'memory', 'grants', 'skills', 'config', 'schedules', 'state'];
export const DEFAULT_ENCRYPTED = ['grants', 'skills', 'config', 'schedules', 'state'];

/** The kind of a snapshot path (home/...). */
export const categoryOf = (file) => {
  if (file === 'home/config.json') return 'config';
  if (file === 'home/state.json') return 'state';
  if (file === 'home/schedules.jsonl') return 'schedules';
  if (file.startsWith('home/skills/')) return 'skills';
  if (/^home\/agents\/[^/]+\.md$/.test(file)) return 'souls';
  if (/^home\/agents\/[^/]+\/memory\.jsonl$/.test(file)) return 'memory';
  if (/^home\/agents\/[^/]+\/whitelist\.json$/.test(file)) return 'grants';
  // Anything the snapshot adds later is encrypted until it is given a kind.
  return 'other';
};

/**
 * The kinds to encrypt, from `--encrypt`: a list of kinds, "all", "none",
 * or undefined for the default. "other" is encrypted whenever anything is.
 */
export const parseEncrypt = (value) => {
  if (value === undefined) return [...DEFAULT_ENCRYPTED];
  const words = (Array.isArray(value) ? value : String(value).split(',')).flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
  if (words.length === 1 && words[0] === 'all') return [...CATEGORIES];
  if (words.length === 1 && words[0] === 'none') return [];
  for (const word of words) {
    if (!CATEGORIES.includes(word)) throw new Error(`${JSON.stringify(word)} is not something a backup holds. Name kinds from: ${CATEGORIES.join(', ')}, or all, or none.`);
  }
  return CATEGORIES.filter((category) => words.includes(category));
};

/** Whether a snapshot path is encrypted under these settings' kinds. */
export const isEncryptedPath = (file, encrypt) => encrypt.length > 0 && (categoryOf(file) === 'other' || encrypt.includes(categoryOf(file)));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Writes a new age identity to `file` (0600, never over an existing file)
 * and returns its recipient.
 */
export const keygen = async (file) => {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${file} already exists. keygen never overwrites an identity; pick another path.`);
    throw error;
  }
  try {
    await handle.writeFile(`# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`);
  } finally {
    await handle.close();
  }
  return { recipient };
};

/** Throws, naming it, for a recipient age cannot encrypt to. */
export const assertRecipients = (recipients) => {
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('Name at least one --recipient (an age1... public key).');
  for (const recipient of recipients) {
    try {
      new Encrypter().addRecipient(recipient);
    } catch {
      throw new Error(`${JSON.stringify(recipient)} is not an age recipient (an age1... public key, as \`stratus-backup keygen\` prints).`);
    }
  }
};

const recipientsKey = (recipients) => sha256([...recipients].sort().join('\n'));

const encrypt = async (recipients, bytes) => {
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return Buffer.from(await encrypter.encrypt(bytes));
};

const readCache = async (file, key) => {
  try {
    const cache = JSON.parse(await readFile(file, 'utf8'));
    if (cache.recipients === key && cache.files && typeof cache.files === 'object') return cache;
  } catch {
    // Missing or unreadable: everything is encrypted again, which is only slower.
  }
  return { recipients: key, files: {}, index: undefined };
};

const writeCache = async (file, cache) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  await rename(temporary, file);
};

/**
 * The tree entries for an encrypted snapshot of `entries`, reusing the
 * ciphertext the parent commit already holds for any file whose plaintext
 * has not changed. `parentTree` maps each path in the parent commit to its
 * blob oid. Returns { entries, saveCache }; call saveCache once the commit
 * is made.
 */
export const encryptSnapshot = async ({ entries, manifest, recipients, cacheFile, parentTree }) => {
  const key = recipientsKey(recipients);
  const cache = await readCache(cacheFile, key);
  const next = { recipients: key, files: {}, index: undefined };
  const out = [{ path: FORMAT_FILE, bytes: Buffer.from(`${JSON.stringify({ format: FORMAT })}\n`), executable: false }];
  const index = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const digest = sha256(entry.bytes);
    const cached = cache.files[entry.path];
    const cachedPath = cached && `blobs/${cached.blob}.age`;
    let blob;
    if (cached && cached.sha256 === digest && parentTree.get(cachedPath) === cached.oid) {
      blob = cached.blob;
      out.push({ path: cachedPath, oid: cached.oid, executable: false });
      next.files[entry.path] = cached;
    } else {
      blob = randomBytes(16).toString('hex');
      const bytes = await encrypt(recipients, entry.bytes);
      const pending = { path: `blobs/${blob}.age`, bytes, executable: false };
      out.push(pending);
      next.files[entry.path] = { sha256: digest, blob, pending };
    }
    index.push({ path: entry.path, blob, executable: entry.executable === true, sha256: digest });
  }
  const indexBytes = Buffer.from(JSON.stringify({ entries: index, manifest }));
  const indexDigest = sha256(indexBytes);
  if (cache.index && cache.index.sha256 === indexDigest && parentTree.get(INDEX_FILE) === cache.index.oid) {
    out.push({ path: INDEX_FILE, oid: cache.index.oid, executable: false });
    next.index = cache.index;
  } else {
    const pending = { path: INDEX_FILE, bytes: await encrypt(recipients, indexBytes), executable: false };
    out.push(pending);
    next.index = { sha256: indexDigest, pending };
  }
  /** Records the oids git gave the new blobs, so the next run can reuse them. */
  const saveCache = async (oidOf) => {
    const settle = (record) => {
      if (!record.pending) return record;
      const { pending, ...rest } = record;
      return { ...rest, oid: oidOf(pending.path) };
    };
    const files = {};
    for (const [file, record] of Object.entries(next.files)) files[file] = settle(record);
    await writeCache(cacheFile, { recipients: key, files, index: settle(next.index) });
  };
  return { entries: out, saveCache };
};

/** Whether a tree (the paths of a commit) is an encrypted snapshot. */
export const isEncryptedTree = (paths) => paths.includes(FORMAT_FILE);

/**
 * Decrypts an encrypted snapshot. `read(path)` returns the bytes of a path
 * in the commit. Returns { manifest, files: [{ path, executable, bytes }] },
 * each file checked against the sha256 the index recorded. Nothing is
 * returned unless every file decrypts and matches.
 */
export const decryptSnapshot = async ({ paths, read, identity }) => {
  if (!identity) throw new Error('This backup is encrypted. Pass --identity <file> (or set STRATUS_BACKUP_IDENTITY) with the identity from `stratus-backup keygen`.');
  for (const file of paths) {
    // Plaintext kinds sit beside the ciphertext under home/; restore checks those.
    if (file !== FORMAT_FILE && file !== INDEX_FILE && !BLOB.test(file) && !file.startsWith('home/')) {
      throw new Error(`The snapshot holds an unexpected path, ${JSON.stringify(file)}. Not restoring.`);
    }
  }
  const format = JSON.parse((await read(FORMAT_FILE)).toString('utf8'));
  if (format.format !== FORMAT) throw new Error(`The snapshot is in format ${JSON.stringify(format.format)}, which this version cannot read.`);
  const decrypter = new Decrypter();
  try {
    decrypter.addIdentity(identity.split('\n').map((line) => line.trim()).find((line) => line.startsWith('AGE-SECRET-KEY-')) ?? identity.trim());
  } catch {
    throw new Error('The --identity file does not hold an age identity (a line starting AGE-SECRET-KEY-).');
  }
  const open = async (file, bytes) => {
    try {
      return Buffer.from(await decrypter.decrypt(bytes));
    } catch (error) {
      throw new Error(`Could not decrypt ${file} with this identity (${error.message}). Is it the identity this backup was made for?`);
    }
  };
  if (!paths.includes(INDEX_FILE)) throw new Error('The snapshot has no index.age. Not restoring.');
  const index = JSON.parse((await open(INDEX_FILE, await read(INDEX_FILE))).toString('utf8'));
  const files = [];
  for (const entry of index.entries) {
    const blobPath = `blobs/${entry.blob}.age`;
    if (!/^[0-9a-f]{32}$/.test(String(entry.blob)) || !paths.includes(blobPath)) {
      throw new Error(`The index names ${JSON.stringify(entry.path)} in a blob the snapshot does not hold. Not restoring.`);
    }
    const bytes = await open(blobPath, await read(blobPath));
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`${entry.path} does not match the checksum the index recorded for it. The backup may have been tampered with. Not restoring.`);
    }
    files.push({ path: entry.path, executable: entry.executable === true, bytes });
  }
  return { manifest: index.manifest ?? {}, files };
};
