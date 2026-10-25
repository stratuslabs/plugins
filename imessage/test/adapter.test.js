import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createPlugin } from '../index.js';
import { createImessageAdapter } from '../lib/adapter.js';
import { parseImessageConfig } from '../lib/config.js';
import { createWatermarkStore } from '../lib/watermark.js';
import { BODIES, createChatDb } from './chatdb-fixture.js';

const HANDLE = 'ava.agent@icloud.com';
const PHONE = '+15551234821';
const STRANGER = '+15550009999';

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A gateway that answers every dispatch with `reply(input)` as one turn. */
const fakeGateway = (reply = (input) => ({ text: `echo: ${input.userMessage}` })) => {
  const dispatched = [];
  return {
    dispatched,
    bus: { subscribe: () => () => {} },
    agents: () => [{ id: 'ava' }],
    resolveApproval: () => false,
    dispatch: async (input) => {
      dispatched.push(input);
      const outcome = await reply(input);
      if (outcome.throw) {
        throw outcome.throw;
      }
      if (outcome.repeat) {
        input.onRepeat?.(outcome.repeat);
      }
      const user = { role: 'user', content: input.userMessage, idempotencyKey: input.idempotencyKey, ...(outcome.turnError ? { turnError: outcome.turnError } : {}) };
      return {
        id: input.sessionId,
        status: outcome.turnError ? 'failed' : 'completed',
        messages: [...(outcome.before ?? []), user, ...(outcome.text !== undefined ? [{ role: 'assistant', content: outcome.text }] : []), ...(outcome.after ?? [])],
      };
    },
  };
};

const fakeSender = ({ fail = () => false } = {}) => {
  const sent = [];
  return {
    sent,
    sendText: async (to, text) => {
      if (fail(to, text)) {
        throw new Error('Messages refused the send: test');
      }
      sent.push([to, text]);
    },
  };
};

const setup = async (t, { config = {}, gateway = fakeGateway(), sender = fakeSender(), seed = true } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-adapter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const chatDb = path.join(directory, 'chat.db');
  const fixture = createChatDb(chatDb);
  const logs = [];
  const parsed = parseImessageConfig({ handle: HANDLE, approvers: [PHONE], agents: { ava: {} }, ...config }, { platform: 'darwin' });
  const stateDirectory = path.join(directory, 'state');
  const adapter = createImessageAdapter({
    config: parsed,
    stateDirectory,
    chatDb,
    sender,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(`WARN ${line}`),
    intervalMs: 10,
    watch: false,
    sendRetryMs: [1, 1],
  });
  t.after(async () => {
    await adapter.stop();
    fixture.close();
  });
  if (seed) {
    await adapter.start(gateway);
  }
  return { directory, chatDb, fixture, adapter, gateway, sender, logs, stateDirectory };
};

const waitFor = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await settle();
  }
  assert.fail('timed out waiting');
};

test('a principal texting over iMessage gets a turn as the user, and the answer back as plain text', async (t) => {
  const gateway = fakeGateway(() => ({ text: '**Sure.** See [the docs](https://example.com/docs).' }));
  const { fixture, sender } = await setup(t, { gateway });
  const { guid } = fixture.received(PHONE, { body: BODIES[1].blob });
  await waitFor(() => sender.sent.length === 1);
  const [input] = gateway.dispatched;
  assert.equal(input.sessionId, `imessage:ava:${HANDLE}:${PHONE}`);
  assert.equal(input.agentId, 'ava');
  assert.equal(input.userMessage, BODIES[1].text);
  assert.equal(input.idempotencyKey, `imessage:${HANDLE}:${guid}`);
  assert.equal(input.metadata.senderTrust, 'user');
  assert.deepEqual(input.metadata.conversation, { kind: 'direct', with: PHONE });
  assert.deepEqual(sender.sent, [[PHONE, 'Sure. See the docs (https://example.com/docs).']]);
});

test('history in chat.db before the first start is never answered', async (t) => {
  const { fixture, sender, gateway, adapter } = await setup(t, { seed: false });
  fixture.received(PHONE);
  await adapter.start(gateway);
  await settle();
  await settle();
  assert.equal(gateway.dispatched.length, 0);
  fixture.received(PHONE);
  await waitFor(() => sender.sent.length === 1);
  assert.equal(gateway.dispatched.length, 1);
});

test('a stranger and a principal over SMS are refused before any turn, and the log masks them', async (t) => {
  const { fixture, sender, gateway, logs } = await setup(t);
  fixture.received(STRANGER);
  fixture.received(PHONE, { service: 'SMS' });
  const last = fixture.received(PHONE);
  await waitFor(() => sender.sent.length === 1);
  assert.equal(gateway.dispatched.length, 1);
  assert.match(gateway.dispatched[0].idempotencyKey, new RegExp(last.guid));
  const all = logs.join('\n');
  assert.match(all, /not a principal/);
  assert.match(all, /over SMS, not iMessage/);
  assert.ok(!all.includes(STRANGER) && !all.includes(PHONE));
});

