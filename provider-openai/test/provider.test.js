import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContributionRegistry, EventBus, ToolRegistry } from '@stratusagent/core';
import { createRuntimeProvider } from '@stratusagent/state';

import { createOpenAiProviderPlugin, OPENAI_COMPATIBLE_PROVIDER_NAME } from '../index.js';

/** @param {string} text */
const openAiText = (text) =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A transport that records what it was sent and answers with the model's name. */
const fakeFetch = () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get('authorization') ?? undefined, model: body.model });
    return openAiText(`answered by ${body.model}`);
  };
  return { calls, fetchImpl };
};

const agent = (id, credentials = ['openai.apiKey']) => ({
  id,
  name: id,
  instructions: `You are ${id}.`,
  credentials,
});

const sessionFor = (definition) => ({
  id: `${definition.id}-1`,
  agent: definition,
  status: 'running',
  messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** A resolver with one key per agent, and the kernel's allowlist rule. */
const fakeCredentials = (keys) => ({
  async resolve(definition, name) {
    if (!definition.credentials?.includes(name)) {
      throw new Error(`Agent ${definition.id} is not allowed to access credential: ${name}`);
    }
    return name === 'openai.apiKey' ? keys[definition.id] : undefined;
  },
});

/** Register through a hand-written handle, the way the loader's view would. */
const registered = async (config, fetchImpl, credentials) => {
  let contribution;
  await createOpenAiProviderPlugin(config, { fetch: fetchImpl }).setup({
    bus: new EventBus(),
    tools: new ToolRegistry(),
    providers: { register: (entry) => { contribution = entry; } },
    ...(credentials ? { credentials } : {}),
  });
  assert.ok(contribution);
  return contribution;
};

test('the provider registers under its name, takes the soul\'s model, and sends the calling agent\'s own key', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const contribution = await registered(
    { baseUrl: 'http://127.0.0.1:11434/v1/' },
    fetchImpl,
    fakeCredentials({ ava: 'sk-ava', juno: 'sk-juno' }),
  );
  assert.equal(contribution.name, OPENAI_COMPATIBLE_PROVIDER_NAME);
  assert.equal(contribution.streams, false);

  const provider = contribution.create({ model: 'llama3' });
  const ava = await provider.generate({ session: sessionFor(agent('ava')) });
  const juno = await provider.generate({ session: sessionFor(agent('juno')) });
  assert.deepEqual(ava.parts, [{ type: 'text', text: 'answered by llama3' }]);
  assert.deepEqual(juno.parts, [{ type: 'text', text: 'answered by llama3' }]);
  // Per calling agent, on the configured endpoint, with the trailing slash gone.
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer sk-ava', 'Bearer sk-juno']);
  assert.ok(calls.every((call) => call.url === 'http://127.0.0.1:11434/v1/chat/completions'));
});

test('one adapter per key: a rotated key takes effect on the next request with no restart', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const keys = { ava: 'sk-old' };
  const contribution = await registered({ model: 'm' }, fetchImpl, fakeCredentials(keys));
  const provider = contribution.create({});
  await provider.generate({ session: sessionFor(agent('ava')) });
  keys.ava = 'sk-new';
  await provider.generate({ session: sessionFor(agent('ava')) });
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer sk-old', 'Bearer sk-new']);
});

test('an agent whose soul does not list the credential, or has none stored, is refused naming the remedy', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const contribution = await registered({ model: 'gpt-4.1-mini' }, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  const provider = contribution.create({});

  await assert.rejects(
    provider.generate({ session: sessionFor(agent('juno')) }),
    /No openai\.apiKey credential resolves for agent juno.*stratus credential set openai\.apiKey/,
  );
  await assert.rejects(
    provider.generate({ session: sessionFor(agent('bea', [])) }),
    /Agent bea is not allowed to access credential: openai\.apiKey/,
  );
  assert.equal(calls.length, 0);
});

test('with no model anywhere the selection is refused, and with none in the soul the config\'s serves', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const bare = await registered({}, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  assert.throws(() => bare.create({}), /No model for provider openai-compatible/);

  const configured = await registered({ model: 'from-config' }, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  await configured.create({}).generate({ session: sessionFor(agent('ava')) });
  await configured.create({ model: 'from-soul' }).generate({ session: sessionFor(agent('ava')) });
  assert.deepEqual(calls.map((call) => call.model), ['from-config', 'from-soul']);
});

test('a host with no credential resolver is told so, rather than the plugin reading the environment', async () => {
  const { fetchImpl } = fakeFetch();
  const contribution = await registered({ model: 'm' }, fetchImpl);
  await assert.rejects(
    contribution.create({}).generate({ session: sessionFor(agent('ava')) }),
    /hands plugins no credential resolver/,
  );
});

test('a host with no provider handle is refused at setup, naming the package', async () => {
  await assert.rejects(
    async () => createOpenAiProviderPlugin({}).setup({ bus: new EventBus(), tools: new ToolRegistry() }),
    /no provider handle, so @stratusagent\/provider-openai cannot register openai-compatible/,
  );
});

test('a blank baseUrl is refused at setup, not read as "use api.openai.com"', async () => {
  // A blank endpoint meant for a local or private server must not send the
  // request, and the key, to OpenAI instead.
  for (const baseUrl of ['', '  ']) {
    const { fetchImpl, calls } = fakeFetch();
    await assert.rejects(
      async () => registered({ baseUrl, model: 'llama3' }, fetchImpl, fakeCredentials({ ava: 'sk-ava' })),
      /plugins\["@stratusagent\/provider-openai"\]\.baseUrl is blank/,
    );
    assert.equal(calls.length, 0);
  }
});

test('it serves as a fallback target behind a failing built-in primary', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const contribution = await registered({ baseUrl: 'http://127.0.0.1:11434/v1' }, fetchImpl, fakeCredentials({ ava: 'sk-ava' }));
  const registry = new ContributionRegistry();
  registry.register(contribution.name, contribution);

  const fellBack = [];
  const wrapped = createRuntimeProvider(
    {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-primary',
      fetch: async () => { throw new Error('primary down'); },
      fallback: { provider: 'plugin:openai-compatible', model: 'llama3' },
    },
    (error) => fellBack.push(error),
    undefined,
    undefined,
    undefined,
    registry,
  );
  const response = await wrapped.generate({ session: sessionFor(agent('ava')) });
  assert.equal(fellBack.length, 1);
  assert.deepEqual(response.parts, [{ type: 'text', text: 'answered by llama3' }]);
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer sk-ava']);
});
