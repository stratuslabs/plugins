import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EventBus, HostRefusalError, ToolRegistry } from '@stratusagent/core';
import { loadPlugins } from '@stratusagent/plugins';

// The loader the daemon uses, over this package by name: its manifest, the
// config check against the manifest's schema, the state directory and the
// provider-call guard slot.
const require = createRequire(import.meta.url);
const href = (specifier) => pathToFileURL(require.resolve(specifier)).href;
const host = { resolve: href, import: (specifier) => import(href(specifier)) };
const NAME = '@stratusagent/plugin-budgets';

const load = async (block, { guards = [] } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'budgets-loader-'));
  const bus = new EventBus();
  const asked = [];
  const result = await loadPlugins({
    config: { [NAME]: { enabled: true, ...block } },
    host,
    tools: new ToolRegistry(),
    bus,
    stateDirectories: (packageName) => ({ prepare: () => { asked.push(packageName); return directory; } }),
    ...(guards ? { providerCallGuards: guards } : {}),
  });
  return { ...result, bus, guards, asked };
};

it('the daemon\'s loader loads it, registers one guard, and the guard refuses once a limit is spent', async () => {
  const { loaded, failures, guards, bus, asked } = await load({ home: { daily: 1000 }, reservePerCall: 0, agents: { Scout: { daily: 50 } } });
  assert.deepEqual(failures, []);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].providerCallGuards, 1);
  assert.equal(guards.length, 1);
  assert.ok(asked.every((name) => name === NAME));
  await guards[0]({ agentId: 'scout', sessionId: 's', provider: 'anthropic' });
  await bus.emit({ type: 'session.usage', sessionId: 's', agentId: 'scout', records: [{ id: 'u1', turnId: 't', provider: 'anthropic', inputTokens: 50 }] });
  await assert.rejects(guards[0]({ agentId: 'scout', sessionId: 's', provider: 'anthropic' }), (error) => {
    assert.ok(error instanceof HostRefusalError);
    assert.match(error.message, /^Agent scout has used its daily model budget \(50 of 50 .*agents\.Scout\.daily/);
    return true;
  });
  await guards[0]({ agentId: 'ava', sessionId: 's2', provider: 'anthropic' });
});

it('the loader refuses a misspelled limit instead of running uncapped', async () => {
  const { loaded, failures } = await load({ home: { daly: 5 } });
  assert.equal(loaded.length, 0);
  assert.match(failures[0].reason, /daly/);
});

it('the plugin refuses an install total written inside one agent\'s entry', async () => {
  const { loaded, failures } = await load({ agents: { scout: { home: { daily: 5 } } } });
  assert.equal(loaded.length, 0);
  assert.match(failures[0].reason, /agents\.scout.*home/);
});

it('a host with no guard slot gets a refused plugin, not a limit nothing enforces', async () => {
  const { loaded, failures } = await load({ daily: 5 }, { guards: null });
  assert.equal(loaded.length, 0);
  assert.match(failures[0].reason, /providerCalls/);
});