test('under admit anyone a stranger gets a turn labelled unknown, with nobody named', async (t) => {
  const { fixture, sender, gateway } = await setup(t, { config: { admit: 'anyone' } });
  fixture.received(STRANGER);
  await waitFor(() => sender.sent.length === 1);
  assert.equal(gateway.dispatched[0].metadata.senderTrust, 'unknown');
  assert.deepEqual(gateway.dispatched[0].metadata.conversation, { kind: 'direct' });
  assert.equal(sender.sent[0][0], STRANGER);
});

test('a failed turn is told to the person', async (t) => {
  const gateway = fakeGateway(() => ({ turnError: 'provider unavailable' }));
  const { fixture, sender } = await setup(t, { gateway });
  fixture.received(PHONE);
  await waitFor(() => sender.sent.length === 1);
  assert.match(sender.sent[0][1], /couldn't finish that: provider unavailable/);
});

test('a repeat of a finished turn sends that turn\'s answer, not the newest one', async (t) => {
  const gateway = fakeGateway(() => ({ repeat: 'finished', text: 'the original answer', after: [{ role: 'user', content: 'later' }, { role: 'assistant', content: 'a later answer' }] }));
  const { fixture, sender } = await setup(t, { gateway });
  fixture.received(PHONE);
  await waitFor(() => sender.sent.length === 1);
  assert.deepEqual(sender.sent, [[PHONE, 'the original answer']]);
});

test('a repeat that another delivery is answering sends nothing', async (t) => {
  const gateway = fakeGateway(() => ({ repeat: 'live', text: 'x' }));
  const { fixture, sender, stateDirectory } = await setup(t, { gateway });
  const row = fixture.received(PHONE);
  await waitFor(() => createWatermarkStore({ directory: stateDirectory }).load('ava').record?.watermark === row.rowid);
  assert.deepEqual(sender.sent, []);
});

test('a daemon on its way down says so and keeps the message for the next start', async (t) => {
  const stopping = Object.assign(new Error('stopping'), { name: 'GatewayStoppingError', restarting: true });
  const gateway = fakeGateway(() => ({ throw: stopping }));
  const { fixture, sender, stateDirectory } = await setup(t, { gateway });
  const store = createWatermarkStore({ directory: stateDirectory });
  const before = store.load('ava').record.watermark;
  fixture.received(PHONE);
  await waitFor(() => sender.sent.length === 1);
  await settle();
  assert.match(sender.sent[0][1], /restarting/);
  assert.equal(store.load('ava').record.watermark, before);
});

test('a dispatch the gateway refuses is told to the person and not retried', async (t) => {
  const gateway = fakeGateway(() => ({ throw: new Error('unknown agent') }));
  const { fixture, sender, stateDirectory } = await setup(t, { gateway });
  const row = fixture.received(PHONE);
  await waitFor(() => sender.sent.length === 1);
  await waitFor(() => createWatermarkStore({ directory: stateDirectory }).load('ava').record.watermark === row.rowid);
  assert.match(sender.sent[0][1], /couldn't start on that: unknown agent/);
  assert.equal(gateway.dispatched.length, 1);
});

test('an answer Messages will not send is kept for the next start, after retries', async (t) => {
  let attempts = 0;
  const sender = fakeSender({ fail: () => { attempts += 1; return true; } });
  const { fixture, logs, stateDirectory } = await setup(t, { sender });
  const store = createWatermarkStore({ directory: stateDirectory });
  const before = store.load('ava').record.watermark;
  fixture.received(PHONE);
  await waitFor(() => logs.some((line) => /will be sent after the next start/.test(line)));
  assert.equal(attempts, 3);
  assert.equal(store.load('ava').record.watermark, before);
});

test('a long answer goes as several messages, in order', async (t) => {
  const long = Array.from({ length: 30 }, (_, index) => `Paragraph ${index} ${'word '.repeat(40)}`).join('\n\n');
  const gateway = fakeGateway(() => ({ text: long }));
  const { fixture, sender } = await setup(t, { gateway });
  fixture.received(PHONE);
  await waitFor(() => sender.sent.length >= 2);
  await settle();
  assert.ok(sender.sent.every(([, text]) => text.length <= 4000));
  assert.match(sender.sent[0][1], /^Paragraph 0/);
  assert.equal(sender.sent.map(([, text]) => text).join('\n\n').replace(/\s+/g, ' '), long.replace(/\s+/g, ' ').trim());
});

test('resolveOutbound texts the agent\'s own people and refuses anyone else, before sending', async (t) => {
  const { adapter, sender } = await setup(t, { config: { principals: ['dylan@example.com'] } });
  const connection = await adapter.resolveOutbound({ agentId: 'ava', to: 'Dylan@Example.com' });
  await connection.post('Good morning');
  const approver = await adapter.resolveOutbound({ agentId: 'ava', to: '+1 (555) 123-4821' });
  await approver.post('Hi');
  assert.deepEqual(sender.sent, [['dylan@example.com', 'Good morning'], [PHONE, 'Hi']]);
  await assert.rejects(adapter.resolveOutbound({ agentId: 'ava', to: STRANGER }), /only texts people listed/);
  await assert.rejects(adapter.resolveOutbound({ agentId: 'ava', to: '555-1234' }), /not an iMessage handle/);
  await assert.rejects(adapter.resolveOutbound({ agentId: 'juno', to: PHONE }), /not on iMessage here/);
  assert.equal(sender.sent.length, 2);
});

test('an unreadable watermark file keeps the agent off iMessage and says how to recover', async (t) => {
  const { adapter, gateway, stateDirectory, logs } = await setup(t, { seed: false });
  createWatermarkStore({ directory: stateDirectory });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(path.join(stateDirectory, 'watermarks.json'), 'not json');
  await adapter.start(gateway);
  assert.deepEqual(adapter.status(), {});
  assert.ok(logs.some((line) => line.startsWith('WARN') && /not JSON/.test(line) && /Remove/.test(line)));
});

test('a chat.db that cannot be opened names the Full Disk Access fix', async (t) => {
  const { adapter, gateway, logs } = await setup(t, { seed: false });
  const blocked = createImessageAdapter({
    config: parseImessageConfig({ handle: HANDLE, approvers: [PHONE], agents: { ava: {} } }, { platform: 'darwin' }),
    stateDirectory: mkdtempSync(path.join(tmpdir(), 'imessage-adapter-')),
    chatDb: '/nonexistent/chat.db',
    warn: (line) => logs.push(`WARN ${line}`),
  });
  await blocked.start(gateway);
  await blocked.stop();
  await adapter.stop();
  assert.ok(logs.some((line) => /Full Disk Access/.test(line) && line.includes(process.execPath)));
});

test('createPlugin registers the configured agent and names any it refused', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-plugin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registered = [];
  const warnings = [];
  const context = {
    channels: { register: (entry) => registered.push(entry) },
    stateDirectory: { prepare: () => directory },
    warn: (line) => warnings.push(line),
  };
  await createPlugin({ handle: HANDLE, approvers: [PHONE], agents: { ava: {} } }, { platform: 'darwin' }).setup(context);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].agents, ['ava']);
  assert.equal(registered[0].adapter.name, 'imessage');

  await createPlugin({ handle: HANDLE, approvers: [PHONE], agents: { ava: {}, juno: {} } }, { platform: 'darwin' }).setup(context);
  assert.deepEqual(registered[1].agents, []);
  assert.ok(warnings.some((line) => /ava and juno/.test(line)));

  await assert.rejects(createPlugin({}, {}).setup({ channels: context.channels }), /no state directory/);
  await assert.rejects(createPlugin({}, {}).setup({}), /no channel handle/);
});

