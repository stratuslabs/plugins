import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FindingsError, allow, assertNotPublic, githubRepoOf, init, now, repoDir, status } from '../src/backup.js';
import { restore } from '../src/restore.js';
import { REDACTED } from '../src/secrets.js';
import { GATEWAY, NAMED, SLACK_BOT, bareRemote, makeHome, notFound, refOf, tmp, treeOf } from './helpers.js';

const setUp = async () => {
  const fixture = makeHome();
  const remote = bareRemote();
  await init(fixture.home, remote, { branch: 'mini', fetchImpl: notFound });
  return { ...fixture, remote };
};

test('a snapshot carries the durable state and none of the secrets, sessions, workspaces or logs', async () => {
  const { home, remote } = await setUp();
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  assert.equal(refOf(remote, 'refs/heads/mini'), result.commit);

  const files = treeOf(remote, 'refs/heads/mini');
  assert.deepEqual(Object.keys(files).sort(), [
    'home/agents/blair.md',
    'home/agents/blair/memory.jsonl',
    'home/agents/blair/whitelist.json',
    'home/agents/nameless.md',
    'home/config.json',
    'home/schedules.jsonl',
    'home/skills/notes/SKILL.md',
    'home/skills/notes/run.sh',
    'home/state.json',
    'manifest.json',
  ]);
  const everything = Object.values(files).join('\n');
  for (const secret of [SLACK_BOT, NAMED, Buffer.from(NAMED).toString('base64'), GATEWAY, 'some-deploy-key']) {
    assert.ok(!everything.includes(secret), `snapshot holds ${secret.slice(0, 6)}...`);
  }
  assert.match(files['home/agents/blair/memory.jsonl'], /The launch is on Friday/);
  assert.ok(files['home/agents/blair/memory.jsonl'].includes(REDACTED));
  const config = JSON.parse(files['home/config.json']);
  assert.equal(config.plugins['@stratusagent/tool-shell'].env.DEPLOY_KEY, REDACTED);
  assert.equal(config.api.port, 4242);
  assert.match(files['home/schedules.jsonl'], /Morning digest/);
  assert.doesNotMatch(files['home/schedules.jsonl'], /sess-1/);

  const manifest = JSON.parse(files['manifest.json']);
  assert.deepEqual(manifest.soulsWithoutId, ['nameless.md']);
  assert.deepEqual(manifest.redactedConfigPaths, ['plugins.@stratusagent/tool-shell.env.DEPLOY_KEY']);
  assert.deepEqual(manifest.skipped.map((s) => s.path).sort(), ['home/skills/notes/.git', 'home/skills/notes/hosts']);
});

test('an unchanged home makes no commit, and a change makes one on top of the last', async () => {
  const { home, remote } = await setUp();
  const first = await now(home, { env: {}, fetchImpl: notFound });
  const second = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(second.unchanged, true);
  assert.equal(second.pushed, false);
  assert.equal(refOf(remote, 'refs/heads/mini'), first.commit);

  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ id: 'm4', agentId: 'blair', content: 'New fact.' })}\n`);
  const third = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(third.unchanged, false);
  assert.equal(refOf(remote, `${third.commit}^`), first.commit);
  assert.equal(refOf(remote, 'refs/heads/mini'), third.commit);
});

test('text shaped like an unknown key stops the run before anything is committed, until allowed', async () => {
  const { home, remote } = await setUp();
  const token = ['gh', 'p_', 'A'.repeat(36)].join('');
  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ id: 'm9', agentId: 'blair', content: `token ${token}` })}\n`);
  let failure;
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), (error) => {
    failure = error;
    return error instanceof FindingsError;
  });
  assert.equal(failure.findings.length, 1);
  assert.equal(failure.findings[0].file, 'home/agents/blair/memory.jsonl');
  assert.equal(failure.findings[0].line, 4);
  assert.ok(!failure.message.includes(token), 'the error must not carry the matched text');
  assert.equal(refOf(repoDir(home), 'refs/heads/mini'), undefined);
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
  assert.equal((await status(home)).last.ok, false);

  await allow(home, failure.findings[0].id);
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
});

test('a home whose upgrade move has not run is refused', async () => {
  const { home } = makeHome({ applied: ['0001-owner-only-state-files'] });
  await init(home, bareRemote(), { branch: 'mini', fetchImpl: notFound });
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /has not finished its upgrade.*stratus update/s);
});

test('a memory store this cannot read is refused rather than backed up empty', async () => {
  const { home } = await setUp();
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ memoryStore: 'sqlite' }));
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /memory store "sqlite"/);
});

test('the config named by STRATUS_CONFIG is the one backed up', async () => {
  const { home, remote } = await setUp();
  const elsewhere = path.join(tmp(), 'team.json');
  writeFileSync(elsewhere, JSON.stringify({ provider: 'openai', slack: { botToken: 'abc' } }));
  await now(home, { env: { STRATUS_CONFIG: elsewhere }, fetchImpl: notFound });
  const files = treeOf(remote, 'refs/heads/mini');
  assert.equal(JSON.parse(files['home/config.json']).provider, 'openai');
  assert.equal(JSON.parse(files['home/config.json']).slack.botToken, REDACTED);
  assert.equal(JSON.parse(files['manifest.json']).config.source, 'STRATUS_CONFIG');
});

