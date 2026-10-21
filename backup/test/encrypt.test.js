import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { init, now, repoDir } from '../src/backup.js';
import { keygen } from '../src/encrypt.js';
import { main } from '../src/cli.js';
import { restore } from '../src/restore.js';
import { NAMED, bareRemote, makeHome, notFound, refOf, tmp } from './helpers.js';

const git = (repo, ...args) => execFileSync('git', ['--git-dir', repo, ...args]);

/** Every blob in a ref as { path: Buffer }. */
const rawTree = (repo, ref) => {
  const files = {};
  for (const line of git(repo, 'ls-tree', '-r', '--full-tree', ref).toString().split('\n').filter(Boolean)) {
    const [meta, file] = line.split('\t');
    files[file] = git(repo, 'cat-file', 'blob', meta.split(' ')[2]);
  }
  return files;
};

const blobOids = (repo, ref) => new Map(
  git(repo, 'ls-tree', '-r', '--full-tree', ref).toString().split('\n').filter(Boolean)
    .map((line) => { const [meta, file] = line.split('\t'); return [file, meta.split(' ')[2]]; }),
);

const newKey = async () => {
  const file = path.join(tmp(), 'identity.txt');
  const { recipient } = await keygen(file);
  return { file, recipient, identity: readFileSync(file, 'utf8') };
};

/** A home backing up with every kind encrypted, unless `encrypt` says otherwise (undefined: the default kinds). */
const setUpEncrypted = async (options = { encrypt: 'all' }) => {
  const { encrypt } = options;
  const fixture = makeHome();
  const remote = bareRemote();
  const key = await newKey();
  await init(fixture.home, remote, { branch: 'mini', recipients: [key.recipient], encrypt, fetchImpl: notFound });
  return { ...fixture, remote, key };
};

/** Every file under dir as { relative: { text, mode } }. */
const listing = (dir) => {
  const out = {};
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = path.join(at, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = { bytes: readFileSync(full).toString('base64'), mode: stat.mode & 0o777 };
    }
  };
  walk(dir);
  return out;
};