test('"stop" from an approver ends the turn running in their conversation; with nothing running it is a message', async (t) => {
  let release;
  const aborted = [];
  const gateway = fakeGateway((input) => new Promise((resolve) => {
    release = () => resolve({ text: 'late answer' });
    input.signal?.addEventListener('abort', () => { aborted.push(input.signal.reason.message); resolve({ text: 'partial' }); });
  }));
  gateway.abortTurns = (sessionId, reason) => { aborted.push(`host:${sessionId}:${reason}`); return 1; };
  const { fixture, sender } = await setup(t, { gateway });
  fixture.received(PHONE, { text: 'do a long thing', body: null });
  await waitFor(() => gateway.dispatched.length === 1);
  fixture.received(PHONE, { text: 'Stop.', body: null });
  await waitFor(() => sender.sent.length === 1);
  assert.deepEqual(sender.sent, [[PHONE, 'Stopped.']]);
  assert.ok(aborted.some((line) => /Stopped from iMessage by \+1•••••4821/.test(line)));
  assert.ok(aborted.some((line) => line.startsWith(`host:imessage:ava:${HANDLE}:${PHONE}`)));
  assert.equal(gateway.dispatched.length, 1);
  release?.();
});

test('"stop" over SMS, or from someone who is not an approver, stops nothing', async (t) => {
  const gateway = fakeGateway(() => ({ text: 'fine' }));
  let calls = 0;
  gateway.abortTurns = () => { calls += 1; return 1; };
  const { fixture, sender } = await setup(t, { gateway, config: { principals: [PHONE, STRANGER] } });
  fixture.received(PHONE, { text: 'stop', body: null, service: 'SMS' });
  fixture.received(STRANGER, { text: 'stop', body: null });
  await waitFor(() => sender.sent.length === 1);
  assert.equal(calls, 0);
  assert.equal(gateway.dispatched.length, 1);
  assert.equal(gateway.dispatched[0].userMessage, 'stop');
});

test('an attachment the channel cannot pass on is named in the turn, not silently dropped', async (t) => {
  const { fixture, gateway, sender } = await setup(t);
  fixture.received(PHONE, { text: '￼', body: null, attachments: 1 });
  fixture.received(PHONE, { text: 'look', body: null, attachments: 2 });
  await waitFor(() => sender.sent.length === 2);
  assert.match(gateway.dispatched[0].userMessage, /^\[An attachment was sent with this message; this channel can't pass attachments on yet\.\]$/);
  assert.match(gateway.dispatched[1].userMessage, /^look\n\n\[2 attachments were sent/);
});
