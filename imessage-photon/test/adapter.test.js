import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createPlugin } from '../index.js';
import { createPhotonAdapter } from '../lib/adapter.js';
import { parsePhotonConfig } from '../lib/config.js';
import { createFakePhoton, fakeTokenFetch } from './fake-photon.js';

const PROJECT = '0b5c2a52-7a7e-4c1f-9b3e-2f1d6e8a9c10';
const APPROVER = '+15551234821';
const PRINCIPAL = 'ava@example.com';
const STRANGER = '+15550009999';
const HOUR = 3_600_000;

const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await pause();
  }
  assert.fail('timed out waiting');
};

/** A gateway that answers every dispatch with `reply(input)` as one turn. */
const fakeGateway = (reply = (input) => ({ text: `echo: ${input.userMessage}` })) => {
  const dispatched = [];
  const listeners = new Set();
  const finished = new Map();
  return {
    dispatched,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    bus: { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
    agents: () => [{ id: 'ava', name: 'Ava' }],
    resolveApproval: () => false,
    dispatch: async (input) => {
      dispatched.push(input);
      if (finished.has(input.idempotencyKey)) {
        input.onRepeat?.('finished');
        return finished.get(input.idempotencyKey);
      }
      const outcome = await reply(input);
      if (outcome.throw) {
        throw outcome.throw;
      }
      const session = {
        id: input.sessionId,
        status: 'completed',
        messages: [{ role: 'user', content: input.userMessage, idempotencyKey: input.idempotencyKey }, ...(outcome.text !== undefined ? [{ role: 'assistant', content: outcome.text }] : [])],
      };
      finished.set(input.idempotencyKey, session);
      return session;
    },
  };
};

const CONFIG = { approvers: [APPROVER], principals: [APPROVER, PRINCIPAL] };

const setup = async (t, { photon = createFakePhoton(), gateway = fakeGateway(), directory, config = CONFIG, now, retryMs = [5], tokens = fakeTokenFetch() } = {}) => {
  const dir = directory ?? mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  if (!directory) {
    t.after(() => rmSync(dir, { recursive: true, force: true }));
  }
  const logs = [];
  const connected = [];
  const adapter = createPhotonAdapter({
    config: parsePhotonConfig(config, { withSecrets: ['ava'] }),
    secrets: { ava: { projectId: PROJECT, projectSecret: 'shh-secret' } },
    stateDirectory: path.join(dir, 'state'),
    connect: async (options) => {
      connected.push(options);
      return photon.client;
    },
    fetch: tokens.fetch,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(`WARN ${line}`),
    sendRetryMs: [1],
    startRetryMs: [5],
    retryMs,
    ...(now ? { now } : {}),
  });
  await adapter.start(gateway);
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await adapter.stop();
    }
  };
  t.after(stop);
  // On the line once the live stream is open.
  await waitFor(() => photon.liveCount() > 0 && adapter.status().ava?.[0]?.cursor !== undefined);
  return { adapter, photon, gateway, logs, connected, dir, stop, tokens };
};