test('keygen writes a private identity, never over an existing file, and prints the recipient that opens it', async () => {
  const file = path.join(tmp(), 'identity.txt');
  const { recipient } = await keygen(file);
  assert.match(recipient, /^age1[0-9a-z]+$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8'), /^AGE-SECRET-KEY-1[0-9A-Z]+$/m);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(keygen(file), /already exists/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('init without a recipient or --plaintext is refused, and nothing is saved', async () => {
  const { home } = makeHome();
  await assert.rejects(init(home, bareRemote(), { branch: 'mini', fetchImpl: notFound }), /encrypt grants, skills, config, schedules, state by default.*keygen.*--plaintext/s);
  await assert.rejects(init(home, bareRemote(), { branch: 'mini', encrypt: 'souls,diaries', recipients: [(await newKey()).recipient], fetchImpl: notFound }), /"diaries" is not something a backup holds/);
  await assert.rejects(init(home, bareRemote(), { branch: 'mini', encrypt: 'none', recipients: [(await newKey()).recipient], fetchImpl: notFound }), /Nothing is set to be encrypted/);
  await assert.rejects(init(home, bareRemote(), { branch: 'mini', plaintext: true, encrypt: 'all', fetchImpl: notFound }), /Pick one/);
  assert.equal(existsSync(path.join(home, 'backup', 'settings.json')), false);
  await assert.rejects(init(home, bareRemote(), { branch: 'mini', recipients: ['not-a-recipient'], fetchImpl: notFound }), /not-a-recipient/);
  assert.equal(existsSync(path.join(home, 'backup', 'settings.json')), false);
});

test('an encrypted run pushes only ciphertext under opaque names', async () => {
  const { home, remote } = await setUpEncrypted();
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  const tree = rawTree(remote, 'refs/heads/mini');
  const paths = Object.keys(tree);
  assert.ok(paths.includes('format.json') && paths.includes('index.age'), paths.join(', '));
  for (const file of paths) {
    assert.ok(file === 'format.json' || file === 'index.age' || /^blobs\/[0-9a-f]{32}\.age$/.test(file), file);
    assert.ok(!/blair|notes|memory|skill|soul/i.test(file), file);
  }
  assert.deepEqual(JSON.parse(tree['format.json'].toString()), { format: 'stratus-backup/age-v1' });
  for (const [file, bytes] of Object.entries(tree)) {
    if (file === 'format.json') continue;
    assert.ok(bytes.subarray(0, 21).toString() === 'age-encryption.org/v1', file);
    for (const plain of ['You are Blair.', 'The launch is on Friday.', 'Morning digest', '# Notes']) {
      assert.ok(!bytes.includes(Buffer.from(plain)), `${file} holds ${plain}`);
    }
  }
});

test('an unchanged home makes no commit; one changed memory changes one blob and the index', async () => {
  const { home, remote } = await setUpEncrypted();
  const first = await now(home, { env: {}, fetchImpl: notFound });
  const again = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(again.unchanged, true);
  assert.equal(refOf(remote, 'refs/heads/mini'), first.commit);

  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ id: 'm9', agentId: 'blair', content: 'New fact.' })}\n`);
  const changed = await now(home, { env: {}, fetchImpl: notFound });
  const before = blobOids(remote, first.commit);
  const after = blobOids(remote, changed.commit);
  const differing = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
  assert.equal(differing.filter((file) => file.startsWith('blobs/')).length, 2, differing.join(', ')); // one removed, one added
  assert.ok(differing.includes('index.age'));
  assert.ok(!differing.includes('format.json'));
});

test('restore with the identity gives back the same home a plaintext backup does; without it, or with another, nothing is written', async () => {
  const { home, remote, key } = await setUpEncrypted();
  const encrypted = await now(home, { env: {}, fetchImpl: notFound });

  const plainRemote = bareRemote();
  const plain = makeHome();
  rmSync(plain.home, { recursive: true });
  execFileSync('cp', ['-Rp', home, plain.home]);
  rmSync(path.join(plain.home, 'backup'), { recursive: true });
  await init(plain.home, plainRemote, { plaintext: true, branch: 'mini', fetchImpl: notFound });
  await now(plain.home, { env: {}, fetchImpl: notFound });

  const fromPlain = path.join(tmp(), 'plain');
  await restore(fromPlain, { remote: plainRemote, branch: 'mini' });
  const fromCipher = path.join(tmp(), 'cipher');
  const result = await restore(fromCipher, { remote, branch: 'mini', identity: key.identity });
  assert.equal(result.commit, encrypted.commit);
  assert.deepEqual(listing(fromCipher), listing(fromPlain));
  assert.ok(result.manifest && Array.isArray(result.manifest.redactedConfigPaths));

  const noKey = path.join(tmp(), 'nokey');
  await assert.rejects(restore(noKey, { remote, branch: 'mini' }), /encrypted.*--identity/s);
  assert.equal(existsSync(noKey) && readdirSync(noKey).length > 0, false);
  const other = await newKey();
  const wrong = path.join(tmp(), 'wrong');
  await assert.rejects(restore(wrong, { remote, branch: 'mini', identity: other.identity }), /identity/);
  assert.equal(existsSync(wrong) && readdirSync(wrong).length > 0, false);
});

test('a blob that does not decrypt to what the index recorded stops the restore', async () => {
  const { home, remote, key } = await setUpEncrypted();
  await now(home, { env: {}, fetchImpl: notFound });
  // Swap two blobs' contents under their names: each still decrypts, to the wrong file.
  const clone = path.join(tmp(), 'clone');
  execFileSync('git', ['clone', '--quiet', '--branch', 'mini', remote, clone]);
  const blobs = readdirSync(path.join(clone, 'blobs')).sort();
  const [a, b] = blobs.map((name) => path.join(clone, 'blobs', name));
  const bytesA = readFileSync(a);
  writeFileSync(a, readFileSync(b));
  writeFileSync(b, bytesA);
  execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'tamper']);
  execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'mini']);
  const target = path.join(tmp(), 'tampered');
  await assert.rejects(restore(target, { remote, branch: 'mini', identity: key.identity }), /does not match|checksum/);
  assert.equal(existsSync(target) && readdirSync(target).length > 0, false);
});

test('changing recipients re-encrypts every blob, and the new identity restores it', async () => {
  const { home, remote } = await setUpEncrypted();
  const first = await now(home, { env: {}, fetchImpl: notFound });
  const next = await newKey();
  await init(home, remote, { branch: 'mini', recipients: [next.recipient], fetchImpl: notFound });
  const second = await now(home, { env: {}, fetchImpl: notFound });
  const before = new Set([...blobOids(remote, first.commit).entries()].filter(([file]) => file.startsWith('blobs/')).map(([, oid]) => oid));
  const after = [...blobOids(remote, second.commit).entries()].filter(([file]) => file.startsWith('blobs/')).map(([, oid]) => oid);
  assert.ok(after.length > 0 && after.every((oid) => !before.has(oid)));
  const target = path.join(tmp(), 'rotated');
  await restore(target, { remote, branch: 'mini', identity: next.identity });
  assert.ok(existsSync(path.join(target, 'agents', 'blair.md')));
});

test('a key-shaped string warns on an encrypted run and still blocks a plaintext one', async () => {
  const shaped = ['gh', 'p_', 'E'.repeat(36)].join('');
  const { home, remote } = await setUpEncrypted();
  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ id: 'm8', agentId: 'blair', content: `token ${shaped}` })}\n`);
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].kind, /GitHub/);
  assert.ok(!JSON.stringify(result.warnings).includes(shaped));
  assert.ok(refOf(remote, 'refs/heads/mini'));
});

