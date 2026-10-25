import assert from 'node:assert/strict';
import { test } from 'node:test';

import { admit, idempotencyKeyFor, sessionIdFor } from '../lib/admission.js';
import { parseImessageConfig } from '../lib/config.js';
import { maskHandle, normalizeHandle } from '../lib/handles.js';

const PHONE = '+15551234821';

test('handles normalize to lowercase email or E.164', () => {
  assert.equal(normalizeHandle(' Ava.Agent@iCloud.com '), 'ava.agent@icloud.com');
  assert.equal(normalizeHandle('+1 (555) 123-4821'), PHONE);
  assert.equal(normalizeHandle('+1.555.123.4821'), PHONE);
  assert.equal(normalizeHandle('5551234821'), null);
  assert.equal(normalizeHandle('+0123'), null);
  assert.equal(normalizeHandle('not-an-email@'), null);
  assert.equal(normalizeHandle(undefined), null);
});

test('maskHandle keeps enough to tell people apart, not to text them', () => {
  assert.equal(maskHandle(PHONE), '+1•••••4821');
  assert.equal(maskHandle('dylan@example.com'), 'd•••@example.com');
  assert.ok(!maskHandle(PHONE).includes('555123'));
});

const base = { handle: 'ava.agent@icloud.com', approvers: [PHONE] };

test('config: defaults apply under agents, principals default to approvers, admit to principals', () => {
  const { agents, refused } = parseImessageConfig({ ...base, agents: { ava: {} } }, { platform: 'darwin' });
  const ava = agents.get('ava');
  assert.equal(refused.size, 0);
  assert.equal(ava.delivery, 'local');
  assert.equal(ava.handle, 'ava.agent@icloud.com');
  assert.deepEqual([...ava.principals], [PHONE]);
  assert.equal(ava.admit, 'principals');
  assert.equal(ava.replayCapMs, 24 * 3_600_000);
});

test('config: an agent with no agents entry is not carried', () => {
  const { agents } = parseImessageConfig(base, { platform: 'darwin' });
  assert.equal(agents.size, 0);
});

test('config: an agent entry replaces a default list whole', () => {
  const { agents } = parseImessageConfig({ ...base, principals: [PHONE], agents: { ava: { principals: ['dylan@example.com'] } } }, { platform: 'darwin' });
  assert.deepEqual([...agents.get('ava').principals], ['dylan@example.com']);
});

test('config: refuses what it cannot honor, saying how to fix it', () => {
  const parse = (config) => () => parseImessageConfig(config, { platform: 'darwin' });
  assert.throws(parse({ approvers: [PHONE], agents: { ava: {} } }), /needs a handle/);
  assert.throws(parse({ handle: base.handle, agents: { ava: {} } }), /no approvers/);
  assert.throws(parse({ ...base, approvers: ['555-1234'], agents: { ava: {} } }), /E\.164/);
  assert.throws(parse({ ...base, admit: 'everyone', agents: { ava: {} } }), /admit/);
  assert.throws(parse({ ...base, delivery: 'sendblue', agents: { ava: {} } }), /doesn't have yet/);
  assert.throws(parse({ ...base, groups: true, agents: { ava: {} } }), /group chats/);
  assert.throws(parse({ ...base, replayCapHours: 0, agents: { ava: {} } }), /replayCapHours/);
  assert.throws(parse({ ...base, agents: { 'Bad Id': {} } }), /not an agent id/);
});

test('config: two local agents on one macOS login are both refused, by name', () => {
  const { agents, refused } = parseImessageConfig({ ...base, agents: { ava: {}, juno: { handle: 'juno@icloud.com' } } }, { platform: 'darwin' });
  assert.equal(agents.size, 0);
  assert.match(refused.get('ava'), /ava and juno/);
  assert.match(refused.get('juno'), /only one agent per macOS login/);
});

test('config: local delivery off macOS is refused with the reason', () => {
  const { agents, refused } = parseImessageConfig({ ...base, agents: { ava: {} } }, { platform: 'linux' });
  assert.equal(agents.size, 0);
  assert.match(refused.get('ava'), /needs macOS/);
});

const agent = (overrides = {}) => ({ principals: new Set([PHONE]), admit: 'principals', ...overrides });
const message = (overrides = {}) => ({ from: PHONE, service: 'iMessage', chat: { group: false }, ...overrides });

test('admit: a principal over iMessage is trusted as the user', () => {
  assert.deepEqual(admit(message(), agent()), { admit: true, from: PHONE, principal: true, senderTrust: 'user' });
});

test('admit: a principal over SMS, RCS or an unknown service is never a principal', () => {
  for (const service of ['SMS', 'RCS', 'unknown']) {
    const refused = admit(message({ service }), agent());
    assert.equal(refused.admit, false);
    assert.match(refused.reason, new RegExp(service));
    const anyone = admit(message({ service }), agent({ admit: 'anyone' }));
    assert.equal(anyone.admit, true);
    assert.equal(anyone.senderTrust, 'unknown');
  }
});

test('admit: a stranger is refused by default and labelled unknown under admit anyone', () => {
  assert.deepEqual(admit(message({ from: '+15550000000' }), agent()), { admit: false, reason: 'not a principal' });
  assert.equal(admit(message({ from: '+15550000000' }), agent({ admit: 'anyone' })).senderTrust, 'unknown');
});

test('admit: the sender is matched in normalized form', () => {
  const byEmail = agent({ principals: new Set(['dylan@example.com']) });
  assert.equal(admit(message({ from: 'Dylan@Example.com' }), byEmail).principal, true);
});

test('admit: group chats are refused for now', () => {
  assert.deepEqual(admit(message({ chat: { group: true } }), agent({ admit: 'anyone' })), { admit: false, reason: 'group chat' });
});

test('sessions and keys: one session per person per agent handle, one key per row', () => {
  assert.equal(sessionIdFor('ava', 'ava.agent@icloud.com', PHONE), `imessage:ava:ava.agent@icloud.com:${PHONE}`);
  assert.notEqual(sessionIdFor('ava', 'ava.agent@icloud.com', PHONE), sessionIdFor('ava', 'new@icloud.com', PHONE));
  assert.equal(idempotencyKeyFor('ava.agent@icloud.com', 'ABC-1'), 'imessage:ava.agent@icloud.com:ABC-1');
});
