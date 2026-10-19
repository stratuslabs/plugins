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

test('a secret that is part of the redaction marker is never written back by it', () => {
  // Codex P1 4310180286: replacing `stratus-backup` with a marker that
  // contains `stratus-backup` left the secret in the snapshot.
  for (const secrets of [['stratus-backup'], ['redacted by'], ['redacted'], ['stratus-backup', 'redacted', '[removed]']]) {
    const needles = needlesFor(new Set(secrets));
    const { buffer, count } = redactBuffer(Buffer.from(`a ${secrets.join(' and ')} z [redacted by stratus-backup]`), needles);
    const out = buffer.toString();
    assert.ok(count > 0, secrets.join(','));
    for (const secret of secrets) assert.ok(!out.includes(secret), `${secret} survived: ${out}`);
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

test('enable runs the nightly unit from the user home, not the directory it was called from', async () => {
  const { main } = await import('../src/cli.js');
  const userHome = tmp();
  const elsewhere = tmp();
  const { mkdirSync: mk } = await import('node:fs');
  mk(path.join(userHome, '.stratus', 'backup'), { recursive: true });
  writeFileSync(path.join(userHome, '.stratus', 'backup', 'settings.json'), JSON.stringify({ remote: '/r.git', branch: 'mini' }));
  const lines = [];
  await main(['enable', '--dry-run'], { env: { HOME: userHome, PATH: '/usr/bin' }, cwd: elsewhere, out: (line) => lines.push(line), scriptPath: '/x/stratus-backup.js' });
  const output = lines.join('\n');
  assert.ok(output.includes(userHome), output);
  assert.ok(!output.includes(elsewhere), 'the caller directory must not be the working directory');
});

test('enable resolves a relative --config against the directory it was called from', async () => {
  const { main } = await import('../src/cli.js');
  const userHome = tmp();
  const elsewhere = tmp();
  const { mkdirSync: mk } = await import('node:fs');
  mk(path.join(userHome, '.stratus', 'backup'), { recursive: true });
  writeFileSync(path.join(userHome, '.stratus', 'backup', 'settings.json'), JSON.stringify({ remote: '/r.git', branch: 'mini' }));
  const lines = [];
  await main(['enable', '--dry-run', '--config', 'conf/stratus.json'], { env: { HOME: userHome, PATH: '/usr/bin' }, cwd: elsewhere, out: (line) => lines.push(line), scriptPath: '/x/stratus-backup.js' });
  const output = lines.join('\n');
  assert.ok(output.includes(path.join(elsewhere, 'conf', 'stratus.json')), output);
});

test('a known secret written with lower-case or mixed percent escapes is redacted too', () => {
  const secret = 'p@ss/word+with=odd&chars';
  const needles = needlesFor(new Set([secret]));
  const upper = encodeURIComponent(secret);
  const lower = upper.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  const mixed = 'p%40ss%2fword%2Bwith=odd%26chars';
  for (const form of [lower, mixed]) {
    const { buffer, count } = redactBuffer(Buffer.from(`before ${form} after`), needles);
    assert.equal(count, 1, form);
    assert.equal(buffer.toString(), `before ${REDACTED} after`);
  }
  // Letters in the secret itself still match only as written.
  const { count } = redactBuffer(Buffer.from('P%40SS%2FWORD%2BWITH=ODD%26CHARS'), needles);
  assert.equal(count, 0);
});

test('every string inside an env block or a credential-named container is redacted, arrays included', () => {
  const { config, replaced } = redactConfig({
    plugins: { shell: { env: { LIST: ['first-secret', { deep: 'second-secret' }], COUNT: 3 } } },
    apiKeys: ['arbitrary-secret'],
    credentials: { github: { value: 'third-secret' } },
    names: ['kept'],
  });
  assert.deepEqual(config.plugins.shell.env.LIST, [REDACTED, { deep: REDACTED }]);
  assert.equal(config.plugins.shell.env.COUNT, 3);
  assert.deepEqual(config.apiKeys, [REDACTED]);
  assert.equal(config.credentials.github.value, REDACTED);
  assert.deepEqual(config.names, ['kept']);
  assert.deepEqual(replaced.sort(), ['apiKeys.0', 'credentials.github.value', 'plugins.shell.env.LIST.0', 'plugins.shell.env.LIST.1.deep']);
  assert.ok(!JSON.stringify(config).includes('secret"'), JSON.stringify(config));
});

test('a known secret written with any valid JSON escape spelling is redacted, at any nesting depth', () => {
  const secret = 'pä/ss"wo\\rd-1234';
  const needles = needlesFor(new Set([secret]));
  const unicode = (text, digits = (hex) => hex) => [...text].map((char) => `\\u${digits(char.charCodeAt(0).toString(16).padStart(4, '0'))}`).join('');
  const once = [
    'p\\u00e4\\/ss\\"wo\\\\rd-1234',
    'p\\u00E4/ss\\"wo\\\\rd-1234',
    unicode(secret),
    unicode(secret, (hex) => hex.toUpperCase()),
  ];
  const decode = (form) => JSON.parse(`"${form}"`);
  for (const form of once) assert.equal(decode(form), secret, form);
  // Twice escaped, as a schedule body is inside schedules.jsonl.
  const twice = JSON.stringify(once[0]).slice(1, -1);
  assert.equal(decode(decode(twice)), secret);
  for (const form of [...once, twice]) {
    const { buffer, count } = redactBuffer(Buffer.from(`before ${form} after`), needles);
    assert.equal(count, 1, form);
    assert.equal(buffer.toString(), `before ${REDACTED} after`);
  }
  // An escape is not a licence to change the secret's own letters.
  assert.equal(redactBuffer(Buffer.from('P\\u00e4/SS"WO\\\\RD-1234'), needles).count, 0);
});

test('a named credential called like a metadata field is still a secret; real record metadata is not', async () => {
  const { collectKnownSecrets } = await import('../src/secrets.js');
  const home = tmp();
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
    openai: { type: 'api_key', value: 'openai-compatible-key-0001', baseUrl: 'http://localhost:11434/v1' },
    named: { shared: { source: 'arbitrary-secret-123', provider: 'another-secret-456' }, agents: { blair: { kind: 'blair-own-secret-789' } } },
  }));
  const secrets = await collectKnownSecrets(home);
  for (const value of ['openai-compatible-key-0001', 'arbitrary-secret-123', 'another-secret-456', 'blair-own-secret-789']) assert.ok(secrets.has(value), value);
  assert.equal(secrets.has('http://localhost:11434/v1'), false);
  assert.equal(secrets.has('api_key'), false);
});

