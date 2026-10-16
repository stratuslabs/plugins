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
