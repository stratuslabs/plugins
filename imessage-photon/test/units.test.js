import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { admit, idempotencyKeyFor, isGroupChat, sessionIdFor } from '../lib/admission.js';
import { createPhotonAuth, PhotonAuthError } from '../lib/cloud.js';
import { parsePhotonConfig } from '../lib/config.js';
import { createCursorStore } from '../lib/cursor.js';
import { messageOf } from '../lib/intake.js';
import { fakeTokenFetch } from './fake-photon.js';

const PROJECT = '0b5c2a52-7a7e-4c1f-9b3e-2f1d6e8a9c10';

test('config: defaults at the top, an agent entry replaces a key whole, principals default to the approvers', () => {
  const parsed = parsePhotonConfig({
    approvers: ['+1 (555) 123-4821'],
    agents: { bo: { approvers: ['Bo@Example.com'], principals: ['+15550001111'], admit: 'anyone', replayCapHours: 2 } },
  }, { withSecrets: ['ava', 'bo'] });
  assert.deepEqual([...parsed.agents.keys()], ['ava', 'bo']);
  const ava = parsed.agents.get('ava');
  assert.deepEqual([...ava.approvers], ['+15551234821']);
  assert.deepEqual([...ava.principals], ['+15551234821']);
  assert.equal(ava.admit, 'principals');
  assert.equal(ava.replayCapMs, 24 * 3_600_000);
  const bo = parsed.agents.get('bo');
  assert.deepEqual([...bo.approvers], ['bo@example.com']);
  assert.deepEqual([...bo.principals], ['+15550001111']);
  assert.equal(bo.admit, 'anyone');
  assert.equal(bo.replayCapMs, 2 * 3_600_000);
});

test('config: an agent with no approvers is refused, one with no project is unbound, a bad setting fails the load', () => {
  const parsed = parsePhotonConfig({ agents: { ava: {}, bo: { approvers: ['+15551234821'] } } }, { withSecrets: ['ava'] });
  assert.equal(parsed.agents.size, 0);
  assert.match(parsed.refused.get('ava'), /no approvers/);
  assert.deepEqual(parsed.unbound, ['bo']);
  assert.throws(() => parsePhotonConfig({ approvers: ['not a handle'] }), /not an email or a phone number/);
  assert.throws(() => parsePhotonConfig({ approvers: ['+15551234821'], admit: 'everyone' }), /admit must be/);
  assert.throws(() => parsePhotonConfig({ approvers: ['+15551234821'], replayCapHours: 0 }), /replayCapHours/);
  assert.throws(() => parsePhotonConfig({ handle: 'x' }), /unknown setting "handle"/);
  assert.throws(() => parsePhotonConfig({ agents: { 'Not An Id': {} } }), /not an agent id/);
  // A typo under an agent with no project yet still fails the load.
  assert.throws(() => parsePhotonConfig({ agents: { bo: { admit: 'all' } } }), /agents\.bo\.admit/);
});

test('admission: principal only over iMessage; sessions per person; groups detected', () => {
  const agent = { principals: new Set(['+15551234821']), admit: 'principals' };
  assert.deepEqual(admit({ from: '+15551234821', service: 'iMessage' }, agent), { admit: true, from: '+15551234821', principal: true, senderTrust: 'user' });
  assert.equal(admit({ from: '+15551234821', service: 'RCS' }, agent).admit, false);
  assert.equal(admit({ from: '+15551234821', service: 'iMessage', group: true }, agent).reason, 'group chat');
  assert.equal(sessionIdFor('ava', '+15551234821'), 'imessage-photon:ava:+15551234821');
  assert.equal(idempotencyKeyFor('ava', 'g-1'), 'imessage-photon:ava:g-1');
  assert.equal(isGroupChat('any;+;abc'), true);
  assert.equal(isGroupChat('any;-;+15551234821'), false);
});