test('the first start answers nothing from before it, then answers new texts in their chat', async (t) => {
  const photon = createFakePhoton();
  photon.receive({ from: APPROVER, text: 'old news', at: Date.now() - 1000 });
  const { gateway, logs, connected } = await setup(t, { photon });
  assert.equal(connected[0].address, 'imessage.spectrum.photon.codes:443');
  assert.equal(await connected[0].token(), 'shared-token-1');
  photon.receive({ from: APPROVER, text: 'hello there' });
  await waitFor(() => photon.sent.length === 1);
  assert.deepEqual(gateway.dispatched.map((input) => input.userMessage), ['hello there']);
  const input = gateway.dispatched[0];
  assert.equal(input.sessionId, `imessage-photon:ava:${APPROVER}`);
  assert.equal(input.metadata.channel, 'imessage-photon');
  assert.equal(input.metadata.senderTrust, 'user');
  assert.deepEqual(input.metadata.conversation, { kind: 'direct', with: APPROVER });
  assert.equal(photon.sent[0].chat, `any;-;${APPROVER}`);
  assert.equal(photon.sent[0].text, 'echo: hello there');
  assert.match(photon.sent[0].clientMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(logs.some((line) => line.includes('first start; texts before event 1 are history')));
  // Typing shown while the turn ran, then cleared.
  await waitFor(() => photon.typing.length === 2);
  assert.deepEqual(photon.typing, [[`any;-;${APPROVER}`, true], [`any;-;${APPROVER}`, false]]);
});

test('a text sent while the daemon was down is answered at the next start, and nothing is answered twice', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await setup(t, { photon, directory });
  photon.receive({ from: APPROVER, text: 'one' });
  await waitFor(() => photon.sent.length === 1);
  photon.other('message.read');
  await waitFor(() => first.adapter.status().ava[0].cursor === 2);
  await first.stop();

  photon.receive({ from: APPROVER, text: 'two, while you were down' });
  const second = await setup(t, { photon, directory });
  await waitFor(() => photon.sent.length === 2);
  await pause(50);
  assert.deepEqual(second.gateway.dispatched.map((input) => input.userMessage), ['two, while you were down']);
  assert.deepEqual(photon.sent.map((entry) => entry.text), ['echo: one', 'echo: two, while you were down']);
  assert.equal(photon.catchUps.at(-1), 2);
  const stored = JSON.parse(readFileSync(path.join(directory, 'state', 'ava.json'), 'utf8'));
  assert.deepEqual(stored, { version: 1, lines: { shared: { cursor: 3, settled: [] } } });
  assert.equal(statSync(path.join(directory, 'state', 'ava.json')).mode & 0o777, 0o600);
});

test('catch-up does not answer a text older than replayCapHours, and says so in the log', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await setup(t, { photon, directory });
  await first.stop();
  photon.receive({ from: APPROVER, text: 'from yesterday morning', at: Date.now() - 30 * HOUR });
  photon.receive({ from: APPROVER, text: 'from an hour ago', at: Date.now() - HOUR });
  const second = await setup(t, { photon, directory });
  await waitFor(() => photon.sent.length === 1);
  await pause(30);
  assert.deepEqual(second.gateway.dispatched.map((input) => input.userMessage), ['from an hour ago']);
  assert.ok(second.logs.some((line) => /not answering event 1, sent 30h ago/.test(line)));
  assert.equal(second.adapter.status().ava[0].cursor, 2);
});

test('a dropped connection reconnects and catches up from the last event it handed over', async (t) => {
  const { photon, gateway, logs, adapter } = await setup(t);
  photon.receive({ from: APPROVER, text: 'before the drop' });
  await waitFor(() => photon.sent.length === 1);
  photon.setOffline(new Error('unavailable'));
  photon.drop();
  photon.receive({ from: APPROVER, text: 'during the drop' });
  await pause(30);
  photon.setOffline(undefined);
  await waitFor(() => photon.sent.length === 2);
  await pause(30);
  assert.deepEqual(gateway.dispatched.map((input) => input.userMessage), ['before the drop', 'during the drop']);
  assert.ok(logs.some((line) => line.startsWith('WARN imessage-photon: ava line shared: the Photon connection dropped (connection reset)')));
  assert.equal(adapter.status().ava[0].cursor, 2);
  assert.ok(photon.catchUps.includes(1));
});

test('a refused read position starts again from the head and warns that texts may have been missed', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await setup(t, { photon, directory });
  photon.receive({ from: APPROVER, text: 'one' });
  await waitFor(() => photon.sent.length === 1);
  await first.stop();
  photon.receive({ from: APPROVER, text: 'lost to the refused cursor' });
  const refused = new Error('cursor out of range');
  refused.name = 'ValidationError';
  photon.rejectNextCursor(refused);
  const second = await setup(t, { photon, directory });
  await waitFor(() => second.logs.some((line) => line.includes('Photon refused the stored read position')));
  photon.receive({ from: APPROVER, text: 'after the re-seed' });
  await waitFor(() => photon.sent.length === 2);
  assert.deepEqual(second.gateway.dispatched.map((input) => input.userMessage), ['after the re-seed']);
});

