import test from 'node:test';
import assert from 'node:assert/strict';

import { readRunInput, streamSession } from '../index.js';

const fakeBus = () => {
  const handlers = [];
  return {
    subscribe(handler) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    emit(event) {
      for (const handler of [...handlers]) handler(event);
    },
    get count() {
      return handlers.length;
    },
  };
};

test('a RunAgentInput is read for its thread, run, and newest user text', () => {
  const run = readRunInput(JSON.stringify({
    threadId: 't-1',
    runId: 'r-1',
    messages: [
      { id: 'm1', role: 'user', content: 'old question' },
      { id: 'm2', role: 'assistant', content: 'old answer' },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: 'new' }, { type: 'image', url: 'x' }, { type: 'text', text: 'question' }] },
    ],
    tools: [],
    context: [],
  }));
  assert.deepEqual(run, { threadId: 't-1', runId: 'r-1', text: 'new\nquestion' });
  assert.throws(() => readRunInput('{'), /not JSON/);
  assert.throws(() => readRunInput(JSON.stringify({ runId: 'r', messages: [] })), /threadId and runId/);
  assert.throws(() => readRunInput(JSON.stringify({ threadId: '../x', runId: 'r', messages: [{ role: 'user', content: 'a' }] })), /threadId/);
  assert.throws(() => readRunInput(JSON.stringify({ threadId: 't', runId: 'r', messages: [{ role: 'assistant', content: 'a' }] })), /user message/);
});

test('streamed text, a tool call and its result map to AG-UI events, for this session only', () => {
  const bus = fakeBus();
  const events = [];
  const stream = streamSession(bus, 's-1', (event) => events.push(event));
  bus.emit({ type: 'provider.delta', sessionId: 's-1', delta: { type: 'text', text: 'Looking' } });
  bus.emit({ type: 'provider.delta', sessionId: 'other', delta: { type: 'text', text: 'not mine' } });
  bus.emit({ type: 'provider.delta', sessionId: 's-1', delta: { type: 'text', text: ' it up.' } });
  bus.emit({ type: 'provider.response', sessionId: 's-1', parts: [{ type: 'text', text: 'Looking it up.' }] });
  bus.emit({ type: 'tool.called', sessionId: 's-1', call: { id: 'c1', toolName: 'web.fetch', input: { url: 'https://example.com' } } });
  bus.emit({ type: 'tool.completed', sessionId: 's-1', result: { callId: 'c1', ok: true, output: 'page' } });
  // A provider that does not stream: the whole text at the response.
  bus.emit({ type: 'provider.response', sessionId: 's-1', parts: [{ type: 'text', text: 'Done.' }] });
  stream.unsubscribe();
  bus.emit({ type: 'provider.delta', sessionId: 's-1', delta: { type: 'text', text: 'after' } });

  const shape = events.map((event) => [event.type, event.delta ?? event.toolCallName ?? event.content ?? '']);
  assert.deepEqual(shape, [
    ['TEXT_MESSAGE_START', ''],
    ['TEXT_MESSAGE_CONTENT', 'Looking'],
    ['TEXT_MESSAGE_CONTENT', ' it up.'],
    ['TEXT_MESSAGE_END', ''],
    ['TOOL_CALL_START', 'web.fetch'],
    ['TOOL_CALL_ARGS', '{"url":"https://example.com"}'],
    ['TOOL_CALL_END', ''],
    ['TOOL_CALL_RESULT', '"page"'],
    ['TEXT_MESSAGE_START', ''],
    ['TEXT_MESSAGE_CONTENT', 'Done.'],
    ['TEXT_MESSAGE_END', ''],
  ]);
  // One message id per text message, carried by its start, content and end.
  assert.equal(events[0].messageId, events[3].messageId);
  assert.notEqual(events[0].messageId, events[8].messageId);
  assert.equal(events[4].toolCallId, 'c1');
  assert.equal(events[7].toolCallId, 'c1');
  assert.equal(bus.count, 0);
});

test('a non-streamed reply with several text parts is one AG-UI message per part, as Stratus stores it', () => {
  const bus = fakeBus();
  const events = [];
  const stream = streamSession(bus, 's-1', (event) => events.push(event));
  bus.emit({ type: 'provider.response', sessionId: 's-1', parts: [{ type: 'text', text: 'First.' }, { type: 'text', text: 'Second.' }] });
  stream.unsubscribe();
  const shape = events.map((event) => [event.type, event.delta ?? '']);
  assert.deepEqual(shape, [
    ['TEXT_MESSAGE_START', ''],
    ['TEXT_MESSAGE_CONTENT', 'First.'],
    ['TEXT_MESSAGE_END', ''],
    ['TEXT_MESSAGE_START', ''],
    ['TEXT_MESSAGE_CONTENT', 'Second.'],
    ['TEXT_MESSAGE_END', ''],
  ]);
  assert.notEqual(events[0].messageId, events[3].messageId);
});

import { createAguiAdapter } from '../index.js';

