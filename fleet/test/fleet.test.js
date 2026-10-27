import test from 'node:test';
import assert from 'node:assert/strict';

import { createFleetTools, createPlugin, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT } from '../index.js';

const NOW = Date.parse('2026-10-23T21:00:00.000Z');

/** A host fleet reader that records what it was asked. */
const fakeFleet = () => {
  const asked = [];
  const sessions = [
    { id: 's-3', agentId: 'ava', status: 'running', createdAt: '2026-10-23T18:00:00.000Z', updatedAt: '2026-10-23T18:30:00.000Z' },
    { id: 's-2', agentId: 'ben', status: 'failed', createdAt: '2026-10-23T17:00:00.000Z', updatedAt: '2026-10-23T17:10:00.000Z' },
    { id: 's-1', agentId: 'ava', status: 'completed', createdAt: '2026-10-23T16:00:00.000Z', updatedAt: '2026-10-23T16:05:00.000Z' },
  ];
  return {
    asked,
    async agents() {
      asked.push(['agents']);
      return [
        { id: 'ava', name: 'Ava', lastActiveAt: '2026-10-23T18:30:00.000Z', activeSessions: 1 },
        { id: 'ben', name: 'Ben', activeSessions: 0 },
      ];
    },
    async sessions(options) {
      asked.push(['sessions', options]);
      const rows = sessions.filter((row) => options?.agentId === undefined || row.agentId === options.agentId);
      return options?.limit === undefined ? rows : rows.slice(0, options.limit);
    },
    async countByStatus() {
      asked.push(['countByStatus']);
      return { running: 1, failed: 1, completed: 1 };
    },
    async schedules() {
      asked.push(['schedules']);
      return [{ id: 'sch-1', agentId: 'ava', cadence: 'every 2h', createdAt: '2026-10-20T00:00:00.000Z', lastFiredAt: '2026-10-23T20:00:00.000Z', lastSessionStatus: 'failed' }];
    },
    async pendingApprovals() {
      asked.push(['pendingApprovals']);
      return [{ requestId: 'r-1', agentId: 'ava', sessionId: 's-3', toolName: 'shell.run', risk: 'gated', parkedAt: '2026-10-23T20:15:00.000Z' }];
    },
  };
};

const toolsFor = (fleet) => Object.fromEntries(createFleetTools(fleet, { now: () => NOW }).map((tool) => [tool.name, tool]));

test('setup refuses a host with no fleet reader, naming what is missing, and registers four safe tools otherwise', () => {
  const registered = [];
  assert.throws(() => createPlugin().setup({ tools: { register: (tool) => registered.push(tool) } }), /PluginContext\.fleet/);
  assert.deepEqual(registered, []);
  createPlugin().setup({ tools: { register: (tool) => registered.push(tool) }, fleet: fakeFleet() });
  assert.deepEqual(registered.map((tool) => [tool.name, tool.risk]), [
    ['fleet.agents', 'safe'],
    ['fleet.sessions', 'safe'],
    ['fleet.schedules', 'safe'],
    ['fleet.approvals', 'safe'],
  ]);
});

test('fleet.agents returns the roster and the session counts', async () => {
  const output = await toolsFor(fakeFleet())['fleet.agents'].execute({});
  assert.deepEqual(output, {
    agents: [
      { id: 'ava', name: 'Ava', lastActiveAt: '2026-10-23T18:30:00.000Z', activeSessions: 1 },
      { id: 'ben', name: 'Ben', activeSessions: 0 },
    ],
    sessionsByStatus: { running: 1, failed: 1, completed: 1 },
  });
});

test('fleet.sessions is newest first with minutes since the last update, bounded by default', async () => {
  const fleet = fakeFleet();
  const output = await toolsFor(fleet)['fleet.sessions'].execute({});
  assert.deepEqual(output.sessions.map((row) => [row.id, row.status, row.minutesSinceUpdate]), [
    ['s-3', 'running', 150],
    ['s-2', 'failed', 230],
    ['s-1', 'completed', 295],
  ]);
  assert.deepEqual(fleet.asked, [['sessions', { limit: DEFAULT_SESSION_LIMIT }]]);
});

test('fleet.sessions filters by agent and status, and the limit applies after the status filter', async () => {
  const fleet = fakeFleet();
  const output = await toolsFor(fleet)['fleet.sessions'].execute({ agentId: 'ava', status: 'completed', limit: 1 });
  assert.deepEqual(output.sessions.map((row) => row.id), ['s-1']);
  assert.deepEqual(fleet.asked, [['sessions', { agentId: 'ava' }]], 'a status filter reads every row, then bounds');
});

test('fleet.sessions refuses a bad limit or status, naming the range', async () => {
  const tool = toolsFor(fakeFleet())['fleet.sessions'];
  await assert.rejects(tool.execute({ limit: 0 }), new RegExp(`1 to ${MAX_SESSION_LIMIT}`));
  await assert.rejects(tool.execute({ limit: MAX_SESSION_LIMIT + 1 }), new RegExp(`1 to ${MAX_SESSION_LIMIT}`));
  await assert.rejects(tool.execute({ limit: 2.5 }), /whole number/);
  await assert.rejects(tool.execute({ status: 'stuck' }), /idle, running, pending_approval, completed, failed/);
  await assert.rejects(tool.execute({ agentId: 7 }), /agentId/);
});

test('fleet.schedules passes the rows through', async () => {
  const output = await toolsFor(fakeFleet())['fleet.schedules'].execute({});
  assert.deepEqual(output.schedules.map((row) => [row.id, row.lastSessionStatus]), [['sch-1', 'failed']]);
});

test('fleet.approvals reports how long each call has waited', async () => {
  const output = await toolsFor(fakeFleet())['fleet.approvals'].execute({});
  assert.deepEqual(output.approvals, [
    { requestId: 'r-1', agentId: 'ava', sessionId: 's-3', toolName: 'shell.run', risk: 'gated', parkedAt: '2026-10-23T20:15:00.000Z', minutesWaiting: 45 },
  ]);
});

test('an unparseable timestamp leaves the minutes out rather than reporting NaN', async () => {
  const fleet = fakeFleet();
  fleet.pendingApprovals = async () => [{ requestId: 'r-2', agentId: 'ava', sessionId: 's', toolName: 'x', risk: 'gated', parkedAt: 'not a date' }];
  const output = await toolsFor(fleet)['fleet.approvals'].execute({});
  assert.equal('minutesWaiting' in output.approvals[0], false);
});
