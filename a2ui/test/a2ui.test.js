import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { A2uiValidationError, createPlugin, DEFAULT_MAX_MESSAGES_BYTES } from '../index.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const BASIC_PATH = fixture('basic_catalog.json');
const BASIC = JSON.parse(readFileSync(BASIC_PATH, 'utf8'));
const BASIC_ID = BASIC.catalogId;

/** Set the plugin up with `config` and hand back its tools by name. */
const setUp = async (config = { catalogs: [{ path: BASIC_PATH }] }, deps) => {
  const tools = new Map();
  await createPlugin(config, deps).setup({ tools: { register: (tool) => tools.set(tool.name, tool) } });
  return tools;
};

/** The A2UI error detail a failed call carries, parsed back out of the thrown message. */
const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof A2uiValidationError, `expected an A2uiValidationError, got ${error}`);
    const detail = JSON.parse(error.message);
    assert.deepEqual(Object.keys(detail), ['code', 'surfaceId', 'path', 'message']);
    assert.equal(detail.code, 'VALIDATION_FAILED');
    return detail;
  }
  assert.fail('expected the call to fail');
};

const create = (surfaceId = 's1') => ({ version: 'v1.0', createSurface: { surfaceId, catalogId: BASIC_ID } });
const components = (list, surfaceId = 's1') => ({ version: 'v1.0', updateComponents: { surfaceId, components: list } });
const text = (id, value = 'Hello') => ({ id, component: 'Text', text: value });
const column = (id, children) => ({ id, component: 'Column', children });

const render = (tools, messages, catalogId = BASIC_ID) => tools.get('ui.render').execute({ catalogId, messages });

test('setup registers ui.render and ui.catalog, both safe, after every catalog compiles', async () => {
  const tools = await setUp();
  assert.deepEqual([...tools.values()].map((tool) => [tool.name, tool.risk]), [['ui.catalog', 'safe'], ['ui.render', 'safe']]);
  assert.match(tools.get('ui.render').description, new RegExp(BASIC_ID.replaceAll('.', '\\.')));
  assert.deepEqual(tools.get('ui.render').parameters.properties.catalogId.enum, [BASIC_ID]);
});

test('a catalog that cannot be used refuses the plugin at setup and registers nothing', async (t) => {
  const cases = [
    ['no catalogs', { catalogs: [] }, /at least one catalog/],
    ['path and url both', { catalogs: [{ path: BASIC_PATH, url: 'https://example.com/c.json' }] }, /exactly one of "path" or "url"/],
    ['missing file', { catalogs: [{ path: fixture('nope.json') }] }, /could not be loaded/],
    ['not JSON', { catalogs: [{ path: fileURLToPath(import.meta.url) }] }, /not valid JSON/],
    ['wrong configured id', { catalogs: [{ path: BASIC_PATH, id: 'https://example.com/other' }] }, /not the configured id/],
    ['the same catalog twice', { catalogs: [{ path: BASIC_PATH }, { path: BASIC_PATH }] }, /two configured catalogs/],
    ['plain http to another host', { catalogs: [{ url: 'http://example.com/catalog.json' }] }, /must be https/],
  ];
  for (const [name, config, pattern] of cases) {
    await t.test(name, async () => {
      const registered = [];
      await assert.rejects(createPlugin(config).setup({ tools: { register: (tool) => registered.push(tool) } }), pattern);
      assert.deepEqual(registered, []);
    });
  }
});

test('a catalog that is not an A2UI v1.0 catalog is refused, naming what is missing', async (t) => {
  const deps = (body) => ({ fetchImpl: async () => new Response(JSON.stringify(body)) });
  const url = 'https://catalogs.example.com/c.json';
  await t.test('no catalogId', () => assert.rejects(setUp({ catalogs: [{ url }] }, deps({ components: { Text: {} } })), /has no "catalogId"/));
  await t.test('no components', () => assert.rejects(setUp({ catalogs: [{ url }] }, deps({ catalogId: 'x', components: {} })), /defines no components/));
  await t.test('no anyComponent', () =>
    assert.rejects(setUp({ catalogs: [{ url }] }, deps({ catalogId: 'x', components: { Text: { type: 'object' } } })), /anyComponent/));
  await t.test('an HTTP error', () =>
    assert.rejects(setUp({ catalogs: [{ url }] }, { fetchImpl: async () => new Response('gone', { status: 404 }) }), /HTTP 404/));
});

test('a catalog loads from an https URL', async () => {
  const fetched = [];
  const tools = await setUp({ catalogs: [{ url: 'https://catalogs.example.com/basic.json', id: BASIC_ID }] }, {
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return new Response(JSON.stringify(BASIC));
    },
  });
  assert.deepEqual(fetched, ['https://catalogs.example.com/basic.json']);
  assert.ok(tools.has('ui.render'));
});

