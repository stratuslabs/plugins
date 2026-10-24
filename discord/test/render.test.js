import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderer, NO_REPLY_TEXT } from '../lib/render.js';

/**
 * A hand-cranked clock and a recording Discord: the renderer's timers run
 * only when the test advances time, and every post, edit and delete lands
 * in `calls` in order.
 */
const harness = ({ intervalMs = 1000, failEdits = false } = {}) => {
  let clock = 0;
  let timers = [];
  let nextTimer = 1;
  const calls = [];
  const messages = new Map();
  let nextId = 1;
  const ops = {
    async post(text) {
      const id = `m${nextId++}`;
      messages.set(id, text);
      calls.push(['post', id, text]);
      return id;
    },
    async edit(id, text) {
      if (failEdits) throw new Error('edit refused');
      messages.set(id, text);
      calls.push(['edit', id, text]);
    },
    async remove(id) {
      messages.delete(id);
      calls.push(['remove', id]);
    },
    async typing() {
      calls.push(['typing']);
    },
  };
  const fakeTimers = {
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.push({ id, at: clock + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers = timers.filter((timer) => timer.id !== id);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const advance = async (ms) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > until) break;
      timers.shift();
      clock = due.at;
      due.fn();
      await settle();
    }
    clock = until;
    await settle();
  };
  const warnings = [];
  const renderer = createRenderer({ ops, intervalMs, typingEveryMs: 8000, timers: fakeTimers, now: () => clock, warn: (line) => warnings.push(line) });
  const visible = () => [...messages.values()];
  return { renderer, calls, visible, advance, settle, warnings };
};

const text = (value) => ({ type: 'provider.delta', sessionId: 's', delta: { type: 'text', text: value } });
const response = (value = '') => ({ type: 'provider.response', sessionId: 's', parts: value ? [{ type: 'text', text: value }] : [] });
const called = (toolName) => ({ type: 'tool.called', sessionId: 's', call: { id: 'c1', toolName, input: {} } });
const completed = () => ({ type: 'tool.completed', sessionId: 's', result: { callId: 'c1', ok: true, output: {} } });

test('streamed text posts once, then edits at most once per interval however many deltas arrive', async () => {
  const { renderer, calls, advance, settle } = harness({ intervalMs: 1000 });
  renderer.onEvent(text('Hel'));
  await settle();
  assert.deepEqual(calls, [['post', 'm1', 'Hel']], 'the first words post at once');
  for (const piece of ['lo', ',', ' wor', 'ld']) {
    renderer.onEvent(text(piece));
    await advance(100);
  }
  assert.equal(calls.filter(([op]) => op === 'edit').length, 0, 'nothing edits inside the interval');
  await advance(600);
  assert.deepEqual(calls.at(-1), ['edit', 'm1', 'Hello, world'], 'one edit carries everything that arrived');
  renderer.onEvent(text('!'));
  await advance(500);
  assert.equal(calls.filter(([op]) => op === 'edit').length, 1, 'still inside the next interval');
  await advance(500);
  assert.deepEqual(calls.at(-1), ['edit', 'm1', 'Hello, world!']);
  assert.equal(calls.filter(([op]) => op === 'edit').length, 2);
});

test('a final reply replaces the streamed words at once and cancels the pending edit', async () => {
  const { renderer, calls, visible, advance, settle } = harness();
  renderer.onEvent(text('draft'));
  await settle();
  renderer.onEvent(text(' more'));
  const outcome = await renderer.finalize('The answer.');
  assert.equal(outcome.spoke, true);
  assert.deepEqual(visible(), ['The answer.']);
  await advance(5000);
  assert.deepEqual(calls.at(-1), ['edit', 'm1', 'The answer.'], 'no stale edit lands after the final one');
});

test('a reply over 2000 characters becomes more messages, and the earlier ones stop changing', async () => {
  const { renderer, calls, visible, advance, settle } = harness();
  const line = 'x'.repeat(99);
  renderer.onEvent(text(Array(15).fill(line).join('\n')));
  await settle();
  renderer.onEvent(text('\n' + Array(15).fill(line).join('\n')));
  await advance(1000);
  assert.equal(visible().length, 2, 'split across two messages');
  assert.ok(visible().every((piece) => piece.length <= 2000));
  const editsOfFirst = calls.filter(([op, id]) => op === 'edit' && id === 'm1').length;
  renderer.onEvent(text(' tail'));
  await advance(1000);
  assert.equal(calls.filter(([op, id]) => op === 'edit' && id === 'm1').length, editsOfFirst, 'the full first message is left alone');
  assert.ok(visible()[1].endsWith(' tail'));
});