/** A gateway whose one turn asks to run `shell.run`, then finishes. */
const parkingGateway = () => {
  const bus = fakeBus();
  const pending = new Map();
  const resolved = [];
  return {
    bus,
    resolved,
    pendingCount: () => pending.size,
    async dispatch({ sessionId, signal }) {
      const call = { id: 'c1', toolName: 'shell.run', input: { command: 'ls' } };
      const answer = await new Promise((resolve) => {
        pending.set('req-1', resolve);
        signal.addEventListener('abort', () => resolve('deny'));
        bus.emit({ type: 'tool.approval-requested', sessionId, agentId: 'a', requestId: 'req-1', call, risk: 'high', expiresAt: '2026-10-16T08:00:00.000Z' });
      });
      bus.emit({ type: 'tool.approval-resolved', sessionId, requestId: 'req-1', answer, reason: 'decided' });
      if (answer === 'deny') {
        bus.emit({ type: 'tool.denied', sessionId, call });
      } else {
        bus.emit({ type: 'tool.called', sessionId, call });
        bus.emit({ type: 'tool.completed', sessionId, result: { callId: 'c1', ok: true, output: 'a b' } });
      }
      bus.emit({ type: 'provider.response', sessionId, parts: [{ type: 'text', text: answer === 'deny' ? 'Not run.' : 'Ran it.' }] });
      return { status: 'completed' };
    },
    resolveApproval({ requestId, answer }) {
      const resolve = pending.get(requestId);
      pending.delete(requestId);
      resolved.push([requestId, answer]);
      resolve?.(answer);
      return Boolean(resolve);
    },
  };
};

const post = async (adapter, body) => {
  const res = await fetch(`http://127.0.0.1:${adapter.port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.headers.get('content-type') !== 'text/event-stream') {
    return { status: res.status, body: JSON.parse(text) };
  }
  return { status: res.status, events: text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, ''))) };
};

for (const [label, entry, expectRun] of [
  ['approved', { interruptId: 'req-1', status: 'resolved', payload: { answer: 'once' } }, true],
  ['cancelled', { interruptId: 'req-1', status: 'cancelled' }, false],
]) {
  test(`a gated call ends the run with an interrupt, and a resume (${label}) continues the same turn`, async () => {
    const gateway = parkingGateway();
    const adapter = createAguiAdapter({ agent: 'a', port: 0 });
    await adapter.start(gateway);
    try {
      const first = await post(adapter, { threadId: 't', runId: 'r1', messages: [{ id: 'm', role: 'user', content: 'list files' }] });
      assert.deepEqual(first.events.map((event) => event.type), ['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'RUN_FINISHED']);
      const outcome = first.events.at(-1).outcome;
      assert.equal(outcome.type, 'interrupt');
      assert.deepEqual(outcome.interrupts.map((interrupt) => [interrupt.id, interrupt.reason, interrupt.toolCallId, interrupt.expiresAt]), [['req-1', 'tool_approval', 'c1', '2026-10-16T08:00:00.000Z']]);
      // The client hanging up after an interrupt did not cancel the turn.
      assert.equal(gateway.pendingCount(), 1);

      // A new message while the thread waits is refused, not queued.
      const busy = await post(adapter, { threadId: 't', runId: 'r2', messages: [{ id: 'm2', role: 'user', content: 'again' }] });
      assert.equal(busy.status, 409);
      // So is an answer to an interrupt that is not pending.
      const wrong = await post(adapter, { threadId: 't', runId: 'r2', resume: [{ interruptId: 'nope', status: 'cancelled' }] });
      assert.equal(wrong.status, 409);
      assert.deepEqual(gateway.resolved, []);

      const second = await post(adapter, { threadId: 't', runId: 'r3', resume: [entry] });
      assert.deepEqual(gateway.resolved, [['req-1', expectRun ? 'once' : 'deny']]);
      const types = second.events.map((event) => event.type);
      // The call was shown with the interrupt, so it is not started twice.
      assert.deepEqual(types, ['RUN_STARTED', 'TOOL_CALL_RESULT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
      assert.equal(second.events[1].toolCallId, 'c1');
      assert.equal(second.events[1].content, expectRun ? '"a b"' : '{"error":"denied"}');
      assert.deepEqual([second.events.at(-1).runId, second.events.at(-1).outcome], ['r3', { type: 'success' }]);

      // The turn is over, so the thread takes a new message again.
      const again = await post(adapter, { threadId: 't', runId: 'r4', resume: [entry] });
      assert.equal(again.status, 409);
    } finally {
      await adapter.stop();
    }
  });
}

test('a resume entry is read strictly: no answer is never a yes', () => {
  const base = { threadId: 't', runId: 'r' };
  assert.deepEqual(readRunInput(JSON.stringify({ ...base, resume: [{ interruptId: 'i', status: 'resolved', payload: { approved: true } }] })).resume, [{ interruptId: 'i', answer: 'once' }]);
  assert.deepEqual(readRunInput(JSON.stringify({ ...base, resume: [{ interruptId: 'i', status: 'resolved', payload: { answer: 'always' } }] })).resume, [{ interruptId: 'i', answer: 'always' }]);
  assert.throws(() => readRunInput(JSON.stringify({ ...base, resume: [{ interruptId: 'i', status: 'resolved' }] })), /payload.answer/);
  assert.throws(() => readRunInput(JSON.stringify({ ...base, resume: [{ interruptId: 'i', status: 'resolved', payload: { answer: 'yes' } }] })), /payload.answer/);
  assert.throws(() => readRunInput(JSON.stringify({ ...base, resume: [] })), /non-empty/);
  assert.throws(() => readRunInput(JSON.stringify({ ...base, resume: [{ status: 'cancelled' }] })), /interruptId/);
});
