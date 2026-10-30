import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { EventBus, ToolRegistry } from '@stratusagent/core';
import { loadPlugins } from '@stratusagent/plugins';

// The loader the daemon uses, over this package by name: its manifest, the
// config check, the manifest-bound credential view and the first-party risk.
const require = createRequire(import.meta.url);
const href = (specifier) => pathToFileURL(require.resolve(specifier)).href;
const host = { resolve: href, import: (specifier) => import(href(specifier)) };

it('the daemon\'s loader loads it and registers web.search as safe, with external output', async () => {
  const tools = new ToolRegistry();
  const { loaded, failures } = await loadPlugins({
    config: { '@stratusagent/plugin-brave-search': { enabled: true, agents: { ben: { maxSearchesPerDay: 0 } } } },
    host,
    tools,
    bus: new EventBus(),
    credentials: { async resolve() { throw new Error('not reached'); } },
  });
  assert.deepEqual(failures, []);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].trusted, true);
  const tool = tools.get('web.search');
  assert.equal(tool.risk, 'safe');
  assert.equal(tool.outputTrust, 'external');
});

it('the loader refuses a key written into the config block', async () => {
  const { loaded, failures } = await loadPlugins({
    config: { '@stratusagent/plugin-brave-search': { enabled: true, apiKey: 'literal-key' } },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
  });
  assert.equal(loaded.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /apiKey/);
});