test('messageOf: own messages, reactions, empty ones and other events carry nothing to answer', () => {
  const base = { type: 'message.received', sequence: 4, chatGuid: 'any;-;+15551234821', message: { guid: 'g', isFromMe: false, content: { text: 'hi', attachments: [] }, sender: { address: '+15551234821', service: 'iMessage' }, dateCreated: new Date(1000) } };
  assert.deepEqual(messageOf(base, 'shared'), { sequence: 4, guid: 'g', from: '+15551234821', service: 'iMessage', text: 'hi', attachments: [], chatGuid: 'any;-;+15551234821', group: false, sentAt: 1000, line: 'shared' });
  assert.equal(messageOf({ ...base, message: { ...base.message, isFromMe: true } }), undefined);
  assert.equal(messageOf({ ...base, message: { ...base.message, reaction: { kind: 'love' } } }), undefined);
  assert.equal(messageOf({ ...base, message: { ...base.message, content: { text: '  ', attachments: [{ isHidden: true }] } } }), undefined);
  assert.equal(messageOf({ type: 'message.read', sequence: 5 }), undefined);
  assert.equal(messageOf({ ...base, message: { ...base.message, sender: undefined } }).service, 'unknown');
});

test('auth: a token is reused until 80% of its life, then renewed, and concurrent callers share one request', async () => {
  let clock = 0;
  const tokens = fakeTokenFetch({ expiresIn: 100 });
  const auth = createPhotonAuth({ projectId: PROJECT, projectSecret: 's', fetch: tokens.fetch, now: () => clock });
  const [a, b] = await Promise.all([auth.token('shared'), auth.token('shared')]);
  assert.equal(a, 'shared-token-1');
  assert.equal(b, 'shared-token-1');
  assert.equal(tokens.calls.length, 1);
  clock = 79_999;
  assert.equal(await auth.token('shared'), 'shared-token-1');
  clock = 80_000;
  assert.equal(await auth.token('shared'), 'shared-token-2');
  assert.deepEqual(await auth.lines(), [{ key: 'shared', address: 'imessage.spectrum.photon.codes:443', shared: true }]);
});

test('auth: dedicated lines, a line Photon stops listing, and ids this plugin refuses', async () => {
  const tokens = fakeTokenFetch({ type: 'dedicated', lines: { 'abc123': '+15550001111', 'bad id!': '+15550002222' } });
  const auth = createPhotonAuth({ projectId: PROJECT, projectSecret: 's', fetch: tokens.fetch });
  assert.deepEqual(await auth.lines(), [{ key: 'abc123', address: 'abc123.imsg.photon.codes:443', phone: '+15550001111', shared: false }]);
  await assert.rejects(auth.token('gone'), /no longer lists line gone/);
  assert.throws(() => createPhotonAuth({ projectId: 'pho_prj_123', projectSecret: 's' }), /Photon 2\.0 \(Beta\) project/);
  assert.throws(() => createPhotonAuth({ projectId: 'nope', projectSecret: 's' }), PhotonAuthError);
  assert.throws(() => createPhotonAuth({ projectId: PROJECT, projectSecret: '' }), /No projectSecret/);
  const broken = createPhotonAuth({ projectId: PROJECT, projectSecret: 's', fetch: async () => ({ ok: true, status: 200, json: async () => ({ succeed: true, data: { type: 'shared', expiresIn: 60 } }) }) });
  await assert.rejects(broken.lines(), /isn't an iMessage token payload/);
  const down = createPhotonAuth({ projectId: PROJECT, projectSecret: 's', fetch: async () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(down.lines(), /Could not reach Photon to get iMessage tokens: ENOTFOUND/);
});

test('cursor store: round trip, nothing yet, and refusing a file it cannot trust', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-cursor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createCursorStore({ directory });
  assert.equal(store.load('ava'), undefined);
  store.save('ava', { lines: { shared: { cursor: 7, settled: [9] } } });
  assert.deepEqual(store.load('ava'), { lines: { shared: { cursor: 7, settled: [9] } } });
  writeFileSync(store.file('ava'), 'not json');
  assert.throws(() => store.load('ava'), /is not valid JSON/);
  writeFileSync(store.file('ava'), JSON.stringify({ version: 1, lines: { shared: { cursor: 7, settled: [3] } } }));
  assert.throws(() => store.load('ava'), /does not hold a read position/);
  writeFileSync(store.file('ava'), JSON.stringify({ version: 2, lines: {} }));
  assert.throws(() => store.load('ava'), /does not hold a read position/);
});