test('a text the daemon was stopping for is kept: a note now, the answer after the restart, sent once', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stopping = Object.assign(new Error('stopping'), { name: 'GatewayStoppingError', restarting: true });
  const first = await setup(t, { photon, directory, gateway: fakeGateway(() => ({ throw: stopping })) });
  photon.receive({ from: APPROVER, text: 'are you there' });
  await waitFor(() => photon.sent.length === 1);
  assert.equal(photon.sent[0].text, "I'm restarting. I'll answer this when I'm back.");
  assert.deepEqual(first.adapter.status().ava[0].kept, [1]);
  assert.equal(first.adapter.status().ava[0].cursor, 0);
  await first.stop();
  const second = await setup(t, { photon, directory });
  await waitFor(() => photon.sent.length === 2);
  assert.equal(photon.sent[1].text, 'echo: are you there');
  // The note's id is its own, so Photon doesn't take the answer for a repeat of it.
  assert.notEqual(photon.sent[0].clientMessageId, photon.sent[1].clientMessageId);
  assert.equal(second.adapter.status().ava[0].cursor, 1);
});

test('an answer whose send failed is sent after the restart under the same id, so Photon keeps one', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = fakeGateway();
  const first = await setup(t, { photon, directory, gateway });
  photon.failSends(() => true);
  photon.receive({ from: APPROVER, text: 'hello' });
  await waitFor(() => first.logs.some((line) => line.includes('could not send its answer')));
  assert.deepEqual(first.adapter.status().ava[0].kept, [1]);
  await first.stop();
  photon.failSends(() => false);
  await setup(t, { photon, directory, gateway });
  await waitFor(() => photon.sent.length === 1);
  assert.equal(photon.sent[0].text, 'echo: hello');
  // The second delivery found the finished turn instead of running it again.
  assert.equal(gateway.dispatched.length, 2);
  assert.equal(gateway.dispatched[1].idempotencyKey, gateway.dispatched[0].idempotencyKey);
});

test('a send Photon took but never confirmed is sent again after the restart under the same id, so the person gets one copy', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await setup(t, { photon, directory });
  photon.failSends(() => 'after');
  photon.receive({ from: APPROVER, text: 'hello' });
  await waitFor(() => first.logs.some((line) => line.includes('could not send its answer')));
  assert.ok(first.logs.some((line) => line.includes('could not send, retrying: deadline exceeded')));
  await first.stop();
  photon.failSends(() => false);
  const second = await setup(t, { photon, directory });
  await waitFor(() => second.adapter.status().ava[0].cursor === 1);
  assert.deepEqual(photon.sent.map((entry) => entry.text), ['echo: hello']);
});

test('a text in both the catch-up and the live stream is answered once', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await setup(t, { photon, directory });
  await first.stop();
  photon.onNextCatchUp(() => photon.receive({ from: APPROVER, text: 'just as you came back' }));
  const second = await setup(t, { photon, directory });
  await waitFor(() => photon.sent.length === 1);
  await pause(50);
  assert.deepEqual(second.gateway.dispatched.map((input) => input.userMessage), ['just as you came back']);
  assert.equal(photon.sent.length, 1);
});

test('a later text answered while an earlier one is kept is not answered again after the restart', async (t) => {
  const photon = createFakePhoton();
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await setup(t, { photon, directory });
  photon.failSends((chat) => chat === `any;-;${APPROVER}`);
  photon.receive({ from: APPROVER, text: 'first' });
  await waitFor(() => first.adapter.status().ava[0].kept.length === 1);
  photon.failSends(() => false);
  photon.receive({ from: PRINCIPAL, text: 'second' });
  await waitFor(() => photon.sent.length === 1);
  await waitFor(() => first.adapter.status().ava[0].open.length === 1);
  const stored = JSON.parse(readFileSync(path.join(directory, 'state', 'ava.json'), 'utf8'));
  assert.deepEqual(stored.lines.shared, { cursor: 0, settled: [2] });
  await first.stop();
  const second = await setup(t, { photon, directory });
  await waitFor(() => second.adapter.status().ava[0].cursor === 2);
  await pause(30);
  assert.deepEqual(second.gateway.dispatched.map((input) => input.userMessage), ['first']);
  assert.deepEqual(photon.sent.map((entry) => entry.text), ['echo: second', 'echo: first']);
});

