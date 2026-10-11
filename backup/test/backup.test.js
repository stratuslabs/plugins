import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