test('a branch another writer moved is never pushed over', async () => {
  const { home, remote } = await setUp();
  await now(home, { env: {}, fetchImpl: notFound });
  const other = makeHome();
  await init(other.home, remote, { branch: 'mini', fetchImpl: notFound });
  writeFileSync(path.join(other.home, 'agents', 'blair.md'), '---\nid: blair\n---\nChanged elsewhere.\n');
  const theirs = await now(other.home, { env: {}, fetchImpl: notFound });

  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ id: 'm5', agentId: 'blair', content: 'Mine.' })}\n`);
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /commits this machine did not make/);
  assert.equal(refOf(remote, 'refs/heads/mini'), theirs.commit);
});

test('init on a new machine continues an existing branch', async () => {
  const { home, remote } = await setUp();
  const first = await now(home, { env: {}, fetchImpl: notFound });
  const replacement = makeHome();
  const result = await init(replacement.home, remote, { branch: 'mini', fetchImpl: notFound });
  assert.equal(result.adopted, true);
  const next = await now(replacement.home, { env: {}, fetchImpl: notFound });
  assert.equal(next.unchanged, false);
  assert.equal(refOf(remote, `${next.commit}^`), first.commit);
});

test('a public GitHub repository is refused, a private or unknown one is not', async () => {
  assert.equal(githubRepoOf('ssh://git@github.com:22/stratuslabs/home-backup.git'), 'stratuslabs/home-backup');
  assert.equal(githubRepoOf('https://github.com:443/stratuslabs/home-backup.git'), 'stratuslabs/home-backup');
  assert.equal(githubRepoOf('https://www.github.com/stratuslabs/home-backup'), 'stratuslabs/home-backup');
  assert.equal(githubRepoOf('git+ssh://git@GitHub.com/stratuslabs/home-backup.git'), 'stratuslabs/home-backup');
  assert.equal(githubRepoOf('github.com:stratuslabs/home-backup.git'), 'stratuslabs/home-backup');
  await assert.rejects(assertNotPublic('https://github.com:443/a/b.git', async () => ({ status: 200 })), /public repository/);
  await assert.rejects(assertNotPublic('https://github.com/a', async () => { throw new Error('must not be called'); }), /could not confirm/i);
  assert.equal(githubRepoOf('git@github.com:stratuslabs/home-backup.git'), 'stratuslabs/home-backup');
  assert.equal(githubRepoOf('https://github.com/stratuslabs/home-backup'), 'stratuslabs/home-backup');
  assert.equal(githubRepoOf('ssh://git@github.com/stratuslabs/home-backup.git'), 'stratuslabs/home-backup');
  assert.equal(githubRepoOf('/srv/backups/home.git'), undefined);
  await assert.rejects(assertNotPublic('git@github.com:a/b.git', async () => ({ status: 200 })), /public repository/);
  await assert.rejects(assertNotPublic('git@github.com:a/b.git', async () => ({ status: 403 })), /Could not confirm/);
  await assert.rejects(assertNotPublic('git@github.com:a/b.git', async () => { throw new Error('offline'); }), /Could not confirm/);
  await assertNotPublic('git@github.com:a/b.git', notFound);
  await assertNotPublic('/srv/backups/home.git', async () => { throw new Error('must not be called'); });
});

test('restore rebuilds the home in an empty directory, schedules included', async () => {
  const { home, remote } = await setUp();
  const snapshot = await now(home, { env: {}, fetchImpl: notFound });
  const target = path.join(tmp(), 'restored');
  const result = await restore(target, { remote, branch: 'mini' });
  assert.equal(result.commit, snapshot.commit);
  assert.equal(readFileSync(path.join(target, 'agents', 'blair.md'), 'utf8'), '---\nid: blair\n---\nYou are Blair.\n');
  assert.match(readFileSync(path.join(target, 'agents', 'blair', 'memory.jsonl'), 'utf8'), /The launch is on Friday/);
  assert.equal(statSync(path.join(target, 'agents', 'blair', 'memory.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(target, 'config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(target, 'skills', 'notes', 'run.sh')).mode & 0o777, 0o755);
  assert.equal(statSync(target).mode & 0o777, 0o700);
  const db = new DatabaseSync(path.join(target, 'fleet.db'), { readOnly: true });
  assert.deepEqual(db.prepare('SELECT id, agent_id FROM schedules').all().map((r) => ({ ...r })), [{ id: 's1', agent_id: 'blair' }]);
  db.close();
  assert.ok(!readdirSync(target).includes('credentials.json'));
  assert.ok(!readdirSync(target).includes('manifest.json'));
  assert.deepEqual(result.manifest.redactedConfigPaths, ['plugins.@stratusagent/tool-shell.env.DEPLOY_KEY']);
  assert.deepEqual(readdirSync(path.dirname(target)), ['restored'], 'no staging directory is left behind');
});

test('restore stops when it cannot check the remote for newer snapshots, unless asked to go offline', async () => {
  // Codex P1 4310180288: an unreachable origin silently restored the
  // cached local branch, which may be older than what the remote holds.
  const { home, remote } = await setUp();
  const snapshot = await now(home, { env: {}, fetchImpl: notFound });
  renameSync(remote, `${remote}.away`);
  const target = path.join(tmp(), 'restored');
  await assert.rejects(restore(target, { repo: repoDir(home), branch: 'mini' }), /Could not check origin for newer snapshots.*--offline/s);
  assert.ok(!existsSync(target), 'nothing restored');
  assert.deepEqual(readdirSync(path.dirname(target)), [], 'no staging directory is left behind');
  const result = await restore(target, { repo: repoDir(home), branch: 'mini', offline: true });
  assert.equal(result.commit, snapshot.commit, 'the local copy, on request');
});

test('restore never writes into a directory that holds anything', async () => {
  const { home, remote } = await setUp();
  await now(home, { env: {}, fetchImpl: notFound });
  const target = tmp();
  writeFileSync(path.join(target, 'keep.txt'), 'mine');
  await assert.rejects(restore(target, { remote, branch: 'mini' }), /is not empty/);
  assert.deepEqual(readdirSync(target), ['keep.txt']);
});

test('restore refuses a snapshot holding a link or a path outside home/', async () => {
  const remote = bareRemote();
  const blob = execFileSync('git', ['--git-dir', remote, 'hash-object', '-w', '--stdin'], { input: '/etc/passwd' }).toString().trim();
  const build = (mode, file) => {
    const index = path.join(tmp(), 'index');
    execFileSync('git', ['--git-dir', remote, 'update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`], { env: { ...process.env, GIT_INDEX_FILE: index } });
    const tree = execFileSync('git', ['--git-dir', remote, 'write-tree'], { env: { ...process.env, GIT_INDEX_FILE: index } }).toString().trim();
    return execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-m', 'x'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).toString().trim();
  };
  execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/link', build('120000', 'home/agents/blair.md')]);
  execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/outside', build('100644', 'elsewhere/x')]);
  const parent = tmp();
  await assert.rejects(restore(path.join(parent, 'a'), { remote, branch: 'link' }), /only ever holds plain files/);
  await assert.rejects(restore(path.join(parent, 'b'), { remote, branch: 'outside' }), /unexpected path/);
  assert.deepEqual(readdirSync(parent), []);
});