test('by default souls and memory are plaintext and diffable, and everything else is encrypted', async () => {
  const { home, remote, key } = await setUpEncrypted({ encrypt: undefined });
  await now(home, { env: {}, fetchImpl: notFound });
  const tree = rawTree(remote, 'refs/heads/mini');
  const plainPaths = Object.keys(tree).filter((file) => file.startsWith('home/')).sort();
  assert.deepEqual(plainPaths, ['home/agents/blair.md', 'home/agents/blair/memory.jsonl', 'home/agents/nameless.md']);
  assert.match(tree['home/agents/blair.md'].toString(), /You are Blair\./);
  assert.ok(!('manifest.json' in tree), 'the manifest names files, so it is inside the encrypted index');
  for (const [file, bytes] of Object.entries(tree)) {
    if (file.startsWith('home/') || file === 'format.json') continue;
    for (const plain of ['Morning digest', '# Notes', 'git status', 'some-deploy-key', '0001-owner-only-state-files']) {
      assert.ok(!bytes.includes(Buffer.from(plain)), `${file} holds ${plain}`);
    }
  }
  const target = path.join(tmp(), 'mixed');
  await restore(target, { remote, branch: 'mini', identity: key.identity });
  for (const file of ['agents/blair.md', 'agents/blair/memory.jsonl', 'agents/blair/whitelist.json', 'skills/notes/SKILL.md', 'config.json', 'state.json', 'fleet.db']) {
    assert.ok(existsSync(path.join(target, file)), file);
  }
  await assert.rejects(restore(path.join(tmp(), 'mixed-nokey'), { remote, branch: 'mini' }), /--identity/);
});

