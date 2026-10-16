import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlugin, createSpawnTool, DEFAULT_MAX_TASKS } from '../index.js';

const session = { id: 'parent-1', agent: { id: 'ava', name: 'Ava' } };

/** A host handle that records calls and answers each with `answer(input)`. */
const fakeSubAgents = (answer) => {
  const calls = [];
  return {
    calls,
    async run(input) {
      calls.push(input);
      return answer(input);
    },
  };
};

test('setup refuses a host that cannot run sub-agents, naming what is missing', () => {
  const registered = [];
  assert.throws(() => createPlugin().setup({ tools: { register: (tool) => registered.push(tool) } }), /PluginContext\.subAgents/);
  assert.deepEqual(registered, []);
  createPlugin().setup({ tools: { register: (tool) => registered.push(tool) }, subAgents: fakeSubAgents(() => ({})) });
  assert.deepEqual(registered.map((tool) => [tool.name, tool.risk]), [['agent.spawn', 'safe']]);
});

test('tasks start together, and each gets the parent session, its instruction, its tools, and the turn signal', async () => {
  let started = 0;
  let release;
  const allStarted = new Promise((resolve) => {
    release = resolve;
  });
  const subAgents = fakeSubAgents(async (input) => {
    started += 1;
    if (started === 3) {
      release();
    }
    await allStarted;
    return { status: 'result', text: `did ${input.instruction}`, sessionId: `s-${input.instruction}`, trust: 'agent' };
  });
  const controller = new AbortController();
  const tool = createSpawnTool(subAgents);
  const output = await tool.execute(
    { tasks: [{ instruction: 'a', tools: ['web.fetch'] }, { instruction: 'b' }, { instruction: ' c ' }] },
    session,
    { signal: controller.signal },
  );
  assert.deepEqual(output.results.map((result) => [result.status, result.answer]), [['result', 'did a'], ['result', 'did b'], ['result', 'did c']]);
  assert.deepEqual(subAgents.calls.map((call) => [call.parent, call.instruction, call.tools, call.signal]), [
    [session, 'a', ['web.fetch'], controller.signal],
    [session, 'b', [], controller.signal],
    [session, 'c', [], controller.signal],
  ]);
});

test('a refusal, a failure, and a quiet run sit beside the answers, in order', async () => {
  const subAgents = fakeSubAgents((input) => {
    if (input.instruction === 'refuse') {
      throw new Error('memory.remember is never given to a sub-agent, even by an agent that holds it.');
    }
    if (input.instruction === 'fail') {
      return { status: 'error', error: 'bad request', sessionId: 's-fail', trust: 'unknown' };
    }
    if (input.instruction === 'quiet') {
      return { status: 'empty', sessionId: 's-quiet', trust: 'agent' };
    }
    return { status: 'result', text: 'ok', sessionId: 's-ok', trust: 'agent' };
  });
  const output = await createSpawnTool(subAgents).execute(
    { tasks: [{ instruction: 'ok' }, { instruction: 'refuse' }, { instruction: 'fail' }, { instruction: 'quiet' }] },
    session,
  );
  assert.deepEqual(output.results, [
    { task: 1, status: 'result', answer: 'ok', sessionId: 's-ok' },
    { task: 2, status: 'refused', error: 'memory.remember is never given to a sub-agent, even by an agent that holds it.' },
    { task: 3, status: 'error', error: 'bad request', sessionId: 's-fail' },
    { task: 4, status: 'empty', sessionId: 's-quiet' },
  ]);
});

test('the call is marked at the least trusted label among the sub-agents that ran', async () => {
  const labels = { a: 'agent', b: 'external', c: 'unknown' };
  const marked = [];
  await createSpawnTool(fakeSubAgents((input) => ({ status: 'result', text: 'x', sessionId: input.instruction, trust: labels[input.instruction] })))
    .execute({ tasks: [{ instruction: 'a' }, { instruction: 'b' }, { instruction: 'c' }] }, session, { markTrust: (label) => marked.push(label) });
  assert.deepEqual(marked, ['external']);

  // Only refusals: nothing ran, nothing to mark.
  const none = [];
  await createSpawnTool(fakeSubAgents(() => {
    throw new Error('refused');
  })).execute({ tasks: [{ instruction: 'a' }] }, session, { markTrust: (label) => none.push(label) });
  assert.deepEqual(none, []);
});

test('the width cap refuses a call over it, naming the cap, before anything runs', async () => {
  const subAgents = fakeSubAgents(() => ({ status: 'result', text: 'x', sessionId: 's', trust: 'agent' }));
  const tooMany = Array.from({ length: DEFAULT_MAX_TASKS + 1 }, (_, index) => ({ instruction: `t${index}` }));
  await assert.rejects(() => createSpawnTool(subAgents).execute({ tasks: tooMany }, session), new RegExp(`at most ${DEFAULT_MAX_TASKS} tasks`));
  await assert.rejects(() => createSpawnTool(subAgents, { maxTasks: 2 }).execute({ tasks: tooMany.slice(0, 3) }, session), /at most 2 tasks/);
  await assert.rejects(() => createSpawnTool(subAgents).execute({ tasks: [] }, session), /needs "tasks"/);
  await assert.rejects(() => createSpawnTool(subAgents).execute({ tasks: [{ instruction: '  ' }] }, session), /task 1 has no instruction/);
  await assert.rejects(() => createSpawnTool(subAgents).execute({ tasks: [{ instruction: 'a', tools: 'web.fetch' }] }, session), /list of tool names/);
  assert.equal(subAgents.calls.length, 0);
  assert.throws(() => createSpawnTool(subAgents, { maxTasks: 0 }), /maxTasks/);
  assert.throws(() => createSpawnTool(subAgents, { maxTasks: 1000 }), /maxTasks/);
});

test('a cancelled turn ends the call instead of reporting on it', async () => {
  const controller = new AbortController();
  const subAgents = fakeSubAgents(async (input) => {
    controller.abort(new Error('turn cancelled'));
    throw input.signal.reason;
  });
  await assert.rejects(
    () => createSpawnTool(subAgents).execute({ tasks: [{ instruction: 'a' }, { instruction: 'b' }] }, session, { signal: controller.signal }),
    /turn cancelled/,
  );
});