test('strangers, a principal over SMS, and group chats are refused before a turn; under admit anyone a stranger gets an unknown turn', async (t) => {
  const { photon, gateway, logs } = await setup(t);
  photon.receive({ from: STRANGER, text: 'hi' });
  photon.receive({ from: PRINCIPAL, text: 'over sms', service: 'SMS' });
  photon.receive({ from: APPROVER, text: 'in a group', chat: 'any;+;group-1' });
  photon.receive({ from: undefined, text: 'no sender' });
  await waitFor(() => logs.filter((line) => line.includes('refused a message')).length === 4);
  assert.equal(gateway.dispatched.length, 0);
  assert.equal(photon.sent.length, 0);
  assert.ok(logs.some((line) => line.includes('principal over SMS, not iMessage')));
  assert.ok(logs.some((line) => line.includes('group chat')));
  assert.ok(!logs.some((line) => line.includes(STRANGER)), 'handles are masked in the log');

  const open = await setup(t, { config: { ...CONFIG, admit: 'anyone' } });
  open.photon.receive({ from: STRANGER, text: 'hi' });
  await waitFor(() => open.photon.sent.length === 1);
  assert.equal(open.gateway.dispatched[0].metadata.senderTrust, 'unknown');
  assert.deepEqual(open.gateway.dispatched[0].metadata.conversation, { kind: 'direct' });
});

test('a file is named to the agent, not opened', async (t) => {
  const { photon, gateway } = await setup(t);
  photon.receive({ from: APPROVER, text: 'look', attachments: [{ fileName: 'IMG_1.HEIC', mimeType: 'image/heic', isHidden: false, isSticker: false }] });
  await waitFor(() => gateway.dispatched.length === 1);
  assert.equal(gateway.dispatched[0].userMessage, "look\n\n[They also sent a file this channel can't open yet: IMG_1.HEIC (image/heic).]");
});

test('approvals go to the approver by text with a code, and Y CODE allows', async (t) => {
  const resolved = [];
  const gateway = fakeGateway();
  gateway.resolveApproval = (input) => {
    resolved.push(input);
    gateway.emit({ type: 'tool.approval-resolved', requestId: input.requestId, answer: input.answer, reason: 'decided' });
    return true;
  };
  const { photon } = await setup(t, { gateway });
  photon.receive({ from: APPROVER, text: 'hi' });
  await waitFor(() => photon.sent.length === 1);
  gateway.emit({
    type: 'tool.approval-requested',
    agentId: 'ava',
    requestId: 'r1',
    call: { toolName: 'shell.run', input: { command: 'git push' } },
    risk: 'dangerous',
    always: 'scope',
    metadata: { channel: 'imessage-photon', photonTo: APPROVER },
  });
  await waitFor(() => photon.sent.length === 2);
  const prompt = photon.sent[1];
  assert.equal(prompt.chat, `any;-;${APPROVER}`, 'asked in the chat they texted from');
  const code = /Reply Y ([A-Z0-9]{6})/.exec(prompt.text)?.[1];
  assert.ok(code);
  // The right code over SMS is refused: an SMS sender id can be forged.
  photon.receive({ from: APPROVER, text: `y ${code}`, service: 'SMS' });
  await pause(30);
  assert.equal(resolved.length, 0);
  // One character off; never the code itself, which may end in X.
  photon.receive({ from: APPROVER, text: `n ${code.slice(0, 5)}${code.endsWith('X') ? 'Y' : 'X'}` });
  await waitFor(() => photon.sent.some((entry) => entry.text === "That code doesn't match a pending request."));
  photon.receive({ from: APPROVER, text: `y ${code.toLowerCase()}` });
  await waitFor(() => resolved.length === 1);
  assert.deepEqual(resolved[0], { requestId: 'r1', answer: 'once', actor: APPROVER });
  await waitFor(() => photon.sent.some((entry) => entry.text === 'Ava: shell.run allowed once.'));
  // Neither answer reached the agent as a message.
  assert.equal(gateway.dispatched.length, 1);
});

