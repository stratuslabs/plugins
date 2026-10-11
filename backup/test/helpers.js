import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Built by concatenation so no file in this repository holds a token-shaped literal.
export const SLACK_BOT = ['xox', 'b-1111111111-2222222222-AbCdEfGhIjKlMnOp'].join('');
export const NAMED = 'named-credential-value-0123456789';
export const GATEWAY = 'gateway-token-value-abcdef0123456789';

export const tmp = (prefix = 'stratus-backup-test-') => mkdtempSync(path.join(os.tmpdir(), prefix));

export const bareRemote = () => {
  const dir = path.join(tmp(), 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', dir]);
  return dir;
};

/** A migrated home with one agent, a skill, a schedule, and secrets in the places they really sit. */
export const makeHome = ({ applied = ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout', '0004-per-agent-workspaces'] } = {}) => {
  const userHome = tmp();
  const home = path.join(userHome, '.stratus');
  mkdirSync(path.join(home, 'agents', 'blair', 'workspace'), { recursive: true });
  mkdirSync(path.join(home, 'skills', 'notes', '.git'), { recursive: true });
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  writeFileSync(path.join(home, 'state.json'), JSON.stringify({ schemaVersion: applied.length, applied }));
  writeFileSync(
    path.join(home, 'credentials.json'),
    JSON.stringify({
      anthropic: { type: 'api_key', value: ['sk-', 'ant-api03-not-a-real-key-but-long-enough-000000'].join('') },
      channels: { slack: { blair: { appToken: ['xa', 'pp-1-A0000000000-1111111111111-abcdef'].join(''), botToken: SLACK_BOT } } },
      named: { shared: { 'search.apiKey': NAMED }, agents: {} },
    }),
  );
  writeFileSync(path.join(home, 'gateway-token'), `${GATEWAY}\n`);
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      provider: 'anthropic',
      plugins: { '@stratusagent/tool-shell': { enabled: true, env: { DEPLOY_KEY: 'some-deploy-key' } } },
      api: { port: 4242 },
    }),
  );
  writeFileSync(path.join(home, 'agents', 'blair.md'), '---\nid: blair\n---\nYou are Blair.\n');
  writeFileSync(path.join(home, 'agents', 'nameless.md'), 'No frontmatter here.\n');
  const memory = [
    { id: 'm1', agentId: 'blair', content: 'The launch is on Friday.' },
    { id: 'm2', agentId: 'blair', content: `Saw the bot token ${SLACK_BOT} in a log.` },
    { id: 'm3', agentId: 'blair', content: `Encoded: ${Buffer.from(NAMED).toString('base64')}` },
  ];
  writeFileSync(path.join(home, 'agents', 'blair', 'memory.jsonl'), memory.map((m) => JSON.stringify(m)).join('\n') + '\n');
  writeFileSync(path.join(home, 'agents', 'blair', 'whitelist.json'), JSON.stringify({ commands: ['git status'] }));
  writeFileSync(path.join(home, 'agents', 'blair', 'sessions.db'), 'not copied');
  writeFileSync(path.join(home, 'agents', 'blair', 'workspace', 'out.txt'), 'not copied');
  writeFileSync(path.join(home, 'logs', 'stratusd.jsonl'), 'not copied');
  writeFileSync(path.join(home, 'skills', 'notes', 'SKILL.md'), '# Notes\n');
  writeFileSync(path.join(home, 'skills', 'notes', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  writeFileSync(path.join(home, 'skills', 'notes', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  symlinkSync('/etc/hosts', path.join(home, 'skills', 'notes', 'hosts'));
  const db = new DatabaseSync(path.join(home, 'fleet.db'));
  db.exec('CREATE TABLE schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, next_fire_at TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE session_index (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL)');
  db.prepare('INSERT INTO schedules VALUES (?, ?, ?, ?, ?)').run('s1', 'blair', '2026-10-12T09:00:00Z', JSON.stringify({ id: 's1', prompt: 'Morning digest' }), '2026-10-01T00:00:00Z');
  db.prepare('INSERT INTO session_index VALUES (?, ?)').run('sess-1', 'blair');
  db.close();
  return { userHome, home };
};

/** Every blob in a ref of a bare repository, as { path: text }. */
export const treeOf = (repo, ref) => {
  const listing = execFileSync('git', ['--git-dir', repo, 'ls-tree', '-r', '--full-tree', ref], { encoding: 'utf8' });
  const files = {};
  for (const line of listing.split('\n').filter(Boolean)) {
    const [meta, file] = line.split('\t');
    const oid = meta.split(' ')[2];
    files[file] = execFileSync('git', ['--git-dir', repo, 'cat-file', 'blob', oid], { encoding: 'utf8' });
  }
  return files;
};

export const refOf = (repo, ref) => {
  try {
    return execFileSync('git', ['--git-dir', repo, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

export const notFound = async () => ({ status: 404 });