test('A2UI\'s own basic-catalog examples are accepted, and the result is only { surfaceId, accepted }', async () => {
  const tools = await setUp();
  for (const name of ['00_incremental.json', '02_email-compose.json', '00_simple-login-form.json']) {
    const { messages } = JSON.parse(readFileSync(fixture(name), 'utf8'));
    const result = await render(tools, messages);
    assert.deepEqual(Object.keys(result).sort(), ['accepted', 'surfaceId'], name);
    assert.equal(result.accepted, true);
    assert.equal(result.surfaceId, messages[0].createSurface.surfaceId);
  }
});

test('a wrongly typed property fails with a pointer to that property', async () => {
  const tools = await setUp();
  const detail = await failure(render(tools, [create(), components([{ id: 'root', component: 'Text', text: 42 }])]));
  assert.equal(detail.surfaceId, 's1');
  assert.equal(detail.path, '/messages/1/updateComponents/components/0/text');
  assert.match(detail.message, /Text "root"/);
});

test('an unknown component, a missing required property, and an unknown property are each named', async (t) => {
  const tools = await setUp();
  await t.test('unknown component', async () => {
    const detail = await failure(render(tools, [create(), components([{ id: 'root', component: 'Carousel' }])]));
    assert.equal(detail.path, '/messages/1/updateComponents/components/0/component');
    assert.match(detail.message, /Unknown component "Carousel".*Column/);
  });
  await t.test('missing required', async () => {
    const detail = await failure(render(tools, [create(), components([{ id: 'root', component: 'Column' }])]));
    assert.equal(detail.path, '/messages/1/updateComponents/components/0/children');
    assert.match(detail.message, /Missing required property "children"/);
  });
  await t.test('unknown property', async () => {
    const detail = await failure(render(tools, [create(), components([{ ...text('root'), colour: 'red' }])]));
    assert.equal(detail.path, '/messages/1/updateComponents/components/0');
    assert.match(detail.message, /Unknown property "colour"/);
  });
  await t.test('message without a version', async () => {
    const detail = await failure(render(tools, [{ createSurface: { surfaceId: 's1', catalogId: BASIC_ID } }]));
    assert.equal(detail.path, '/messages/0/version');
  });
});

test('a new surface needs a complete tree: a root, every child defined, and no cycle', async (t) => {
  const tools = await setUp();
  await t.test('no root', async () => {
    const detail = await failure(render(tools, [create(), components([text('title')])]));
    assert.equal(detail.path, '/messages');
    assert.match(detail.message, /"root"/);
  });
  await t.test('a child nobody defines', async () => {
    const detail = await failure(render(tools, [create(), components([column('root', ['title', 'missing']), text('title')])]));
    assert.equal(detail.path, '/messages/1/updateComponents/components/0/children/1');
    assert.match(detail.message, /"missing", which no component defines/);
  });
  await t.test('a template naming a component nobody defines', async () => {
    const detail = await failure(render(tools, [create(), components([column('root', { path: '/items', componentId: 'row' })])]));
    assert.equal(detail.path, '/messages/1/updateComponents/components/0/children/componentId');
  });
  await t.test('a single child slot (Card.child) and nested slots (Tabs.tabs[].child)', async () => {
    const card = await failure(render(tools, [create(), components([{ id: 'root', component: 'Card', child: 'body' }])]));
    assert.equal(card.path, '/messages/1/updateComponents/components/0/child');
    const tabs = await failure(render(tools, [
      create(),
      components([{ id: 'root', component: 'Tabs', tabs: [{ title: 'A', child: 'a' }, { title: 'B', child: 'b' }] }, text('a')]),
    ]));
    assert.equal(tabs.path, '/messages/1/updateComponents/components/0/tabs/1/child');
  });
  await t.test('a cycle', async () => {
    const detail = await failure(render(tools, [create(), components([column('root', ['a']), column('a', ['b']), column('b', ['a'])])]));
    assert.match(detail.message, /cycle/);
  });
  await t.test('root as somebody\'s child', async () => {
    const detail = await failure(render(tools, [create(), components([column('root', ['a']), column('a', ['root'])])]));
    assert.match(detail.message, /root can only be the top/);
  });
  await t.test('children may arrive in a later message of the same call', async () => {
    const result = await render(tools, [create(), components([column('root', ['title'])]), components([text('title')])]);
    assert.deepEqual(result, { surfaceId: 's1', accepted: true });
  });
});