test('an approver with no chat yet gets one opened on the line; nobody reachable denies', async (t) => {
  const resolved = [];
  const gateway = fakeGateway();
  gateway.resolveApproval = (input) => {
    resolved.push(input);
    return true;
  };
  const { photon } = await setup(t, { gateway });
  gateway.emit({ type: 'tool.approval-requested', agentId: 'ava', requestId: 'r1', call: { toolName: 'shell.run' }, risk: 'gated', metadata: { channel: 'imessage-photon', photonTo: PRINCIPAL } });
  await waitFor(() => photon.sent.length === 1);
  assert.deepEqual(photon.created, [APPROVER]);
  assert.match(photon.sent[0].text, /in a conversation with a•••@example\.com/);
  photon.failSends(() => true);
  gateway.emit({ type: 'tool.approval-requested', agentId: 'ava', requestId: 'r2', call: { toolName: 'shell.run' }, risk: 'gated', metadata: { channel: 'imessage-photon', photonTo: APPROVER } });
  await waitFor(() => resolved.length === 1);
  assert.deepEqual(resolved[0], { requestId: 'r2', answer: 'deny', reason: 'undeliverable' });
  // A request from another surface is not this channel's to ask.
  gateway.emit({ type: 'tool.approval-requested', agentId: 'ava', requestId: 'r3', call: { toolName: 'shell.run' }, risk: 'gated', metadata: { channel: 'slack' } });
  await pause(30);
  assert.equal(resolved.length, 1);
});

test('an approval settled while its prompt is still going out is put to nobody else', async (t) => {
  const SECOND = 'bo@example.com';
  const gateway = fakeGateway();
  const { photon } = await setup(t, { gateway, config: { approvers: [APPROVER, SECOND], principals: [APPROVER, SECOND, PRINCIPAL] } });
  // The first approver's send fails once, and the request times out
  // while that send waits to be retried.
  let failed = false;
  photon.failSends((chat) => {
    if (chat === `any;-;${APPROVER}` && !failed) {
      failed = true;
      gateway.emit({ type: 'tool.approval-resolved', requestId: 'r1', answer: 'deny', reason: 'timeout' });
      return true;
    }
    return false;
  });
  gateway.emit({ type: 'tool.approval-requested', agentId: 'ava', requestId: 'r1', call: { toolName: 'shell.run' }, risk: 'gated', metadata: { channel: 'imessage-photon', photonTo: PRINCIPAL } });
  await waitFor(() => photon.sent.length >= 2);
  await pause(50);
  // Each approver hears how it ended, and no code arrives after that.
  assert.deepEqual(photon.sent.map((entry) => entry.chat).sort(), [`any;-;${APPROVER}`, `any;-;${SECOND}`]);
  assert.ok(photon.sent.every((entry) => !/Reply Y/.test(entry.text)), photon.sent.map((entry) => entry.text).join(' | '));
});

test('"stop" from an approver ends the turn running in their conversation', async (t) => {
  let release;
  const gateway = fakeGateway((input) => new Promise((resolve) => {
    release = resolve;
    input.signal.addEventListener('abort', () => resolve({ text: 'cut short' }), { once: true });
  }));
  const { photon } = await setup(t, { gateway });
  photon.receive({ from: APPROVER, text: 'do the long thing' });
  await waitFor(() => gateway.dispatched.length === 1);
  photon.receive({ from: APPROVER, text: 'Stop' });
  await waitFor(() => photon.sent.length === 1);
  assert.equal(photon.sent[0].text, 'Stopped.');
  assert.equal(gateway.dispatched.length, 1);
  release?.({ text: 'late' });
});