test('a tool call shows a status line, and words before it stay as their own message', async () => {
  const { renderer, visible, advance, settle } = harness();
  renderer.onEvent(text("I'll check."));
  await settle();
  renderer.onEvent(response("I'll check."));
  renderer.onEvent(called('web.fetch'));
  await advance(1000);
  assert.deepEqual(visible(), ["I'll check.", '-# ⚙ web.fetch…']);
  renderer.onEvent(completed());
  renderer.onEvent(text('It is sunny.'));
  await advance(1000);
  assert.deepEqual(visible(), ["I'll check.", 'It is sunny.'], 'the status line becomes the next answer');
  await renderer.finalize('It is sunny.');
  assert.deepEqual(visible(), ["I'll check.", 'It is sunny.']);
});

test('a reply that is the words already shown before a tool is not posted twice', async () => {
  const { renderer, visible, advance, settle } = harness();
  renderer.onEvent(text('Done, see above.'));
  await settle();
  renderer.onEvent(response('Done, see above.'));
  renderer.onEvent(called('fs.write'));
  await advance(1000);
  renderer.onEvent(completed());
  renderer.onEvent(response(''));
  await renderer.finalize('Done, see above.');
  assert.deepEqual(visible(), ['Done, see above.'], 'the empty status message is removed, not left or filled with a copy');
});

test('a reset discards the abandoned attempt instead of fusing two attempts', async () => {
  const { renderer, visible, advance, settle } = harness();
  renderer.onEvent(text('first attempt that bro'));
  await settle();
  renderer.onEvent({ type: 'provider.delta', sessionId: 's', delta: { type: 'reset', reason: 'fallback' } });
  renderer.onEvent(text('Second attempt.'));
  await advance(1000);
  assert.deepEqual(visible(), ['Second attempt.']);
});

test('a provider that answers in one piece still shows its words before a tool', async () => {
  const { renderer, visible, advance } = harness();
  renderer.onEvent(response('Looking it up.'));
  renderer.onEvent(called('web.search'));
  await advance(1000);
  assert.deepEqual(visible(), ['Looking it up.', '-# ⚙ web.search…']);
});

test('a turn that says nothing says (no reply); a failure is shown after what was said', async () => {
  {
    const { renderer, visible } = harness();
    await renderer.finalize('');
    assert.deepEqual(visible(), [NO_REPLY_TEXT]);
  }
  {
    const { renderer, visible, settle } = harness();
    renderer.onEvent(text('Partial'));
    await settle();
    await renderer.fail('The provider timed out.');
    assert.deepEqual(visible(), ['Partial\n\n⚠ The provider timed out.']);
  }
});

test('withdraw takes down everything it posted and says nothing', async () => {
  const { renderer, visible, advance, settle } = harness();
  renderer.onEvent(text('about to be absorbed'));
  await settle();
  renderer.onEvent(called('x'));
  await advance(1000);
  await renderer.withdraw();
  assert.deepEqual(visible(), []);
});

test('typing shows while a turn runs and stops when it ends', async () => {
  const { renderer, calls, advance } = harness();
  renderer.beginTurn();
  await advance(0);
  assert.equal(calls.filter(([op]) => op === 'typing').length, 1);
  await advance(16000);
  assert.equal(calls.filter(([op]) => op === 'typing').length, 3, 'refreshed every 8s');
  await renderer.finalize('ok');
  await advance(30000);
  assert.equal(calls.filter(([op]) => op === 'typing').length, 3, 'none after the reply');
});

test('a Discord error on an edit is logged, not thrown into the event stream', async () => {
  const { renderer, warnings, advance, settle } = harness({ failEdits: true });
  renderer.onEvent(text('a'));
  await settle();
  renderer.onEvent(text('b'));
  await advance(1000);
  assert.match(warnings.join('\n'), /edit refused/);
  const outcome = await renderer.finalize('ab');
  assert.equal(outcome.spoke, true, 'the first post landed, so it spoke');
});
