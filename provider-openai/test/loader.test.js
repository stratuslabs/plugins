import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ContributionRegistry, EventBus, ToolRegistry } from '@stratusagent/core';
import { loadPlugins } from '@stratusagent/plugins';

// The loader the daemon uses, over this package by name: its manifest, the
// config check, and only the contributions the manifest declares.
const require = createRequire(import.meta.url);
const href = (specifier) => pathToFileURL(require.resolve(specifier)).href;
const host = { resolve: href, import: (specifier) => import(href(specifier)) };

it('the daemon\'s loader loads it, and setup registers only what the manifest declares', async () => {
  const providers = new ContributionRegistry();
  const tools = new ToolRegistry();
  const { loaded, failures } = await loadPlugins({
    config: { '@stratusagent/provider-openai': { enabled: true, model: 'llama3' } },
    host,
    tools,
    bus: new EventBus(),
    providers,
  });
  assert.deepEqual(failures, []);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].trusted, true);
  assert.deepEqual(loaded[0].contributions.providers, ['openai-compatible']);
  assert.deepEqual(loaded[0].manifest.credentials, ['openai.apiKey']);
  assert.ok(providers.get('openai-compatible'));
  assert.deepEqual(tools.list(), []);
});

it('the loader refuses a key written into the config block', async () => {
  const { loaded, failures } = await loadPlugins({
    config: { '@stratusagent/provider-openai': { enabled: true, apiKey: 'literal-key' } },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    providers: new ContributionRegistry(),
  });
  assert.equal(loaded.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /apiKey/);
});
