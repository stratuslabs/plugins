import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createImessageAdapter } from '../lib/adapter.js';
import { CODE_ALPHABET, newCode, parseAnswer, promptText } from '../lib/approvals.js';
import { parseImessageConfig } from '../lib/config.js';
import { createChatDb } from './chatdb-fixture.js';

const HANDLE = 'ava.agent@icloud.com';
const APPROVER = '+15551234821';
const OTHER_APPROVER = 'dylan@example.com';
const PRINCIPAL = '+15557770000';
const STRANGER = '+15550009999';

const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
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

/** A gateway whose bus the test drives, recording every approval decision. */
const fakeHost = ({ asyncResolve = false } = {}) => {
  const listeners = new Set();
  const resolved = [];
  const pending = new Set();
  const dispatched = [];
  const emit = (event) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  return {
    dispatched,
    resolved,
    emit,
    request: (requestId, fields = {}) => {
      pending.add(requestId);
      emit({
        type: 'tool.approval-requested',
        sessionId: `imessage:ava:${HANDLE}:${APPROVER}`,
        agentId: 'ava',
        requestId,
        call: { toolName: 'shell.run', input: { command: 'git push' } },
        risk: 'dangerous',
        always: 'scope',
        metadata: { channel: 'imessage', imessageTo: APPROVER },
        ...fields,
      });
    },
    bus: { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
    agents: () => [{ id: 'ava', name: 'Ava' }],
    resolveApproval: (input) => {
      resolved.push(input);
      if (!pending.has(input.requestId)) {
        return false;
      }
      // A real gateway keeps the request answerable until it has settled
      // it; resolving twice in that window must not happen.
      const event = { type: 'tool.approval-resolved', sessionId: 's', requestId: input.requestId, answer: input.answer, reason: input.reason ?? 'decided', ...(input.actor ? { actor: input.actor } : {}) };
      if (asyncResolve) {
        setTimeout(() => { pending.delete(input.requestId); emit(event); }, 50);
      } else {
        pending.delete(input.requestId);
        emit(event);
      }
      return true;
    },
    expire: (requestId) => {
      pending.delete(requestId);
      emit({ type: 'tool.approval-resolved', sessionId: 's', requestId, answer: 'deny', reason: 'timeout' });
    },
    dispatch: async (input) => {
      dispatched.push(input);
      return { id: input.sessionId, status: 'completed', messages: [{ role: 'user', content: input.userMessage, idempotencyKey: input.idempotencyKey }, { role: 'assistant', content: 'ok' }] };
    },
  };
};

const setup = async (t, config = {}, hostOptions = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'imessage-approvals-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const chatDb = path.join(directory, 'chat.db');
  const fixture = createChatDb(chatDb);
  const sent = [];
  const logs = [];
  const host = fakeHost(hostOptions);
  // Codes from a fixed sequence, so the test knows them; the real one is crypto.randomInt.
  let draw = 0;
  const random = (max) => (draw++ * 7) % max;
  const adapter = createImessageAdapter({
    config: parseImessageConfig({ handle: HANDLE, approvers: [APPROVER, OTHER_APPROVER], principals: [APPROVER, PRINCIPAL], agents: { ava: {} }, ...config }, { platform: 'darwin' }),
    stateDirectory: path.join(directory, 'state'),
    chatDb,
    sender: { sendText: async (to, text) => { sent.push([to, text]); } },
    log: (line) => logs.push(line),
    warn: (line) => logs.push(`WARN ${line}`),
    intervalMs: 10,
    watch: false,
    sendRetryMs: [1],
    random,
  });
  await adapter.start(host);
  t.after(async () => {
    await adapter.stop();
    fixture.close();
  });
  const codeIn = (text) => /Reply Y ([A-Z0-9]{6})/.exec(text)?.[1];
  return { fixture, host, sent, logs, codeIn };
};

test('codes are 6 characters from the lookalike-free alphabet', () => {
  assert.equal(CODE_ALPHABET.length, 31);
  assert.ok(!/[01ILO]/.test(CODE_ALPHABET));
  for (let index = 0; index < 50; index += 1) {
    const code = newCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  }
});

test('parseAnswer reads only a message that is nothing but the answer', () => {
  assert.deepEqual(parseAnswer('Y k7qm2x'), { answer: 'once', code: 'K7QM2X' });
  assert.deepEqual(parseAnswer(' always K7QM2X. '), { answer: 'always', code: 'K7QM2X' });
  assert.deepEqual(parseAnswer('no'), { answer: 'deny' });
  assert.equal(parseAnswer('no worries, thanks'), undefined);
  assert.equal(parseAnswer('maybe K7QM2X'), undefined);
  assert.equal(parseAnswer('yes please do it'), undefined);
});

test('a one-shot request never offers ALWAYS', () => {
  const text = promptText({ agentName: 'Ava', toolName: 'browser.act', risk: 'risky', oneShot: true, always: 'origin', code: 'K7QM2X' });
  assert.ok(!text.includes('ALWAYS'));
  assert.match(text, /Reply Y K7QM2X to allow or N K7QM2X to deny/);
});

test('the approver in the conversation is asked by text, and the right code from them settles it once', async (t) => {
  const { fixture, host, sent, logs, codeIn } = await setup(t);
  host.request('r1');
  await waitFor(() => sent.length === 1);
  const [to, prompt] = sent[0];
  assert.equal(to, APPROVER);
  assert.match(prompt, /^Ava wants to run shell.run \(dangerous\)\./);
  assert.match(prompt, /"command":"git push"/);
  assert.match(prompt, /ALWAYS/);
  const code = codeIn(prompt);
  assert.ok(code);
  fixture.received(APPROVER, { text: `y ${code.toLowerCase()}`, body: null });
  await waitFor(() => sent.length === 2);
  assert.deepEqual(host.resolved, [{ requestId: 'r1', answer: 'once', actor: APPROVER }]);
  assert.equal(sent[1][1], 'Ava: shell.run allowed once.');
  assert.equal(host.dispatched.length, 0);
  // Spent: the same answer again is just a message now.
  fixture.received(APPROVER, { text: `y ${code}`, body: null });
  await waitFor(() => host.dispatched.length === 1);
  assert.equal(host.resolved.length, 1);
  assert.ok(!logs.join('\n').includes(code));
});

test('ALWAYS answers always', async (t) => {
  const { fixture, host, sent, codeIn } = await setup(t);
  host.request('r1');
  await waitFor(() => sent.length === 1);
  fixture.received(APPROVER, { text: `ALWAYS ${codeIn(sent[0][1])}`, body: null });
  await waitFor(() => host.resolved.length === 1);
  assert.equal(host.resolved[0].answer, 'always');
});

test('the right code over SMS does not count, and three wrong answers deny the request', async (t) => {
  const { fixture, host, sent, logs, codeIn } = await setup(t);
  host.request('r1');
  await waitFor(() => sent.length === 1);
  const code = codeIn(sent[0][1]);
  fixture.received(APPROVER, { text: `Y ${code}`, body: null, service: 'SMS' });
  fixture.received(STRANGER, { text: `Y ${code}`, body: null });
  await pause(100);
  assert.deepEqual(host.resolved, []);
  // Neither the SMS sender nor the stranger is answered.
  assert.equal(sent.length, 1);
  fixture.received(APPROVER, { text: 'Y ZZZZZZ', body: null });
  await waitFor(() => host.resolved.length === 1);
  assert.deepEqual(host.resolved[0], { requestId: 'r1', answer: 'deny', reason: 'undeliverable' });
  await waitFor(() => sent.some(([, text]) => /3 wrong answers/.test(text)));
  assert.ok(sent.some(([to, text]) => to === APPROVER && /doesn't match/.test(text)));
  assert.ok(logs.some((line) => line.startsWith('WARN') && /wrong answers/.test(line)));
  assert.equal(host.dispatched.length, 0);
});

test('a bare yes from the asked approver gets a hint, is not a guess and is not sent to the agent', async (t) => {
  const { fixture, host, sent, codeIn } = await setup(t);
  host.request('r1');
  await waitFor(() => sent.length === 1);
  for (let index = 0; index < 4; index += 1) {
    fixture.received(APPROVER, { text: 'yes', body: null });
  }
  await waitFor(() => sent.filter(([, text]) => /reply with its code too/.test(text)).length === 4);
  assert.deepEqual(host.resolved, []);
  assert.equal(host.dispatched.length, 0);
  fixture.received(APPROVER, { text: `N ${codeIn(sent[0][1])}`, body: null });
  await waitFor(() => host.resolved.length === 1);
  assert.equal(host.resolved[0].answer, 'deny');
});

test('a conversation with someone who is not an approver asks every approver, naming who it is about', async (t) => {
  const { host, sent } = await setup(t);
  host.request('r1', { metadata: { channel: 'imessage', imessageTo: PRINCIPAL } });
  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent.map(([to]) => to).sort(), [APPROVER, OTHER_APPROVER].sort());
  assert.ok(sent.every(([, text]) => text.includes('in a conversation with +1•••••0000')));
  assert.ok(sent.every(([, text]) => !text.includes(PRINCIPAL)));
});

test('a request from another surface is left alone', async (t) => {
  const { host, sent, logs } = await setup(t);
  host.request('r1', { metadata: { channel: 'slack', slackChannel: 'C1' } });
  await pause(100);
  assert.deepEqual(sent, []);
  assert.deepEqual(host.resolved, []);
  assert.deepEqual(logs.filter((line) => line.startsWith('WARN')), []);
});

test('a code is spent by its first answer, even before the gateway reports the request settled', async (t) => {
  const { fixture, host, sent, codeIn } = await setup(t, {}, { asyncResolve: true });
  host.request('r1');
  await waitFor(() => sent.length === 1);
  const code = codeIn(sent[0][1]);
  fixture.received(APPROVER, { text: `Y ${code}`, body: null });
  fixture.received(APPROVER, { text: `N ${code}`, body: null });
  await waitFor(() => sent.some(([, text]) => /allowed once/.test(text)));
  assert.deepEqual(host.resolved, [{ requestId: 'r1', answer: 'once', actor: APPROVER }]);
});

test('a request for an agent that is not on iMessage here is denied at once, not left to time out', async (t) => {
  const { host, sent } = await setup(t);
  host.request('r1', { agentId: 'juno' });
  await waitFor(() => host.resolved.length === 1);
  assert.deepEqual(host.resolved[0], { requestId: 'r1', answer: 'deny', reason: 'undeliverable' });
  assert.deepEqual(sent, []);
});

test('a request that expires tells the approver and its code stops working', async (t) => {
  const { fixture, host, sent, codeIn } = await setup(t);
  host.request('r1');
  await waitFor(() => sent.length === 1);
  const code = codeIn(sent[0][1]);
  host.expire('r1');
  await waitFor(() => sent.length === 2);
  assert.equal(sent[1][1], 'Ava: shell.run expired without an answer, denied.');
  fixture.received(APPROVER, { text: `Y ${code}`, body: null });
  await waitFor(() => host.dispatched.length === 1);
  assert.deepEqual(host.resolved, []);
});

test('a scheduled firing asks at the schedule destination when it is an approver', async (t) => {
  const { host, sent } = await setup(t);
  host.request('r1', { metadata: {}, scheduleDestination: { channel: 'imessage', to: OTHER_APPROVER } });
  await waitFor(() => sent.length === 1);
  assert.equal(sent[0][0], OTHER_APPROVER);
});

test('messages reach the gateway in the order they arrived, approval-shaped ones included', async (t) => {
  const { fixture, host, sent } = await setup(t);
  // Pending, but put to the other approver: a bare "no" from this one is a message.
  host.request('r1', { metadata: { channel: 'imessage', imessageTo: OTHER_APPROVER } });
  await waitFor(() => sent.length === 1);
  fixture.received(APPROVER, { text: 'no', body: null });
  fixture.received(APPROVER, { text: 'second', body: null });
  fixture.received(APPROVER, { text: 'third', body: null });
  await waitFor(() => host.dispatched.length === 3);
  assert.deepEqual(host.dispatched.map((input) => input.userMessage), ['no', 'second', 'third']);
});
