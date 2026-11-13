import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HostRefusalError } from '@stratusagent/core';

import {
  BudgetExceededError,
  budgetWindow,
  findBreach,
  parseBudgetConfig,
  weightedTokens,
} from '../budget.js';

describe('parseBudgetConfig', () => {
  it('reads the install total, the per-agent default and each agent\'s own limits', () => {
    const budget = parseBudgetConfig({
      home: { daily: 1000, monthly: 20000 },
      daily: 300,
      agents: { Scout: { daily: 50, monthly: 900 } },
      weights: { cacheReadTokens: 0.1 },
      reservePerCall: 10,
    });
    assert.deepEqual(budget.home, { daily: 1000, monthly: 20000 });
    assert.deepEqual(budget.limitsFor('scout'), { key: 'Scout', daily: 50, monthly: 900 });
    assert.deepEqual(budget.limitsFor('ava'), { daily: 300 });
    assert.deepEqual(budget.weights, { cacheReadTokens: 0.1 });
    assert.equal(budget.reservePerCall, 10);
  });

  it('an agent\'s own entry replaces the default key by key, the way every plugin\'s agents block does', () => {
    const budget = parseBudgetConfig({ daily: 300, monthly: 5000, agents: { scout: { daily: 50 } } });
    assert.deepEqual(budget.limitsFor('scout'), { key: 'scout', daily: 50, monthly: 5000 });
  });

  it('has a default reserve, and no limit at all is a ledger that refuses nothing', () => {
    const budget = parseBudgetConfig({});
    assert.equal(budget.reservePerCall, 50000);
    assert.equal(budget.limited('ava'), false);
    assert.equal(parseBudgetConfig({ home: { daily: 5 } }).limited('ava'), true);
    assert.equal(parseBudgetConfig({ agents: { scout: { daily: 5 } } }).limited('ava'), false);
    assert.equal(parseBudgetConfig({ agents: { scout: { daily: 5 } } }).limited('Scout'), true);
  });

  for (const [what, config, pattern] of [
    ['a zero limit', { daily: 0 }, /daily.*whole number/],
    ['a fractional limit', { home: { monthly: 1.5 } }, /home\.monthly.*whole number/],
    ['a string limit', { agents: { scout: { daily: '5' } } }, /agents\.scout\.daily/],
    ['a misspelled key', { home: { montly: 5 } }, /home.*"montly"/],
    ['a negative weight', { weights: { outputTokens: -1 } }, /weights\.outputTokens/],
    ['an unknown bucket', { weights: { tokens: 1 } }, /weights.*"tokens"/],
    ['a negative reserve', { reservePerCall: -1 }, /reservePerCall/],
    ['an install total inside one agent', { agents: { scout: { home: { daily: 5 } } } }, /agents\.scout.*home/],
    ['weights inside one agent', { agents: { scout: { weights: { inputTokens: 1 } } } }, /agents\.scout.*weights/],
    ['two spellings of one agent', { agents: { scout: { daily: 1 }, Scout: { daily: 2 } } }, /same agent/],
  ]) {
    it(`refuses ${what} rather than running uncapped`, () => {
      assert.throws(() => parseBudgetConfig(config), pattern);
    });
  }
});

describe('weightedTokens', () => {
  it('weighs each bucket, counts an unnamed bucket once and an unreported one not at all', () => {
    assert.equal(weightedTokens({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 }, { cacheReadTokens: 0.1, outputTokens: 5 }), 250);
    assert.equal(weightedTokens({}, {}), 0);
  });
});

describe('budgetWindow', () => {
  it('is the UTC day and the UTC calendar month', () => {
    const now = new Date('2026-12-31T23:30:00-05:00');
    assert.deepEqual(budgetWindow('daily', now), { start: '2027-01-01T00:00:00.000Z', resetsAt: '2027-01-02T00:00:00.000Z' });
    assert.deepEqual(budgetWindow('monthly', now), { start: '2027-01-01T00:00:00.000Z', resetsAt: '2027-02-01T00:00:00.000Z' });
  });
});

describe('findBreach', () => {
  const now = new Date('2026-10-27T03:00:00Z');

  it('refuses at or past a limit, checks the install before the agent, and says what to raise', () => {
    const budget = parseBudgetConfig({ home: { daily: 1000 }, agents: { Scout: { daily: 100 } } });
    const spent = { home: 0, agent: 100 };
    const spend = (since, agentId) => (agentId === undefined ? spent.home : spent.agent);
    let breach = findBreach(budget, 'scout', spend, now);
    assert.equal(breach.scope, 'agent');
    const error = new BudgetExceededError(breach);
    assert.ok(error instanceof HostRefusalError);
    assert.equal(
      error.message,
      'Agent scout has used its daily model budget (100 of 100 weighted tokens), so its model is not being called again until the budget resets at 2026-10-28 00:00 UTC. '
        + 'To continue sooner, the operator can raise plugins["@stratusagent/plugin-budgets"].agents.Scout.daily in the trusted config.',
    );
    spent.home = 1000;
    breach = findBreach(budget, 'scout', spend, now);
    assert.equal(breach.scope, 'home');
    assert.match(new BudgetExceededError(breach).message, /^This Stratus install has used its daily model budget \(1,000 of 1,000 .*plugin-budgets"\]\.home\.daily in/);
    spent.home = 999;
    spent.agent = 99;
    assert.equal(findBreach(budget, 'scout', spend, now), undefined);
  });

  it('names the shared per-agent default when that is the limit that ran out', () => {
    const budget = parseBudgetConfig({ monthly: 10 });
    const breach = findBreach(budget, 'ava', () => 10, now);
    assert.match(new BudgetExceededError(breach).message, /monthly model budget .*resets at 2026-11-01 00:00 UTC.*plugin-budgets"\]\.monthly in/);
  });

  it('asks for the window the limit covers, and for the agent only on its own limit', () => {
    const budget = parseBudgetConfig({ home: { monthly: 10 }, daily: 5 });
    const asked = [];
    findBreach(budget, 'ava', (since, agentId) => { asked.push([since, agentId]); return 0; }, now);
    assert.deepEqual(asked, [['2026-10-01T00:00:00.000Z', undefined], ['2026-10-27T00:00:00.000Z', 'ava']]);
  });
});
