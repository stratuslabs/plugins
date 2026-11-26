import test from 'node:test';
import assert from 'node:assert/strict';

import { frontLine } from '../ui/lib/front.js';

test("an agent with a front names the front model and the provider it is on", () => {
  const agent = {
    id: 'ava',
    runsOn: { provider: 'anthropic', model: 'claude-opus-5' },
    front: { model: 'gpt-5.5-mini', provider: 'openai', tools: ['memory.recall'] },
  };
  assert.equal(frontLine(agent), 'Front: gpt-5.5-mini (on openai)');
});

test("a front with no provider is on the agent's own provider", () => {
  // GET /agents carries the soul's block as written; an omitted provider
  // means the agent's own, which is the one runsOn names.
  const agent = { id: 'ava', runsOn: { provider: 'anthropic', model: 'claude-opus-5' }, front: { model: 'claude-haiku-5-5' } };
  assert.equal(frontLine(agent), 'Front: claude-haiku-5-5 (on anthropic)');
});

test('a front whose provider nobody can name leaves the provider out', () => {
  // runsOn is absent when the daemon can't read the soul, and `none` when
  // no provider resolves: neither is a provider the front is on.
  assert.equal(frontLine({ id: 'ava', front: { model: 'claude-haiku-5-5' } }), 'Front: claude-haiku-5-5');
  assert.equal(frontLine({ id: 'ava', runsOn: { provider: 'none' }, front: { model: 'claude-haiku-5-5' } }), 'Front: claude-haiku-5-5');
});

test('an agent without a front shows nothing', () => {
  assert.equal(frontLine({ id: 'rex', runsOn: { provider: 'anthropic', model: 'claude-opus-5' } }), undefined);
  assert.equal(frontLine(undefined), undefined);
});

test('a front with no model to name shows nothing', () => {
  // The soul parser requires a model, so this is a daemon this page does
  // not understand; claiming a front it can't name would mislead.
  assert.equal(frontLine({ id: 'ava', front: {} }), undefined);
  assert.equal(frontLine({ id: 'ava', front: { model: '' } }), undefined);
  assert.equal(frontLine({ id: 'ava', front: { model: 7 } }), undefined);
});