test('a known secret with spaces written form-encoded, a space as +, is redacted', () => {
  const secret = 'correct horse battery';
  const needles = needlesFor(new Set([secret]));
  for (const form of ['correct+horse+battery', 'correct+horse%20battery']) {
    const { buffer, count } = redactBuffer(Buffer.from(`q=${form}&x=1`), needles);
    assert.equal(count, 1, form);
    assert.equal(buffer.toString(), `q=${REDACTED}&x=1`);
  }
});

test('a known secret written in mixed-case hex is redacted', () => {
  const secret = 'deadbeef-password';
  const needles = needlesFor(new Set([secret]));
  const hex = Buffer.from(secret).toString('hex');
  let letters = 0;
  const mixed = [...hex].map((digit) => (/[a-f]/.test(digit) && (letters += 1) % 2 === 0 ? digit.toUpperCase() : digit)).join('');
  assert.notEqual(mixed, hex);
  assert.notEqual(mixed, hex.toUpperCase());
  for (const form of [hex, hex.toUpperCase(), mixed]) {
    const { buffer, count } = redactBuffer(Buffer.from(`before ${form} after`), needles);
    assert.equal(count, 1, form);
    assert.equal(buffer.toString(), `before ${REDACTED} after`);
  }
});

test('a known secret base64-encoded with line wrapping is redacted', () => {
  // Codex P1 4310391457: GNU base64 wraps at 76 columns by default, and
  // openssl and PEM at 64, so a long secret's encoding spans lines.
  const secret = `long-secret-${'x'.repeat(40)}-${'0123456789'.repeat(4)}`;
  const needles = needlesFor(new Set([secret]));
  const encoded = Buffer.from(secret).toString('base64');
  assert.ok(encoded.length > 76);
  const wrap = (text, width, eol) => text.match(new RegExp(`.{1,${width}}`, 'g')).join(eol);
  for (const form of [wrap(encoded, 76, '\n'), wrap(encoded, 64, '\n'), wrap(encoded, 76, '\r\n'), `${wrap(encoded, 76, '\n')}\n`]) {
    const { buffer, count } = redactBuffer(Buffer.from(`before ${form} after`), needles);
    assert.ok(count >= 1, JSON.stringify(form));
    const out = buffer.toString();
    for (const line of form.split(/\r?\n/).filter((l) => l.length >= 8)) {
      assert.ok(!out.includes(line), `${JSON.stringify(line)} survived: ${out}`);
    }
  }
});