test('message.send reaches principals and approvers only', async (t) => {
  const { adapter, photon } = await setup(t);
  const target = await adapter.resolveOutbound({ agentId: 'ava', to: 'Ava@Example.com' });
  await target.post('**Reminder**: stand-up');
  assert.deepEqual(photon.created, [PRINCIPAL]);
  assert.deepEqual(photon.sent.map((entry) => [entry.chat, entry.text]), [[`any;-;${PRINCIPAL}`, 'Reminder: stand-up']]);
  await assert.rejects(adapter.resolveOutbound({ agentId: 'ava', to: STRANGER }), /only texts people listed/);
  await assert.rejects(adapter.resolveOutbound({ agentId: 'ava', to: 'not a handle' }), /not an iMessage handle/);
  await assert.rejects(adapter.resolveOutbound({ agentId: 'bo', to: APPROVER }), /bo is not on iMessage here/);
});

test('message.send with nothing left to text once formatted fails instead of reporting it sent', async (t) => {
  const { adapter, photon } = await setup(t);
  const target = await adapter.resolveOutbound({ agentId: 'ava', to: PRINCIPAL });
  await assert.rejects(target.post('---'), /nothing to send/);
  await assert.rejects(target.post('  \n '), /nothing to send/);
  assert.equal(photon.sent.length, 0);
});

test('an answer that is empty once formatted for iMessage sends nothing, says so in the log, and is not kept', async (t) => {
  const gateway = fakeGateway((input) => ({ text: input.userMessage === 'rule' ? '---' : `echo: ${input.userMessage}` }));
  const { photon, logs, adapter } = await setup(t, { gateway });
  photon.receive({ from: APPROVER, text: 'rule' });
  await waitFor(() => logs.some((line) => /empty once formatted for iMessage/.test(line)));
  photon.receive({ from: APPROVER, text: 'next' });
  await waitFor(() => photon.sent.length === 1);
  assert.equal(photon.sent[0].text, 'echo: next');
  await waitFor(() => adapter.status().ava[0].cursor === 2);
  assert.ok(!logs.some((line) => /could not send its answer/.test(line)), logs.join('\n'));
});

test('a message.send or approval text Photon took but never confirmed is retried under the same id, so it arrives once', async (t) => {
  const { adapter, photon } = await setup(t);
  let lost = 0;
  photon.failSends(() => (lost++ < 1 ? 'after' : false));
  const target = await adapter.resolveOutbound({ agentId: 'ava', to: PRINCIPAL });
  await target.post('stand-up in 5');
  assert.deepEqual(photon.sent.map((entry) => entry.text), ['stand-up in 5']);
  assert.ok(photon.sent[0].clientMessageId);
  // Another text with the same words is a new message, not a repeat.
  await target.post('stand-up in 5');
  assert.equal(photon.sent.length, 2);
  assert.notEqual(photon.sent[0].clientMessageId, photon.sent[1].clientMessageId);
});

test('an approver left out of principals is refused as a sender, but the chat they texted from still carries their approvals', async (t) => {
  const gateway = fakeGateway();
  const { photon, logs } = await setup(t, { gateway, config: { approvers: [APPROVER], principals: [PRINCIPAL] } });
  photon.receive({ from: APPROVER, text: 'hi' });
  // An SMS showing their number moves nothing: its sender id can be forged.
  photon.receive({ from: APPROVER, text: 'hello', service: 'SMS', chat: `SMS;-;${APPROVER}` });
  await waitFor(() => logs.filter((line) => /refused a message from/.test(line)).length === 2);
  gateway.emit({ type: 'tool.approval-requested', agentId: 'ava', requestId: 'r1', call: { toolName: 'shell.run' }, risk: 'gated', metadata: { channel: 'imessage-photon', photonTo: PRINCIPAL } });
  await waitFor(() => photon.sent.length === 1);
  assert.equal(photon.sent[0].chat, `any;-;${APPROVER}`);
  // Reached in the chat they opened: a shared-pool line can't start one.
  assert.deepEqual(photon.created, []);
  assert.equal(gateway.dispatched.length, 0);
});