test('a second run while one holds the lock is refused; a lock left by a dead process is taken over', async () => {
  const { home } = await setUp();
  mkdirSync(path.join(home, 'backup'), { recursive: true });
  writeFileSync(path.join(home, 'backup', 'run.lock'), String(process.pid));
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /Another backup is running/);
  writeFileSync(path.join(home, 'backup', 'run.lock'), '999999');
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
});

test('a lock whose pid was reused by another process is taken over; one naming this process as it started is not', async () => {
  const { home } = await setUp();
  mkdirSync(path.join(home, 'backup'), { recursive: true });
  const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C' } }).toString().trim();
  writeFileSync(path.join(home, 'backup', 'run.lock'), `${process.pid}\n${started}`);
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /Another backup is running/);
  // Same pid, but the process holding it started at another time: the backup that wrote the lock is gone.
  writeFileSync(path.join(home, 'backup', 'run.lock'), `${process.pid}\nMon Jan  1 00:00:00 2001`);
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
});

test('a file name holding a known secret or a key-shaped value stops the run without naming it', async () => {
  const { home, remote } = await setUp();
  mkdirSync(path.join(home, 'skills', 'leak'), { recursive: true });
  writeFileSync(path.join(home, 'skills', 'leak', `${NAMED}.md`), 'harmless\n');
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), (error) => !error.message.includes(NAMED) && /file name/.test(error.message));
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);

  execFileSync('rm', ['-rf', path.join(home, 'skills', 'leak')]);
  mkdirSync(path.join(home, 'skills', 'shaped'), { recursive: true });
  const token = ['gh', 'p_', 'B'.repeat(36)].join('');
  writeFileSync(path.join(home, 'skills', 'shaped', token), 'harmless\n');
  let failure;
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), (error) => {
    failure = error;
    return error instanceof FindingsError;
  });
  assert.equal(failure.findings.length, 1);
  assert.ok(!failure.message.includes(token), 'the error must not carry the matched text');
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a file name holding a known secret and a key-shaped token shows neither', async () => {
  // Codex P2 4310391464: the known-secret path error ran before the key scan
  // and showed the other token verbatim.
  const { home, remote } = await setUp();
  const token = ['gh', 'p_', 'C'.repeat(36)].join('');
  mkdirSync(path.join(home, 'skills', 'both'), { recursive: true });
  writeFileSync(path.join(home, 'skills', 'both', `${NAMED}-${token}.md`), 'harmless\n');
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), (error) =>
    /file name/.test(error.message) && !error.message.includes(NAMED) && !error.message.includes(token));
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a known secret with characters JSON escapes is redacted inside a schedule body', async () => {
  const { home, remote } = await setUp();
  const secret = 'quote"back\\slash-0123456789';
  const credentials = JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8'));
  credentials.named.shared['odd.key'] = secret;
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
  const db = new DatabaseSync(path.join(home, 'fleet.db'));
  db.exec('CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, next_fire_at TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schedules VALUES (?, ?, ?, ?, ?)').run('s-odd', 'blair', '2026-10-16T00:00:00Z', JSON.stringify({ prompt: `use ${secret}` }), '2026-10-15T00:00:00Z');
  db.close();
  await now(home, { env: {}, fetchImpl: notFound });
  const schedules = execFileSync('git', ['--git-dir', remote, 'show', 'refs/heads/mini:home/schedules.jsonl'], { encoding: 'utf8' });
  const row = schedules.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((r) => r.id === 's-odd');
  assert.equal(JSON.parse(row.body).prompt, `use ${'[redacted by stratus-backup]'}`);
});

test('a remote git rewrites to GitHub is checked as the GitHub repository it reaches', async () => {
  const saved = { ...process.env };
  const seen = [];
  const publicRepo = async (url) => { seen.push(url); return { status: 200 }; };
  try {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.git@github.com:.insteadOf';
    process.env.GIT_CONFIG_VALUE_0 = 'gh:';
    const fresh = makeHome();
    await assert.rejects(init(fresh.home, 'gh:owner/home.git', { branch: 'mini', fetchImpl: publicRepo }), /public repository/);
    assert.ok(seen.some((url) => url.endsWith('/repos/owner/home')), JSON.stringify(seen));
  } finally {
    process.env = saved;
  }
  // A push rewrite set up after init is caught before the next push.
  const { home, remote } = await setUp();
  try {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.git@github.com:owner/pushed.git.pushInsteadOf';
    process.env.GIT_CONFIG_VALUE_0 = remote;
    await assert.rejects(now(home, { env: {}, fetchImpl: publicRepo }), /public repository/);
    assert.ok(seen.some((url) => url.endsWith('/repos/owner/pushed')), JSON.stringify(seen));
  } finally {
    process.env = saved;
  }
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a re-init that fails leaves origin where the settings say', async () => {
  const { home, remote } = await setUp();
  await assert.rejects(init(home, path.join(tmp(), 'missing.git'), { branch: 'mini', fetchImpl: notFound }));
  const origin = execFileSync('git', ['--git-dir', repoDir(home), 'remote', 'get-url', 'origin']).toString().trim();
  assert.equal(origin, remote);
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(refOf(remote, 'refs/heads/mini'), result.commit);
});

test('two runs that find the same stale lock never both take it', async () => {
  const { takeLock } = await import('../src/backup.js');
  const { home } = await setUp();
  writeFileSync(path.join(home, 'backup', 'run.lock'), '999999');
  // Both runs read the dead pid; then the first reclaims and takes the lock
  // before the second acts on what it read.
  let bothSaw;
  const seen = new Promise((resolve) => { bothSaw = resolve; });
  let count = 0;
  let firstDone;
  const firstTook = new Promise((resolve) => { firstDone = resolve; });
  const onStale = async (who) => {
    count += 1;
    if (count === 2) bothSaw();
    await seen;
    if (who === 'second') await firstTook;
  };
  const first = takeLock(home, { onStale: () => onStale('first') }).then((release) => { firstDone(); return release; }, (error) => { firstDone(); throw error; });
  const second = takeLock(home, { onStale: () => onStale('second') });
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'], JSON.stringify(results.map((r) => r.reason?.message)));
  assert.match(results[1].reason.message, /Another backup is running/);
  assert.equal(readFileSync(path.join(home, 'backup', 'run.lock'), 'utf8').split('\n')[0], String(process.pid));
  await results[0].value();
});