test('a finding blocks the run in a plaintext kind and only warns in an encrypted one', async () => {
  const shaped = ['gh', 'p_', 'G'.repeat(36)].join('');
  const { home, remote } = await setUpEncrypted({ encrypt: undefined });
  mkdirSync(path.join(home, 'skills', 'leaky'), { recursive: true });
  writeFileSync(path.join(home, 'skills', 'leaky', 'SKILL.md'), `token ${shaped}\n`);
  const warned = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(warned.pushed, true);
  assert.equal(warned.warnings.length, 1);
  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ id: 'm7', agentId: 'blair', content: `token ${shaped}` })}\n`);
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /shaped like a secret/);
  assert.equal(refOf(remote, 'refs/heads/mini'), warned.commit);
});

test('a warning about an encrypted file name shows neither a stored secret nor the key-shaped text in it', async () => {
  // Codex P2 4318015833: scanPath replaced key-shaped text only, so a stored
  // credential in the same name reached the warning the CLI prints.
  const { home } = await setUpEncrypted();
  const token = ['gh', 'p_', 'F'.repeat(36)].join('');
  mkdirSync(path.join(home, 'skills', 'both'), { recursive: true });
  writeFileSync(path.join(home, 'skills', 'both', `${NAMED}-${token}.md`), 'harmless\n');
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  assert.ok(result.warnings.some((w) => /file name/.test(w.file)));
  const shown = JSON.stringify(result.warnings);
  assert.ok(!shown.includes(NAMED), shown);
  assert.ok(!shown.includes(token), shown);
});

test('encrypting a kind the branch history already holds in plaintext is allowed, with a warning from the whole history', async () => {
  // Codex P1 4318015818: the format was checked at the tip only.
  const plain = makeHome();
  const branchRemote = bareRemote();
  await init(plain.home, branchRemote, { plaintext: true, branch: 'mini', fetchImpl: notFound });
  await now(plain.home, { env: {}, fetchImpl: notFound });
  const key = await newKey();
  // Encrypt everything from now on: the tip becomes encrypted, older commits stay plaintext.
  const first = await init(plain.home, branchRemote, { branch: 'mini', recipients: [key.recipient], encrypt: 'all', fetchImpl: notFound });
  assert.deepEqual(first.plaintextInHistory, ['config', 'grants', 'memory', 'schedules', 'skills', 'souls', 'state']);
  await now(plain.home, { env: {}, fetchImpl: notFound });
  // The tip is fully encrypted now, but the history still is not.
  const again = await init(plain.home, branchRemote, { branch: 'mini', recipients: [key.recipient], encrypt: 'memory', fetchImpl: notFound });
  assert.deepEqual(again.plaintextInHistory, ['memory']);
  // A new branch has no such history.
  const fresh = await init(plain.home, branchRemote, { branch: 'clean', recipients: [key.recipient], encrypt: 'all', fetchImpl: notFound });
  assert.deepEqual(fresh.plaintextInHistory, []);
});

test('a lost encryption cache re-encrypts once, and the backup still restores', async () => {
  const { home, remote, key } = await setUpEncrypted();
  const first = await now(home, { env: {}, fetchImpl: notFound });
  rmSync(path.join(home, 'backup', 'encryption-cache.json'));
  const second = await now(home, { env: {}, fetchImpl: notFound });
  assert.notEqual(second.commit, first.commit);
  const third = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(third.unchanged, true);
  const target = path.join(tmp(), 'after-loss');
  await restore(target, { remote, branch: 'mini', identity: key.identity });
  assert.ok(existsSync(path.join(target, 'agents', 'blair', 'memory.jsonl')));
  assert.equal(statSync(path.join(repoDir(home), '..', 'encryption-cache.json')).mode & 0o777, 0o600);
});

test('a cached blob the repository no longer holds is encrypted again, not referenced', async () => {
  const { home, key } = await setUpEncrypted();
  await now(home, { env: {}, fetchImpl: notFound });
  // A fresh repository (as after a failed init's repository is moved aside)
  // and a new branch: none of the cached ciphertext is in it.
  rmSync(repoDir(home), { recursive: true });
  const remote = bareRemote();
  await init(home, remote, { branch: 'fresh', recipients: [key.recipient], fetchImpl: notFound });
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  const target = path.join(tmp(), 'fresh-restore');
  await restore(target, { remote, branch: 'fresh', identity: key.identity });
  assert.ok(existsSync(path.join(target, 'agents', 'blair.md')));
});

test('the CLI: keygen, init --recipient, now, then restore with --identity or STRATUS_BACKUP_IDENTITY', async () => {
  const { userHome, home } = makeHome();
  const remote = bareRemote();
  const lines = [];
  const env = { HOME: userHome, PATH: process.env.PATH };
  const run = (...argv) => main(argv, { env, cwd: userHome, out: (line) => lines.push(line) });
  await run('keygen', '--out', 'key.txt');
  const recipient = lines.join('\n').match(/age1[0-9a-z]+/)[0];
  await assert.rejects(run('init', remote, '--branch', 'mini'), /keygen/);
  await run('init', remote, '--branch', 'mini', '--recipient', recipient);
  await run('now');
  await run('status');
  assert.match(lines.join('\n'), /encrypting grants, skills, config, schedules, state to 1 recipient/);
  await assert.rejects(run('restore', path.join(tmp(), 'a'), '--offline'), /--identity/);
  const target = path.join(tmp(), 'b');
  await run('restore', target, '--offline', '--identity', path.join(userHome, 'key.txt'));
  assert.ok(existsSync(path.join(target, 'agents', 'blair.md')));
  const viaEnv = path.join(tmp(), 'c');
  await main(['restore', viaEnv, '--remote', remote, '--branch', 'mini'], { env: { ...env, STRATUS_BACKUP_IDENTITY: path.join(userHome, 'key.txt') }, cwd: userHome, out: () => {} });
  assert.ok(existsSync(path.join(viaEnv, 'agents', 'blair.md')));
  assert.ok(!existsSync(path.join(home, 'backup', 'key.txt')));
});

test('a snapshot holding one file both in plaintext and encrypted is not restored', async () => {
  const { home, remote, key } = await setUpEncrypted();
  await now(home, { env: {}, fetchImpl: notFound });
  const clone = path.join(tmp(), 'clone');
  execFileSync('git', ['clone', '--quiet', '--branch', 'mini', remote, clone]);
  mkdirSync(path.join(clone, 'home'), { recursive: true });
  writeFileSync(path.join(clone, 'home', 'state.json'), '{"planted":true}\n');
  execFileSync('git', ['-C', clone, 'add', '.']);
  execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'plant']);
  execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'mini']);
  const target = path.join(tmp(), 'planted');
  await assert.rejects(restore(target, { remote, branch: 'mini', identity: key.identity }), /both in plaintext and encrypted/);
  assert.equal(existsSync(target) && readdirSync(target).length > 0, false);
});
