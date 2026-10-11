import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REDACTED, encodingsOf, needlesFor, redactBuffer, redactConfig, scanBuffer } from '../src/secrets.js';
import { commandFor, enable, launchAgentPlist, parseTime, systemdUnits } from '../src/timer.js';
import { tmp } from './helpers.js';

test('a known secret is replaced in each encoding a copy commonly takes', () => {
  const secret = 'p@ss/word+with=odd&chars';
  const needles = needlesFor(new Set([secret]));
  for (const form of encodingsOf(secret)) {
    const { buffer, count } = redactBuffer(Buffer.from(`before ${form} after`), needles);
    assert.equal(count, 1, form);
    assert.equal(buffer.toString(), `before ${REDACTED} after`);
  }
});

test('config values under credential-like keys and in env blocks are redacted, others kept', () => {
  const { config, replaced } = redactConfig({
    provider: 'anthropic',
    apiKey: 'k',
    slack: { blair: { botToken: 't', replyMode: 'thread' } },
    plugins: { shell: { env: { PATH: '/bin', NESTED: { X: 'y' } }, tokenLimit: 5 } },
  });
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.apiKey, REDACTED);
  assert.equal(config.slack.blair.botToken, REDACTED);
  assert.equal(config.slack.blair.replyMode, 'thread');
  assert.equal(config.plugins.shell.env.PATH, REDACTED);
  assert.equal(config.plugins.shell.env.NESTED.X, REDACTED);
  assert.equal(config.plugins.shell.tokenLimit, 5);
  assert.deepEqual(replaced.sort(), ['apiKey', 'plugins.shell.env.NESTED.X', 'plugins.shell.env.PATH', 'slack.blair.botToken']);
});

test('the scan names the file, line and kind, and its id is stable and opaque', () => {
  const key = ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----'].join('');
  const findings = scanBuffer('home/skills/x/key', Buffer.from(`one\ntwo ${key}\n`));
  assert.deepEqual(findings.map(({ file, line, kind }) => ({ file, line, kind })), [{ file: 'home/skills/x/key', line: 2, kind: 'private key' }]);
  assert.equal(scanBuffer('home/skills/x/key', Buffer.from(key))[0].id, findings[0].id);
  assert.ok(!findings[0].id.includes('PRIVATE'));
  assert.deepEqual(scanBuffer('home/a', Buffer.from('sk-ant is the prefix, skipping is fine')), []);
});

test('the LaunchAgent is a valid plist with the run time and command', { skip: process.platform !== 'darwin' }, () => {
  const plist = launchAgentPlist({
    command: commandFor({ script: '/x/bin/stratus-backup.js', configPath: '/a & b/config.json' }),
    home: '/Users/me/.stratus',
    time: parseTime('03:30'),
    workingDirectory: '/Users/me',
    env: { HOME: '/Users/me', PATH: '/usr/bin:/bin' },
  });
  const file = path.join(tmp(), 'to.stratus.backup.plist');
  writeFileSync(file, plist);
  execFileSync('plutil', ['-lint', file]);
  const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  assert.deepEqual(parsed.ProgramArguments, ['/usr/bin/env', 'node', '/x/bin/stratus-backup.js', 'now', '--config', '/a & b/config.json']);
  assert.deepEqual(parsed.StartCalendarInterval, { Hour: 3, Minute: 30 });
  assert.equal(parsed.StandardErrorPath, '/Users/me/.stratus/logs/backup.log');
});

test('the systemd units run the same command nightly', () => {
  const units = systemdUnits({
    command: ['/opt/node', '/x/stratus-backup.js', 'now'],
    time: parseTime('3:05'),
    workingDirectory: '/home/me',
    env: { HOME: '/home/me' },
  });
  assert.match(units.service, /^ExecStart="\/opt\/node" "\/x\/stratus-backup.js" "now"$/m);
  assert.match(units.timer, /^OnCalendar=\*-\*-\* 03:05:00$/m);
  assert.match(units.timer, /^Persistent=true$/m);
});

test('a dry run writes nothing', async () => {
  const userHome = tmp();
  const result = await enable({
    platform: 'linux', userHome, home: path.join(userHome, '.stratus'), time: parseTime('01:00'),
    command: ['n', 's', 'now'], workingDirectory: userHome, env: {}, install: false,
  });
  assert.equal(Object.keys(result.files).length, 2);
  assert.throws(() => execFileSync('ls', [path.join(userHome, '.config')], { stdio: 'pipe' }));
});

test('a time that is not one is refused', () => {
  for (const bad of ['24:00', '3', '03:60', 'noon']) assert.throws(() => parseTime(bad));
});
