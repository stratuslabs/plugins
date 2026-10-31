import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderer, NO_REPLY_TEXT } from '../lib/render.js';

/**
 * A hand-cranked clock and a recording Discord: the renderer's timers run
 * only when the test advances time, and every post, edit and delete lands
 * in `calls` in order.
 */
const harness = ({ intervalMs = 1000, failEdits = false, failUploads = false } = {}) => {
  let clock = 0;
  let timers = [];
  let nextTimer = 1;
  const calls = [];
  const messages = new Map();
  let nextId = 1;
  let editsFail = failEdits;
  let removesFail = false;
  const ops = {
    async post(text) {
      const id = `m${nextId++}`;
      messages.set(id, text);
      calls.push(['post', id, text]);
      return id;
    },
    async edit(id, text) {
      if (editsFail) throw new Error('edit refused');
      messages.set(id, text);
      calls.push(['edit', id, text]);
    },
    async remove(id) {
      if (removesFail) throw new Error('delete refused');
      messages.delete(id);
      calls.push(['remove', id]);
    },
    async typing() {
      calls.push(['typing']);
    },
    async upload(filePath) {
      if (failUploads) throw new Error('upload refused');
      const id = `m${nextId++}`;
      messages.set(id, `[file ${filePath}]`);
      calls.push(['upload', id, filePath]);
      return id;
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
  const setFailEdits = (value) => {
    editsFail = value;
  };
  const setFailRemoves = (value) => {
    removesFail = value;
  };
  return { renderer, calls, visible, advance, settle, warnings, setFailEdits, setFailRemoves };
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

const produced = (output, ok = true) => ({ type: 'tool.completed', sessionId: 's', result: { callId: 'c1', ok, output } });

test('a file a tool produced is posted in its place: below the words before it, above the words after', async () => {
  const { renderer, visible, calls, advance, settle } = harness();
  renderer.onEvent(text('Making the chart.'));
  await settle();
  renderer.onEvent(response('Making the chart.'));
  renderer.onEvent(called('chart.render'));
  await advance(1000);
  renderer.onEvent(produced({ file: '/w/chart.png', files: ['/w/data.csv'] }));
  await settle();
  renderer.onEvent(text('Here it is.'));
  await advance(1000);
  await renderer.finalize('Here it is.');
  assert.deepEqual(visible(), ['Making the chart.', '[file /w/chart.png]', '[file /w/data.csv]', 'Here it is.']);
  assert.deepEqual(calls.filter(([kind]) => kind === 'upload').map(([, , file]) => file), ['/w/chart.png', '/w/data.csv']);
});

test('words after a file stay below it when they arrive while an earlier post is still underway', async () => {
  const shown = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let nextId = 1;
  const renderer = createRenderer({
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    ops: {
      async post(piece) {
        if (nextId === 1) await blocked;
        shown.push(piece);
        return `m${nextId++}`;
      },
      async edit() {},
      async remove() {},
      async typing() {},
      async upload(filePath) {
        shown.push(`[file ${filePath}]`);
        return `m${nextId++}`;
      },
    },
  });
  renderer.onEvent(text('Making the chart.'));
  renderer.onEvent(response('Making the chart.'));
  renderer.onEvent(called('chart.render'));
  renderer.onEvent(produced({ file: '/w/chart.png' }));
  // The next response streams in while Discord still holds the first post.
  renderer.onEvent(text('Here it is.'));
  const finished = renderer.finalize('Here it is.');
  release();
  await finished;
  assert.deepEqual(shown, ['Making the chart.', '[file /w/chart.png]', 'Here it is.']);
});

test('a tool that finishes while its status line is being posted has the status taken down before its file goes up', async () => {
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let nextId = 1;
  const renderer = createRenderer({
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    ops: {
      async post(piece) {
        const id = `m${nextId++}`;
        if (id === 'm1') await blocked;
        calls.push(['post', id, piece]);
        return id;
      },
      async edit(id, piece) {
        calls.push(['edit', id, piece]);
      },
      async remove(id) {
        calls.push(['remove', id]);
      },
      async typing() {},
      async upload(filePath) {
        const id = `m${nextId++}`;
        calls.push(['upload', id, filePath]);
        return id;
      },
    },
  });
  renderer.onEvent(called('chart.render'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextId, 2, 'the status line\'s post is underway');
  // Discord holds that post while the tool finishes and the reply streams in.
  renderer.onEvent(produced({ file: '/w/chart.png' }));
  renderer.onEvent(text('Here it is.'));
  const finished = renderer.finalize('Here it is.');
  release();
  await finished;
  assert.deepEqual(calls, [
    ['post', 'm1', '-# ⚙ chart.render…'],
    ['remove', 'm1'],
    ['upload', 'm2', '/w/chart.png'],
    ['post', 'm3', 'Here it is.'],
  ]);
});

test('a reply that is the words before a tool that made a file is not posted again under the file', async () => {
  const { renderer, visible, settle } = harness();
  renderer.onEvent(text('Here is the chart.'));
  await settle();
  renderer.onEvent(response('Here is the chart.'));
  renderer.onEvent(called('chart.render'));
  renderer.onEvent(produced({ file: '/w/chart.png' }));
  renderer.onEvent(response(''));
  await renderer.finalize('Here is the chart.');
  assert.deepEqual(visible(), ['Here is the chart.', '[file /w/chart.png]']);
});

test('a failed tool, or a result naming no file, uploads nothing', async () => {
  const { renderer, calls, settle } = harness();
  renderer.onEvent(called('x'));
  renderer.onEvent(produced({ file: '/w/a.png' }, false));
  renderer.onEvent(called('y'));
  renderer.onEvent(produced({ text: 'no file' }));
  renderer.onEvent(called('z'));
  renderer.onEvent({ type: 'tool.denied', sessionId: 's', call: { id: 'c3', toolName: 'z' }, result: { ok: true, output: { file: '/w/b.png' } } });
  await settle();
  await renderer.finalize('done');
  assert.equal(calls.filter(([kind]) => kind === 'upload').length, 0);
});

test('a file alone is something said: no (no reply) after it', async () => {
  const { renderer, visible, settle } = harness();
  renderer.onEvent(called('shot'));
  renderer.onEvent(produced({ file: '/w/shot.png' }));
  await settle();
  const { spoke } = await renderer.finalize('');
  assert.deepEqual(visible(), ['[file /w/shot.png]']);
  assert.equal(spoke, true);
});

test('a failed upload is logged and the turn goes on', async () => {
  const { renderer, visible, warnings, settle } = harness({ failUploads: true });
  renderer.onEvent(called('shot'));
  renderer.onEvent(produced({ file: '/w/shot.png' }));
  await settle();
  await renderer.finalize('Done.');
  assert.deepEqual(visible(), ['Done.']);
  assert.match(warnings.join('\n'), /could not upload shot\.png: upload refused/);
});

test('an edit Discord refused is tried again, so the reply that lands is the whole one', async () => {
  const { renderer, visible, advance, settle, setFailEdits } = harness();
  renderer.onEvent(text('a'));
  await settle();
  setFailEdits(true);
  renderer.onEvent(text('b'));
  await advance(1000);
  setFailEdits(false);
  await renderer.finalize('ab');
  assert.deepEqual(visible(), ['ab'], 'the failed edit is not counted as shown');
});

test('a message Discord would not delete is still tracked, so it is reused rather than left behind', async () => {
  const { renderer, visible, advance, settle, setFailRemoves } = harness();
  renderer.onEvent(called('search'));
  await settle();
  assert.deepEqual(visible(), ['-# ⚙ search…']);
  setFailRemoves(true);
  renderer.onEvent(completed());
  await advance(1000);
  setFailRemoves(false);
  renderer.onEvent(text('done'));
  await renderer.finalize('done');
  assert.deepEqual(visible(), ['done'], 'the status line is not left up beside the reply');
});

test('after a reset, a provider that answers in one piece still has its words before a tool shown', async () => {
  const { renderer, visible, settle } = harness();
  renderer.onEvent(text('abandoned attempt'));
  await settle();
  renderer.onEvent({ type: 'provider.delta', sessionId: 's', delta: { type: 'reset' } });
  renderer.onEvent(response('Looking that up.'));
  renderer.onEvent(called('search'));
  renderer.onEvent(completed());
  await renderer.finalize('Found it.');
  assert.deepEqual(visible(), ['Looking that up.', 'Found it.']);
});

test('once halted, a reply, a failure, a stop or a withdraw that comes later sends nothing', async () => {
  for (const [what, end] of [
    ['finalize', (renderer) => renderer.finalize('The late answer.')],
    ['fail', (renderer) => renderer.fail('it broke')],
    ['stopped', (renderer) => renderer.stopped('Dylan')],
    ['withdraw', (renderer) => renderer.withdraw()],
  ]) {
    const { renderer, calls, visible, advance, settle } = harness();
    renderer.beginTurn();
    renderer.onEvent(text('partial'));
    await settle();
    renderer.halt();
    const before = calls.length;
    await end(renderer);
    await advance(30000);
    assert.equal(calls.length, before, `${what} after a halt makes no Discord call`);
    assert.deepEqual(visible(), ['partial'], `${what}: what was up stays as it was`);
  }
});

test('a halt while a sync is underway stops the requests it had left', async () => {
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let nextId = 1;
  const renderer = createRenderer({
    ops: {
      async post(piece) {
        calls.push(['post', piece.length]);
        if (calls.length === 1) await blocked;
        return `m${nextId++}`;
      },
      async edit(id) {
        calls.push(['edit', id]);
      },
      async remove(id) {
        calls.push(['remove', id]);
      },
      async typing() {},
    },
  });
  // Three messages' worth: the first post hangs, and the halt lands under it.
  const finished = renderer.finalize('x'.repeat(5000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'the first post is underway');
  renderer.halt();
  release();
  await finished;
  assert.deepEqual(calls, [['post', 2000]], 'nothing after the halt');
});