test('every push URL origin has is checked, not only the first', async () => {
  const { home, remote } = await setUp();
  const gitDir = repoDir(home);
  execFileSync('git', ['--git-dir', gitDir, 'config', '--add', 'remote.origin.pushurl', remote]);
  execFileSync('git', ['--git-dir', gitDir, 'config', '--add', 'remote.origin.pushurl', 'git@github.com:owner/second.git']);
  const publicSecond = async (url) => (url.endsWith('/repos/owner/second') ? { status: 200 } : { status: 404 });
  await assert.rejects(now(home, { env: {}, fetchImpl: publicSecond }), /public repository/);
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('init waits its turn: it refuses while a backup run holds the lock, and changes nothing', async () => {
  const { home, remote } = await setUp();
  writeFileSync(path.join(home, 'backup', 'run.lock'), String(process.pid));
  const other = bareRemote();
  await assert.rejects(init(home, other, { branch: 'mini', fetchImpl: notFound }), /Another backup is running/);
  const origin = execFileSync('git', ['--git-dir', repoDir(home), 'remote', 'get-url', 'origin']).toString().trim();
  assert.equal(origin, remote);
  assert.equal(JSON.parse(readFileSync(path.join(home, 'backup', 'settings.json'), 'utf8')).remote, remote);
});

test('a config named with --config or STRATUS_CONFIG that is missing fails the run; a missing default does not', async () => {
  const { home, remote } = await setUp();
  const gone = path.join(tmp(), 'missing.json');
  await assert.rejects(now(home, { configPath: gone, env: {}, fetchImpl: notFound }), (error) => error.message.includes(gone) && /--config/.test(error.message));
  await assert.rejects(now(home, { env: { STRATUS_CONFIG: gone }, fetchImpl: notFound }), (error) => error.message.includes(gone) && /STRATUS_CONFIG/.test(error.message));
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a skipped skill whose name holds a stored secret is reported with the secret replaced', async () => {
  const { home } = await setUp();
  mkdirSync(path.join(home, 'skills', 'linked'), { recursive: true });
  execFileSync('ln', ['-s', '/etc/hosts', path.join(home, 'skills', 'linked', `${NAMED}.md`)]);
  const result = await now(home, { env: {}, fetchImpl: notFound });
  const linked = result.skipped.filter((item) => item.path.startsWith('home/skills/linked/'));
  assert.equal(linked.length, 1, JSON.stringify(result.skipped));
  assert.equal(linked[0].reason, 'symbolic link');
  assert.ok(linked[0].path.includes(REDACTED), linked[0].path);
  assert.ok(!JSON.stringify(result.skipped).includes(NAMED), JSON.stringify(result.skipped));
});

test('a stored secret too short to redact stops the run, naming where it is stored, never its value', async () => {
  const { home, remote } = await setUp();
  const file = path.join(home, 'credentials.json');
  const credentials = JSON.parse(readFileSync(file, 'utf8'));
  credentials.named.shared['short.pin'] = 'pa55wd7';
  writeFileSync(file, JSON.stringify(credentials));
  await assert.rejects(
    now(home, { env: {}, fetchImpl: notFound }),
    (error) => /shorter than 8 characters/.test(error.message) && error.message.includes('named.shared.short.pin') && !error.message.includes('pa55wd7'),
  );
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('the codex sign-in marker is not a short secret: a codex login home still backs up', async () => {
  const { home, remote } = await setUp();
  const file = path.join(home, 'credentials.json');
  const credentials = JSON.parse(readFileSync(file, 'utf8'));
  credentials.codex = { type: 'oauth_token', value: 'chatgpt' };
  credentials.agentSignIns = { blair: { codex: { type: 'oauth_token', value: 'chatgpt' } } };
  writeFileSync(file, JSON.stringify(credentials));
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  assert.ok(refOf(remote, 'refs/heads/mini'));
});

test('allow takes the backup lock: it refuses while a run or an init holds it, and changes nothing', async () => {
  const { home } = await setUp();
  const settingsPath = path.join(home, 'backup', 'settings.json');
  const before = readFileSync(settingsPath, 'utf8');
  writeFileSync(path.join(home, 'backup', 'run.lock'), String(process.pid));
  await assert.rejects(allow(home, '0123456789abcdef'), /Another backup is running/);
  assert.equal(readFileSync(settingsPath, 'utf8'), before);
});

test('two allows one after another keep both ids', async () => {
  const { home } = await setUp();
  await allow(home, '0123456789abcdef');
  await allow(home, 'fedcba9876543210');
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'backup', 'settings.json'), 'utf8')).allow, ['0123456789abcdef', 'fedcba9876543210']);
});