test('a dedicated line is reached at its own address and answered on it', async (t) => {
  const tokens = fakeTokenFetch({ type: 'dedicated', lines: { 'abc123': '+15550001111' } });
  const { photon, connected, logs } = await setup(t, { tokens });
  assert.equal(connected.length, 1);
  assert.equal(connected[0].address, 'abc123.imsg.photon.codes:443');
  assert.equal(await connected[0].token(), 'token-abc123-1');
  assert.ok(logs.some((line) => line.includes('on +1•••••1111')));
  photon.receive({ from: APPROVER, text: 'hi' });
  await waitFor(() => photon.sent.length === 1);
});

test('a refused project secret is said once and the daemon carries on', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = [];
  const tokens = fakeTokenFetch({ status: 401 });
  const adapter = createPhotonAdapter({
    config: parsePhotonConfig(CONFIG, { withSecrets: ['ava'] }),
    secrets: { ava: { projectId: PROJECT, projectSecret: 'wrong-secret' } },
    stateDirectory: path.join(dir, 'state'),
    connect: async () => assert.fail('no line to connect'),
    fetch: tokens.fetch,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(`WARN ${line}`),
    startRetryMs: [5],
  });
  await adapter.start(fakeGateway());
  await waitFor(() => tokens.calls.length >= 3);
  await adapter.stop();
  const warnings = logs.filter((line) => line.startsWith('WARN'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Photon refused this project id and secret \(HTTP 401: Invalid project credentials\)/);
  assert.ok(!logs.join('\n').includes('wrong-secret'));
  assert.equal(tokens.calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${PROJECT}:wrong-secret`).toString('base64')}`);
  assert.equal(tokens.calls[0].url, `https://spectrum.photon.codes/projects/${PROJECT}/imessage/tokens`);
});

test('an unreadable read position keeps the agent off the line and names the file to remove', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await setup(t, { directory: dir });
  await first.stop();
  writeFileSync(path.join(dir, 'state', 'ava.json'), '{"version":1,"lines":{"shared":{"cursor":-4,"settled":[]}}}');
  const logs = [];
  const adapter = createPhotonAdapter({
    config: parsePhotonConfig(CONFIG, { withSecrets: ['ava'] }),
    secrets: { ava: { projectId: PROJECT, projectSecret: 'x' } },
    stateDirectory: path.join(dir, 'state'),
    connect: async () => assert.fail('must not connect'),
    fetch: fakeTokenFetch().fetch,
    warn: (line) => logs.push(line),
  });
  await adapter.start(fakeGateway());
  await waitFor(() => logs.length === 1);
  await adapter.stop();
  assert.match(logs[0], /ava is not on iMessage: .*ava\.json does not hold a read position this version understands\. Remove .*ava\.json to start reading from now on/);
});

test('the plugin registers the agents with a stored project and warns about the rest', async () => {
  const registered = [];
  const warnings = [];
  const plugin = createPlugin({ approvers: [APPROVER], agents: { bo: {}, cy: { approvers: [] } } }, {
    connect: async () => createFakePhoton().client,
    fetch: fakeTokenFetch().fetch,
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'imessage-photon-'));
  try {
    await plugin.setup({
      channels: {
        transportSecrets: async (kind) => {
          assert.equal(kind, 'imessage-photon');
          return { ava: { projectId: PROJECT, projectSecret: 's' }, cy: { projectId: PROJECT, projectSecret: 's' }, dee: { projectId: PROJECT } };
        },
        register: (contribution) => registered.push(contribution),
      },
      stateDirectory: { prepare: () => dir },
      warn: (line) => warnings.push(line),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(registered.length, 1);
  assert.equal(registered[0].adapter.name, 'imessage-photon');
  assert.deepEqual(registered[0].agents, ['ava']);
  assert.ok(warnings.some((line) => line.startsWith('imessage-photon: cy is not on iMessage: no approvers')));
  assert.ok(warnings.some((line) => line.includes('bo is configured but has no Photon project stored')));
});