test('an update to a surface an earlier call created may refer to components already on the device', async () => {
  const tools = await setUp();
  assert.deepEqual(await render(tools, [components([column('list', ['shown-earlier'])])]), { surfaceId: 's1', accepted: true });
  assert.deepEqual(await render(tools, [{ version: 'v1.0', updateDataModel: { surfaceId: 's1', path: '/n', value: 3 } }]), {
    surfaceId: 's1',
    accepted: true,
  });
  const cycle = await failure(render(tools, [components([column('a', ['b']), column('b', ['a'])])]));
  assert.match(cycle.message, /cycle/);
});

test('one call carries one surface, created first, from the catalog it names', async (t) => {
  const tools = await setUp();
  await t.test('two surfaces', async () => {
    const detail = await failure(render(tools, [create('s1'), components([text('root')], 's2')]));
    assert.equal(detail.path, '/messages/1/updateComponents/surfaceId');
    assert.equal(detail.surfaceId, 's1');
  });
  await t.test('createSurface not first', async () => {
    const detail = await failure(render(tools, [components([text('root')]), create()]));
    assert.equal(detail.path, '/messages/1');
  });
  await t.test('createSurface for another catalog', async () => {
    const detail = await failure(render(tools, [{ version: 'v1.0', createSurface: { surfaceId: 's1', catalogId: 'https://example.com/x' } }]));
    assert.equal(detail.path, '/messages/0/createSurface/catalogId');
  });
  await t.test('a component from another catalog', async () => {
    const detail = await failure(render(tools, [create(), components([{ ...text('root'), catalogId: 'https://example.com/x' }])]));
    assert.equal(detail.path, '/messages/1/updateComponents/components/0/catalogId');
  });
  await t.test('an unknown catalogId', async () => {
    const detail = await failure(render(tools, [create()], 'https://example.com/x'));
    assert.equal(detail.path, '/catalogId');
    assert.equal(detail.surfaceId, '');
  });
  await t.test('anything after deleteSurface', async () => {
    const detail = await failure(render(tools, [{ version: 'v1.0', deleteSurface: { surfaceId: 's1' } }, components([text('x')])]));
    assert.equal(detail.path, '/messages/1');
  });
  await t.test('deleteSurface alone is fine', async () => {
    assert.deepEqual(await render(tools, [{ version: 'v1.0', deleteSurface: { surfaceId: 's1' } }]), { surfaceId: 's1', accepted: true });
  });
  await t.test('function-call messages are not ui.render\'s', async () => {
    const detail = await failure(render(tools, [{
      version: 'v1.0',
      callRendererFunction: { functionCallId: 'c1', callFunction: { '@call': 'openUrl', catalogId: BASIC_ID, args: { url: 'https://x' } } },
    }]));
    assert.equal(detail.path, '/messages/0/callRendererFunction');
  });
});

test('messages over maxMessagesBytes are refused before validation', async () => {
  const tools = await setUp({ catalogs: [{ path: BASIC_PATH }], maxMessagesBytes: 1024 });
  const detail = await failure(render(tools, [create(), components([text('root', 'x'.repeat(2000))])]));
  assert.equal(detail.path, '/messages');
  assert.match(detail.message, /limit is 1024/);
  assert.equal(DEFAULT_MAX_MESSAGES_BYTES, 65536);
  assert.throws(() => createPlugin({ catalogs: [{ path: BASIC_PATH }], maxMessagesBytes: 10 }), /maxMessagesBytes/);
});

test('the error points at the spot to fix, so one corrected retry is accepted', async () => {
  const tools = await setUp();
  const first = [create(), components([column('root', ['title']), { id: 'title', component: 'Text', text: { path: '/name' } }])];
  const detail = await failure(render(tools, first));
  assert.equal(detail.path, '/messages/1/updateComponents/components/1/text/@path');
  assert.match(detail.message, /Missing required property "@path"/);
  // The fix the pointer asks for: A2UI binds data with "@path", not "path".
  const retry = structuredClone(first);
  retry[1].updateComponents.components[1].text = { '@path': '/name' };
  assert.deepEqual(await render(tools, retry), { surfaceId: 's1', accepted: true });
});

test('ui.catalog lists catalogs, and returns one catalog\'s instructions and component schemas', async () => {
  const tools = await setUp();
  const list = await tools.get('ui.catalog').execute({});
  assert.equal(list.catalogs.length, 1);
  assert.equal(list.catalogs[0].catalogId, BASIC_ID);
  assert.ok(list.catalogs[0].components.includes('Column'));
  const one = await tools.get('ui.catalog').execute({ catalogId: BASIC_ID });
  assert.equal(one.instructions, BASIC.instructions);
  assert.deepEqual(one.components.Text, BASIC.components.Text);
  await assert.rejects(tools.get('ui.catalog').execute({ catalogId: 'nope' }), /Unknown catalogId/);
});