test('a credential rotated while the snapshot is read is still replaced in its old value', async () => {
  const { home, remote } = await setUp();
  const old = 'rotated-away-secret-value-42';
  const credentials = JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8'));
  credentials.named.shared['deploy.key'] = old;
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ id: 'm9', agentId: 'blair', content: `deploy with ${old}` })}\n`);
  let rotated = false;
  const afterSnapshot = () => {
    if (rotated) return;
    rotated = true;
    credentials.named.shared['deploy.key'] = 'the-new-secret-after-rotation';
    writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
  };
  await now(home, { env: {}, fetchImpl: notFound, afterSnapshot });
  const memory = treeOf(remote, 'refs/heads/mini')['home/agents/blair/memory.jsonl'];
  assert.ok(!memory.includes(old), memory);
  assert.ok(memory.includes(REDACTED));
});

test('a re-init to a new remote drops push URLs origin had, so runs push where they fetch', async () => {
  const { home, remote } = await setUp();
  execFileSync('git', ['--git-dir', repoDir(home), 'config', '--add', 'remote.origin.pushurl', remote]);
  const next = bareRemote();
  await init(home, next, { branch: 'mini', fetchImpl: notFound });
  const pushUrls = execFileSync('git', ['--git-dir', repoDir(home), 'remote', 'get-url', '--push', '--all', 'origin']).toString().trim().split('\n');
  assert.deepEqual(pushUrls, [next]);
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(refOf(next, 'refs/heads/mini'), result.commit);
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a branch name git would refuse is refused at init, and nothing is saved', async () => {
  const { home } = makeHome();
  for (const branch of ['foo..bar', 'foo.lock', 'foo.']) {
    assert.throws(() => execFileSync('git', ['check-ref-format', '--branch', branch], { stdio: 'ignore' }), undefined, branch);
    await assert.rejects(init(home, bareRemote(), { branch, fetchImpl: notFound }), /not a usable branch name/, branch);
  }
  assert.equal(existsSync(path.join(home, 'backup', 'settings.json')), false);
  execFileSync('git', ['check-ref-format', '--branch', 'old-mini.2']);
  await init(home, bareRemote(), { branch: 'old-mini.2', fetchImpl: notFound });
});

test('a key-shaped file name whose contents also trip the scan is never printed raw', async () => {
  const { home, remote } = await setUp();
  mkdirSync(path.join(home, 'skills', 'shaped'), { recursive: true });
  const name = ['gh', 'p_', 'C'.repeat(36)].join('');
  const inside = ['gh', 'p_', 'D'.repeat(36)].join('');
  writeFileSync(path.join(home, 'skills', 'shaped', name), `token ${inside}\n`);
  let failure;
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), (error) => {
    failure = error;
    return error instanceof FindingsError;
  });
  assert.equal(failure.findings.length, 2);
  for (const text of [failure.message, JSON.stringify(failure.findings), readFileSync(path.join(home, 'backup', 'status.json'), 'utf8')]) {
    assert.ok(!text.includes(name) && !text.includes(inside), text);
  }
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a remote URL with a fragment or query is checked as the repository git pushes to', async () => {
  // Codex P1 4310827225: git drops the fragment, so the lookup must too.
  assert.equal(githubRepoOf('https://github.com/owner/repo.git#label'), 'owner/repo');
  assert.equal(githubRepoOf('https://github.com/owner/repo?ref=x'), 'owner/repo');
  assert.equal(githubRepoOf('https://github.com/owner/repo.git/#x'), 'owner/repo');
  const publicRepo = async (url) => (url === 'https://api.github.com/repos/owner/repo' ? { status: 200 } : { status: 404 });
  await assert.rejects(assertNotPublic('https://github.com/owner/repo.git#label', publicRepo), /public repository/);
});

test('a failed snapshot never stores or prints a known secret from an error message', async () => {
  // Codex P2 4310827238: a dangling soul symlink named after a stored secret.
  const { home } = await setUp();
  const { symlinkSync } = await import('node:fs');
  symlinkSync(path.join(home, 'missing-target'), path.join(home, 'agents', `${NAMED}.md`));
  const error = await now(home, { env: {}, fetchImpl: notFound }).then(() => undefined, (e) => e);
  assert.ok(error, 'the run should fail on the dangling soul');
  assert.ok(!error.message.includes(NAMED), error.message);
  const saved = readFileSync(path.join(home, 'backup', 'status.json'), 'utf8');
  assert.equal(JSON.parse(saved).ok, false);
  assert.ok(!saved.includes(NAMED), saved);
});

test('a re-init that fails puts back the push URLs origin had', async () => {
  // Codex P2 4310827247.
  const { home, remote } = await setUp();
  const gitDir = repoDir(home);
  const second = bareRemote();
  execFileSync('git', ['--git-dir', gitDir, 'config', '--add', 'remote.origin.pushurl', remote]);
  execFileSync('git', ['--git-dir', gitDir, 'config', '--add', 'remote.origin.pushurl', second]);
  await assert.rejects(init(home, path.join(tmp(), 'missing.git'), { branch: 'mini', fetchImpl: notFound }));
  const pushUrls = execFileSync('git', ['--git-dir', gitDir, 'remote', 'get-url', '--push', '--all', 'origin']).toString().trim().split('\n');
  assert.deepEqual(pushUrls, [remote, second]);
});

test('a repository made public while the snapshot is built is caught before the push', async () => {
  // Codex P1 4311171728: the only privacy check ran before the snapshot.
  const { home, remote } = await setUp();
  execFileSync('git', ['--git-dir', repoDir(home), 'config', '--add', 'remote.origin.pushurl', 'git@github.com:owner/home.git']);
  let isPublic = false;
  const flips = async () => ({ status: isPublic ? 200 : 404 });
  const saved = { ...process.env };
  try {
    // A push that slipped past the check fails fast instead of reaching GitHub.
    process.env.GIT_SSH_COMMAND = 'false';
    await assert.rejects(now(home, { env: {}, fetchImpl: flips, afterSnapshot: () => { isPublic = true; } }), /public repository/);
  } finally {
    process.env = saved;
  }
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('restore --offline uses this machine\'s copy even when origin holds a newer one', async () => {
  // Codex P2 4311171737: --offline still ran ls-remote and fetched origin.
  const { home, remote } = await setUp();
  const snapshot = await now(home, { env: {}, fetchImpl: notFound });
  const clone = path.join(tmp(), 'clone');
  execFileSync('git', ['clone', '--quiet', '--branch', 'mini', remote, clone]);
  execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'newer']);
  execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'mini']);
  const target = path.join(tmp(), 'restored');
  const result = await restore(target, { repo: repoDir(home), branch: 'mini', offline: true });
  assert.equal(result.commit, snapshot.commit);
  assert.equal(refOf(repoDir(home), 'refs/remotes/origin/mini') ?? snapshot.commit, snapshot.commit, 'origin was not fetched');
});

/** Puts a fake `ssh` first on PATH that resolves `gh-work` to `hostname`. */
const withFakeSsh = async (script, run) => {
  const bin = tmp();
  writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    await run();
  } finally {
    process.env.PATH = saved;
  }
};

test('an SSH host alias that reaches GitHub is checked as the GitHub repository it reaches', async () => {
  // Codex P1 4311359164: `Host gh-work / HostName github.com` skipped the check.
  const aliases = '[ "$1" = "-G" ] || exit 2\ncase "$2" in gh-work) echo "hostname github.com";; gh-443) echo "hostname ssh.github.com";; *) echo "hostname $2";; esac';
  await withFakeSsh(aliases, async () => {
    const seen = [];
    const publicRepo = async (url) => { seen.push(url); return { status: 200 }; };
    await assert.rejects(assertNotPublic('git@gh-work:owner/home.git', publicRepo), /owner\/home is a public repository/);
    await assert.rejects(assertNotPublic('ssh://git@gh-work:2222/owner/home.git', publicRepo), /owner\/home is a public repository/);
    await assert.rejects(assertNotPublic('gh-443:owner/home', publicRepo), /owner\/home is a public repository/);
    await assert.rejects(assertNotPublic('git@gh-work:owner', publicRepo), /Could not tell which GitHub repository/);
    await assertNotPublic('git@gh-work:owner/home.git', notFound);
    await assertNotPublic('git@gitlab.example:owner/home.git', async () => { throw new Error('must not be called'); });
    assert.deepEqual(seen, Array(3).fill('https://api.github.com/repos/owner/home'));
    // A full init through the alias is refused before anything is pushed.
    const fresh = makeHome();
    await assert.rejects(init(fresh.home, 'git@gh-work:owner/home.git', { branch: 'mini', fetchImpl: publicRepo }), /public repository/);
  });
  await assert.rejects(assertNotPublic('git@ssh.github.com:owner/home.git', async () => ({ status: 200 })), /public repository/);
});

test('an SSH remote whose host ssh cannot resolve is refused, not assumed elsewhere', async () => {
  await withFakeSsh('exit 255', async () => {
    await assert.rejects(assertNotPublic('git@gh-work:owner/home.git', async () => { throw new Error('must not be called'); }), /Could not tell where SSH host gh-work.*Nothing was pushed/s);
  });
  await assert.rejects(assertNotPublic('git@-oProxyCommand=x:owner/home.git', notFound), /Nothing was pushed/);
});

test('a configured restore waits for a running backup or init: it refuses while the lock is held, and writes nothing', async () => {
  // Codex P2 4311359176: restore read the settings and origin without the
  // lock, so a concurrent init could switch the repository under it.
  const { main } = await import('../src/cli.js');
  const { home } = await setUp();
  await now(home, { env: {}, fetchImpl: notFound });
  const userHome = path.dirname(home);
  writeFileSync(path.join(home, 'backup', 'run.lock'), String(process.pid));
  const target = path.join(tmp(), 'restored');
  await assert.rejects(main(['restore', target, '--offline'], { env: { HOME: userHome, PATH: process.env.PATH }, out: () => {} }), /Another backup is running/);
  assert.ok(!existsSync(target));
  rmSync(path.join(home, 'backup', 'run.lock'));
  await main(['restore', target, '--offline'], { env: { HOME: userHome, PATH: process.env.PATH }, out: () => {} });
  assert.ok(existsSync(path.join(target, 'agents', 'blair.md')));
  assert.ok(!existsSync(path.join(home, 'backup', 'run.lock')), 'the lock is released after the restore');
});

test('a GitHub host written or resolved with a trailing DNS dot is still checked', async () => {
  // Codex P1 4311608369: `github.com.` is the same host as `github.com`.
  for (const remote of ['git@github.com.:owner/repo.git', 'https://GitHub.com./owner/repo.git', 'ssh://git@ssh.github.com.:443/owner/repo.git']) {
    assert.equal(githubRepoOf(remote), 'owner/repo', remote);
    await assert.rejects(assertNotPublic(remote, async () => ({ status: 200 })), /public repository/, remote);
  }
  const aliases = '[ "$1" = "-G" ] || exit 2\ncase "$2" in gh-dot) echo "hostname github.com.";; *) echo "hostname $2";; esac';
  await withFakeSsh(aliases, async () => {
    await assert.rejects(assertNotPublic('gh-dot:owner/repo.git', async () => ({ status: 200 })), /owner\/repo is a public repository/);
  });
});

test('a re-init whose settings cannot be saved puts origin back', async () => {
  // Codex P2 4311608378: writing settings.json is part of the re-init.
  const { home, remote } = await setUp();
  const other = bareRemote();
  // A directory where writeJson puts its temporary file makes the write fail.
  mkdirSync(path.join(home, 'backup', `settings.json.${process.pid}.tmp`));
  await assert.rejects(init(home, other, { branch: 'mini', fetchImpl: notFound }));
  const origin = execFileSync('git', ['--git-dir', repoDir(home), 'remote', 'get-url', 'origin']).toString().trim();
  assert.equal(origin, remote);
});

test('a git failure never stores or prints a credential carried in the remote URL', async () => {
  // Codex P2 4311860392: git echoes the full remote URL, query included, in its fatal errors.
  const token = 'SUPERSECRET-123';
  const leaky = `http://user:pw-${token}@127.0.0.1:1/x.git?access_token=${token}#${token}`;
  const { home } = await setUp();
  execFileSync('git', ['--git-dir', repoDir(home), 'remote', 'set-url', 'origin', leaky]);
  const settingsPath = path.join(home, 'backup', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, 'utf8')), remote: leaky }));
  const failed = await now(home, { env: {}, fetchImpl: notFound }).then(() => undefined, (e) => e);
  assert.ok(failed, 'the run should fail on the unreachable remote');
  assert.match(failed.message, /127\.0\.0\.1/);
  assert.ok(!failed.message.includes(token), failed.message);
  const saved = readFileSync(path.join(home, 'backup', 'status.json'), 'utf8');
  assert.ok(!saved.includes(token), saved);
  // init reaches the remote too, and its error goes straight to the CLI.
  const fresh = makeHome();
  const initFailed = await init(fresh.home, leaky, { branch: 'mini', fetchImpl: notFound }).then(() => undefined, (e) => e);
  assert.ok(initFailed, 'init should fail on the unreachable remote');
  assert.ok(!initFailed.message.includes(token), initFailed.message);
});