test('a credential with surrounding whitespace is kept exactly, so its encodings are redacted too', async () => {
  const { collectKnownSecrets } = await import('../src/secrets.js');
  const home = tmp();
  const secret = ' long-password-0001 ';
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ named: { shared: { pad: secret } } }));
  const secrets = await collectKnownSecrets(home);
  assert.ok(secrets.has(secret));
  const needles = needlesFor(secrets);
  for (const form of [Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]) {
    assert.equal(redactBuffer(Buffer.from(`x=${form};`), needles).count, 1, form);
  }
});

test('a whitespace-only credential stops the run instead of being skipped', async () => {
  // Codex P1 4312863519: eight spaces trimmed to nothing, so the value was
  // neither redacted nor reported short, and its base64 could be committed.
  const { collectKnownSecrets } = await import('../src/secrets.js');
  for (const blank of ['        ', '\t\n  \r\n', ' ']) {
    const home = tmp();
    writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ named: { shared: { blank } } }));
    await assert.rejects(
      collectKnownSecrets(home),
      (error) => /shorter than 8 characters/.test(error.message) && error.message.includes('named.shared.blank'),
      JSON.stringify(blank),
    );
  }
  const home = tmp();
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ named: { shared: { empty: '' } } }));
  assert.equal((await collectKnownSecrets(home)).size, 0);
});

test('status and init show the remote without its userinfo', async () => {
  const { mkdirSync } = await import('node:fs');
  const { main } = await import('../src/cli.js');
  const userHome = tmp();
  mkdirSync(path.join(userHome, '.stratus', 'backup'), { recursive: true });
  writeFileSync(path.join(userHome, '.stratus', 'backup', 'settings.json'), JSON.stringify({ remote: 'https://user:tok-SECRET-123@example.com/a/b.git', branch: 'mini' }));
  const lines = [];
  await main(['status'], { env: { HOME: userHome, PATH: '/usr/bin' }, out: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes('https://***@example.com/a/b.git')), lines.join('\n'));
  assert.ok(lines.every((line) => !line.includes('tok-SECRET-123') && !line.includes('user:')), lines.join('\n'));
  const { shownRemote } = await import('../src/backup.js');
  assert.equal(shownRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(shownRemote('https://example.com/a.git'), 'https://example.com/a.git');
  assert.equal(shownRemote('ssh://git:pw@host/a.git'), 'ssh://***@host/a.git');
});

test('a known secret written as a spaced, wrapped hex dump is redacted', () => {
  // Codex P1 4310827233: `od -An -tx1` puts a space between bytes and wraps
  // at 16 bytes a line; `xxd -p` wraps at 30 bytes with no spaces.
  const secret = `dump-secret-${'0123456789'.repeat(4)}`;
  const needles = needlesFor(new Set([secret]));
  const hex = Buffer.from(secret).toString('hex');
  const pairs = hex.match(/../g);
  const od = pairs.map((pair, i) => `${i % 16 === 0 ? (i === 0 ? ' ' : '\n ') : ' '}${pair}`).join('');
  const xxd = hex.match(/.{1,60}/g).join('\n');
  const spacedUpper = pairs.join(' ').toUpperCase();
  for (const form of [od, xxd, spacedUpper, pairs.join('\r\n')]) {
    const { buffer, count } = redactBuffer(Buffer.from(`before ${form} after`), needles);
    assert.ok(count >= 1, JSON.stringify(form));
    const out = buffer.toString();
    for (const line of form.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 8)) {
      assert.ok(!out.includes(line), `${JSON.stringify(line)} survived: ${out}`);
    }
  }
  // Ordinary text with hex-looking words is left alone.
  assert.equal(redactBuffer(Buffer.from('de ad be ef'), needles).count, 0);
});

test('a credential in a remote URL query is not shown', async () => {
  // Codex P2 4311608383.
  const { shownRemote } = await import('../src/backup.js');
  assert.equal(shownRemote('https://example.com/repo.git?access_token=super-secret'), 'https://example.com/repo.git?***');
  assert.equal(shownRemote('https://u:p@example.com/repo.git?t=s#frag'), 'https://***@example.com/repo.git?***');
  assert.equal(shownRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});
