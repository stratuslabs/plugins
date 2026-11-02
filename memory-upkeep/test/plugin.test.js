import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EventBus } from '@stratusagent/core';

import { createPlugin } from '../index.js';

const passes = () => {
  const started = [];
  return {
    started,
    async start(agentId, mode) {
      started.push([agentId, mode]);
      return { startedAt: new Date().toISOString() };
    },
    async run() {
      return { passId: 'p', status: 'nothing-new', saved: 0, superseded: 0, more: false };
    },
  };
};

const fleet = { async sessions() { return []; } };

test('setup refuses a host with no memory pass seam or no fleet reader, naming what is missing', async () => {
  const bus = new EventBus();
  const plugin = createPlugin({ agents: { atlas: {} } });
  await assert.rejects(Promise.resolve().then(() => plugin.setup({ bus, fleet })), /PluginContext\.memoryPasses/);
  await assert.rejects(Promise.resolve().then(() => plugin.setup({ bus, memoryPasses: passes() })), /PluginContext\.fleet/);
});

test('with no agent listed it loads, says so, and asks nothing, even on a host with no seams', async () => {
  const lines = [];
  const plugin = createPlugin({});
  await plugin.setup({ bus: new EventBus(), log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes('no agents')));
  await plugin.dispose();
});

test('setup starts every listed agent, and dispose stops listening', async () => {
  const bus = new EventBus();
  const handle = passes();
  const plugin = createPlugin({ mode: 'write', agents: { atlas: {}, blair: { mode: 'shadow' } } });
  await plugin.setup({ bus, memoryPasses: handle, fleet, log() {}, warn() {} });
  assert.deepEqual(handle.started, [['atlas', 'write'], ['blair', 'shadow']]);
  await plugin.dispose();
});

test('a config the plugin cannot use is refused when the plugin is created, before setup', () => {
  assert.throws(() => createPlugin({ agents: { atlas: { tidy: { window: 'nightly' } } } }), /agents\.atlas\.tidy\.window/);
});

test('the manifest names the plugin, its core range, and a config schema the loader can check', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@stratusagent/memory-upkeep');
  assert.equal(pkg.stratus.pluginVersion, 1);
  assert.equal(pkg.engines.node, '>=22.16 <23 || >=24');
  assert.match(pkg.dependencies['@stratusagent/core'], /^\^0\.14\.3$/);
  assert.equal(pkg.stratus.config.additionalProperties, false);
  assert.deepEqual(Object.keys(pkg.stratus.config.properties).sort(), ['mode', 'model', 'save', 'tidy']);
});