test('a re-init that fails leaves no branch adopted from the remote it did not switch to', async () => {
  // Codex P1 4312074600: syncWithRemote adopts the new remote's branch before
  // the settings are saved; a rollback that kept that ref would let a later
  // run push the other remote's history to the old one.
  const { home, remote } = await setUp();
  const other = bareRemote();
  const elsewhere = makeHome();
  await init(elsewhere.home, other, { branch: 'mini', fetchImpl: notFound });
  await now(elsewhere.home, { env: {}, fetchImpl: notFound });
  mkdirSync(path.join(home, 'backup', `settings.json.${process.pid}.tmp`));
  await assert.rejects(init(home, other, { branch: 'mini', fetchImpl: notFound }));
  const refs = execFileSync('git', ['--git-dir', repoDir(home), 'for-each-ref', '--format=%(refname)']).toString().trim();
  assert.equal(refs, '');
  rmSync(path.join(home, 'backup', `settings.json.${process.pid}.tmp`), { recursive: true });
  await now(home, { env: {}, fetchImpl: notFound });
  const log = execFileSync('git', ['--git-dir', remote, 'rev-list', 'refs/heads/mini']).toString().trim().split('\n');
  assert.equal(log.length, 1, 'the old remote got only its own snapshot');
});

test('a failed run hides a credential that was rotated away while it ran', async () => {
  // Codex P2 4312074616: the error is redacted with the secrets read before the snapshot too.
  const { home } = await setUp();
  const old = 'rotated-away-secret-value-42';
  const credentials = JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8'));
  credentials.named.shared['deploy.key'] = old;
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
  const afterSnapshot = () => {
    credentials.named.shared['deploy.key'] = 'the-new-secret-after-rotation';
    writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
    throw new Error(`ENOENT: no such file or directory, stat 'agents/${old}.md'`);
  };
  const failed = await now(home, { env: {}, fetchImpl: notFound, afterSnapshot }).then(() => undefined, (e) => e);
  assert.ok(failed);
  assert.ok(!failed.message.includes(old), failed.message);
  const saved = readFileSync(path.join(home, 'backup', 'status.json'), 'utf8');
  assert.ok(!saved.includes(old), saved);
});

test('a branch that only matches the tail of another remote branch is treated as new', async () => {
  // Codex P2 4312337282: ls-remote matches x/mini for mini, so the exact ref is checked.
  const fixture = makeHome();
  const remote = bareRemote();
  const tree = execFileSync('git', ['--git-dir', remote, 'mktree'], { input: '' }).toString().trim();
  const other = execFileSync('git', ['--git-dir', remote, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'other'])
    .toString().trim();
  execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/x/mini', other]);
  await init(fixture.home, remote, { branch: 'mini', fetchImpl: notFound });
  const result = await now(fixture.home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  assert.equal(refOf(remote, 'refs/heads/mini'), result.commit);
  assert.equal(refOf(remote, 'refs/heads/x/mini'), other);
  const target = path.join(tmp(), 'restored');
  const restored = await restore(target, { repo: repoDir(fixture.home), branch: 'mini' });
  assert.equal(restored.commit, result.commit);
});

test('credentials still changing after the snapshot was read get a fresh snapshot', async () => {
  // Codex P1 4312337294: A before, B while a file was read, C after. B is
  // never in either endpoint set, so a run whose credentials moved reads again.
  const { home, remote } = await setUp();
  const credentials = JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8'));
  const mirror = path.join(home, 'skills', 'notes', 'token.txt');
  credentials.named.shared['deploy.key'] = 'credential-value-a-0123456789';
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
  writeFileSync(mirror, 'credential-value-b-0123456789\n');
  let calls = 0;
  const afterSnapshot = () => {
    calls += 1;
    if (calls > 1) return;
    credentials.named.shared['deploy.key'] = 'credential-value-c-0123456789';
    writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
    writeFileSync(mirror, 'credential-value-c-0123456789\n');
  };
  await now(home, { env: {}, fetchImpl: notFound, afterSnapshot });
  assert.equal(calls, 2);
  const everything = Object.values(treeOf(remote, 'refs/heads/mini')).join('\n');
  assert.ok(!everything.includes('credential-value-b'), 'the intermediate credential was pushed');
  assert.ok(!everything.includes('credential-value-c'));
});

test('a run whose credentials never hold still stops without pushing', async () => {
  const { home, remote } = await setUp();
  const credentials = JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8'));
  let calls = 0;
  const afterSnapshot = () => {
    calls += 1;
    credentials.named.shared['deploy.key'] = `credential-value-${calls}-0123456789`;
    writeFileSync(path.join(home, 'credentials.json'), JSON.stringify(credentials));
  };
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound, afterSnapshot }), /credentials changed/);
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a skill that is a git worktree or submodule leaves its .git file out', async () => {
  // Codex P2 4312337300: a .git file holds a gitdir pointer with a local path.
  const { home, remote } = await setUp();
  mkdirSync(path.join(home, 'skills', 'linked'));
  writeFileSync(path.join(home, 'skills', 'linked', 'SKILL.md'), '# Linked\n');
  writeFileSync(path.join(home, 'skills', 'linked', '.git'), 'gitdir: /Users/someone/src/linked/.git/worktrees/linked\n');
  const result = await now(home, { env: {}, fetchImpl: notFound });
  const files = treeOf(remote, 'refs/heads/mini');
  assert.ok(files['home/skills/linked/SKILL.md']);
  assert.equal(files['home/skills/linked/.git'], undefined);
  assert.ok(result.skipped.some((s) => s.path === 'home/skills/linked/.git' && s.reason === 'nested git metadata'));
});

test('a skills root that is a symbolic link is skipped, not followed', async () => {
  // Codex P1 4312620201: readdir on the root followed the link.
  const { home, remote } = await setUp();
  const elsewhere = tmp();
  writeFileSync(path.join(elsewhere, 'tool-output.txt'), 'outside the home\n');
  rmSync(path.join(home, 'skills'), { recursive: true, force: true });
  execFileSync('ln', ['-s', elsewhere, path.join(home, 'skills')]);
  const result = await now(home, { env: {}, fetchImpl: notFound });
  const files = treeOf(remote, 'refs/heads/mini');
  assert.ok(!Object.keys(files).some((name) => name.startsWith('home/skills/')), Object.keys(files).join(', '));
  assert.deepEqual(result.skipped.filter((item) => item.path === 'home/skills'), [{ path: 'home/skills', reason: 'symbolic link' }]);
});

test('an explicit config path holding a stored secret is returned redacted', async () => {
  // Codex P2 4312620211: the CLI prints result.manifest.config.path.
  const { home } = await setUp();
  const dir = path.join(tmp(), NAMED);
  mkdirSync(dir);
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, readFileSync(path.join(home, 'config.json')));
  const result = await now(home, { configPath, env: {}, fetchImpl: notFound });
  assert.ok(result.manifest.config.path.includes(REDACTED), result.manifest.config.path);
  assert.ok(!JSON.stringify(result).includes(NAMED), JSON.stringify(result.manifest));
});

test('a gateway token with leading whitespace is also replaced in the encoding of the whole file', async () => {
  // Codex P1 4313117307: only the trimmed token was a needle.
  const { home, remote } = await setUp();
  const contents = `  ${GATEWAY}\n`;
  writeFileSync(path.join(home, 'gateway-token'), contents);
  const encoded = Buffer.from(contents).toString('base64');
  appendFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), `${JSON.stringify({ text: `token file: ${encoded}` })}\n`);
  await now(home, { env: {}, fetchImpl: notFound });
  const files = treeOf(remote, 'refs/heads/mini');
  const all = Object.values(files).join('\n');
  assert.ok(!all.includes(encoded), 'base64 of the whole token file was pushed');
  assert.ok(!all.includes(GATEWAY));
});

test('a run refuses when origin no longer matches the remote the settings name', async () => {
  // Codex P2 4313117339: a re-init whose origin rollback also failed must not
  // leave later runs pushing to the remote it did not switch to.
  const { home, remote } = await setUp();
  const other = bareRemote();
  execFileSync('git', ['--git-dir', repoDir(home), 'remote', 'set-url', 'origin', other]);
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /origin/);
  assert.equal(refOf(other, 'refs/heads/mini'), undefined);
  assert.equal(refOf(remote, 'refs/heads/mini'), undefined);
});

test('a re-init whose ref rollback fails stops later runs instead of pushing foreign history', async () => {
  // Codex P1 4313652450: a failed update-ref in the rollback was ignored, and
  // with origin restored nothing else could tell the local ref was foreign.
  const { home, remote } = await setUp();
  const other = bareRemote();
  const elsewhere = makeHome();
  await init(elsewhere.home, other, { branch: 'mini', fetchImpl: notFound });
  await now(elsewhere.home, { env: {}, fetchImpl: notFound });
  const blocker = path.join(home, 'backup', `settings.json.${process.pid}.tmp`);
  mkdirSync(blocker);
  // Deleting a ref takes packed-refs.lock; creating a loose one does not.
  const lock = path.join(repoDir(home), 'packed-refs.lock');
  writeFileSync(lock, '');
  await assert.rejects(init(home, other, { branch: 'mini', fetchImpl: notFound }));
  rmSync(lock);
  rmSync(blocker, { recursive: true });
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound }), /init again/);
  const listed = execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)']).toString().trim();
  assert.equal(listed, '', 'nothing reached the old remote');
  // A successful init clears the stop.
  await init(home, remote, { branch: 'fresh', fetchImpl: notFound });
  assert.equal((await now(home, { env: {}, fetchImpl: notFound })).pushed, true);
});

test('a credential rotated away and back while the snapshot is read still forces a reread', async () => {
  // Codex P1 4313976876: A -> B -> A left the before and after values equal,
  // so a snapshot read while B was stored was committed with B unknown.
  const { home } = await setUp();
  const file = path.join(home, 'credentials.json');
  const original = readFileSync(file, 'utf8');
  const credentials = JSON.parse(original);
  credentials.named.shared['deploy.key'] = 'briefly-stored-secret-value-77';
  let reads = 0;
  const afterSnapshot = () => {
    reads += 1;
    if (reads > 1) return;
    writeFileSync(file, JSON.stringify(credentials));
    writeFileSync(file, original);
  };
  await now(home, { env: {}, fetchImpl: notFound, afterSnapshot });
  assert.equal(reads, 2, 'the snapshot read while the credentials moved is not the one committed');
  const always = () => { writeFileSync(file, JSON.stringify(credentials)); writeFileSync(file, original); };
  await assert.rejects(now(home, { env: {}, fetchImpl: notFound, afterSnapshot: always }), /changed while each of 3 snapshots/);
});

const leaveSuspectRepository = async () => {
  const { home, remote } = await setUp();
  const other = bareRemote();
  const elsewhere = makeHome();
  await init(elsewhere.home, other, { branch: 'mini', fetchImpl: notFound });
  const foreign = (await now(elsewhere.home, { env: {}, fetchImpl: notFound })).commit;
  const blocker = path.join(home, 'backup', `settings.json.${process.pid}.tmp`);
  mkdirSync(blocker);
  const lock = path.join(repoDir(home), 'packed-refs.lock');
  writeFileSync(lock, '');
  await assert.rejects(init(home, other, { branch: 'mini', fetchImpl: notFound }));
  rmSync(lock);
  rmSync(blocker, { recursive: true });
  assert.ok(existsSync(path.join(home, 'backup', 'needs-init')));
  return { home, remote, foreign };
};

test('the init that clears a failed rollback starts from a fresh repository, keeping the suspect one aside', async () => {
  // Codex P1 4313976888: retrying init with the same branch kept the foreign
  // local ref when the desired remote lacked the branch, then cleared the stop.
  const { home, remote, foreign } = await leaveSuspectRepository();
  await init(home, remote, { branch: 'mini', fetchImpl: notFound });
  const result = await now(home, { env: {}, fetchImpl: notFound });
  assert.equal(result.pushed, true);
  const contains = spawnSyncCode('git', ['--git-dir', remote, 'merge-base', '--is-ancestor', foreign, 'refs/heads/mini']);
  assert.notEqual(contains, 0, 'the foreign history never reaches the remote');
  const kept = readdirSync(path.join(home, 'backup')).filter((name) => name.startsWith('repo.suspect-'));
  assert.equal(kept.length, 1, 'the suspect repository is moved aside, not deleted');
});

test('a configured restore refuses while a failed rollback has left the repository suspect', async () => {
  // Codex P1 4313976897: restore from this machine's repository skipped the
  // check that stops runs, so --offline could restore the foreign ref.
  const { main } = await import('../src/cli.js');
  const { home } = await leaveSuspectRepository();
  const userHome = path.dirname(home);
  const target = path.join(tmp(), 'restored');
  await assert.rejects(main(['restore', target, '--offline'], { env: { HOME: userHome, PATH: process.env.PATH }, out: () => {} }), /init again/);
  assert.ok(!existsSync(target));
});

function spawnSyncCode(command, args) {
  return spawnSync(command, args, { stdio: 'ignore' }).status;
}
