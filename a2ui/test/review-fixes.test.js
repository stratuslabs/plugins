import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { A2uiValidationError, createPlugin } from '../index.js';
import { MAX_CATALOG_BYTES } from '../lib/catalogs.js';

const BASIC_PATH = fileURLToPath(new URL('./fixtures/basic_catalog.json', import.meta.url));
const BASIC = JSON.parse(readFileSync(BASIC_PATH, 'utf8'));
const URL_ = 'https://catalogs.example.com/basic.json';

const setUp = async (config, deps) => {
  const tools = new Map();
  await createPlugin(config, deps).setup({ tools: { register: (tool) => tools.set(tool.name, tool) } });
  return tools;
};

test('components are checked against their own schemas even when a loose anyComponent passes the envelope', async (t) => {
  const loose = { ...BASIC, $defs: { ...BASIC.$defs, anyComponent: { type: 'object', additionalProperties: true } } };
  const tools = await setUp({ catalogs: [{ url: URL_ }] }, { fetchImpl: async () => new Response(JSON.stringify(loose)) });
  const render = (list) => tools.get('ui.render').execute({
    catalogId: BASIC.catalogId,
    messages: [{ version: 'v1.0', createSurface: { surfaceId: 's1', catalogId: BASIC.catalogId, components: list } }],
  });
  const detail = async (promise) => {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof A2uiValidationError, String(error));
      return JSON.parse(error.message);
    }
    return assert.fail('expected the call to fail');
  };
  await t.test('an unknown component', async () => {
    const d = await detail(render([{ id: 'root', component: 'Bogus' }]));
    assert.match(d.message, /Unknown component "Bogus"/);
    assert.equal(d.path, '/messages/0/createSurface/components/0/component');
  });
  await t.test('a known component missing a required property', async () => {
    const d = await detail(render([{ id: 'root', component: 'Text' }]));
    assert.match(d.message, /Missing required property "text"/);
  });
  await t.test('a valid screen is still accepted', async () => {
    assert.deepEqual(await render([{ id: 'root', component: 'Text', text: 'Hi' }]), { surfaceId: 's1', accepted: true });
  });
});

test('ui.catalog returns the shared definitions its schemas refer to, so every ref resolves', async () => {
  const tools = await setUp({ catalogs: [{ path: BASIC_PATH }] });
  const one = await tools.get('ui.catalog').execute({ catalogId: BASIC.catalogId });
  for (const name of ['Action', 'DynamicString', 'Checkable', 'ChildList']) {
    assert.ok(one.commonTypes[name], `commonTypes.${name}`);
  }
  const refs = [];
  const walk = (node, inCommon) => {
    if (Array.isArray(node)) return node.forEach((item) => walk(item, inCommon));
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push({ ref: value, inCommon });
        else walk(value, inCommon);
      }
    }
  };
  walk([one.components, one.functions, one.catalogDefs], false);
  walk(one.commonTypes, true);
  for (const { ref, inCommon } of refs) {
    const common = /common_types\.json#\/\$defs\/([^/]+)$/.exec(ref) ?? (inCommon ? /^#\/\$defs\/([^/]+)$/.exec(ref) : null);
    if (common) {
      assert.ok(common[1] in one.commonTypes, `${ref} resolves in commonTypes`);
      continue;
    }
    const own = /^#\/\$defs\/([^/]+)$/.exec(ref);
    if (own) assert.ok(own[1] in one.catalogDefs, `${ref} resolves in catalogDefs`);
  }
});

test('a catalog redirect is followed only to another https URL', async (t) => {
  const redirectTo = (location) => {
    const fetched = [];
    const fetchImpl = async (url, init) => {
      fetched.push({ url: String(url), redirect: init?.redirect });
      if (String(url) === URL_) return new Response(null, { status: 302, headers: { location } });
      return new Response(JSON.stringify(BASIC));
    };
    return { fetched, fetchImpl };
  };
  await t.test('to plain http elsewhere: refused before it is fetched', async () => {
    const { fetched, fetchImpl } = redirectTo('http://evil.example.com/basic.json');
    await assert.rejects(setUp({ catalogs: [{ url: URL_ }] }, { fetchImpl }), /must be https/);
    assert.deepEqual(fetched.map((f) => f.url), [URL_]);
    assert.equal(fetched[0].redirect, 'manual');
  });
  await t.test('to another https URL: followed', async () => {
    const { fetched, fetchImpl } = redirectTo('/v2/basic.json');
    const tools = await setUp({ catalogs: [{ url: URL_ }] }, { fetchImpl });
    assert.ok(tools.has('ui.render'));
    assert.deepEqual(fetched.map((f) => f.url), [URL_, 'https://catalogs.example.com/v2/basic.json']);
  });
  await t.test('a redirect loop stops', async () => {
    const fetchImpl = async () => new Response(null, { status: 301, headers: { location: URL_ } });
    await assert.rejects(setUp({ catalogs: [{ url: URL_ }] }, { fetchImpl }), /redirected more than/);
  });
});

test('an oversized catalog body is cut off while streaming, without reading the rest', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 1000) return controller.close();
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  await assert.rejects(setUp({ catalogs: [{ url: URL_ }] }, { fetchImpl: async () => new Response(body) }), /larger than/);
  assert.ok(cancelled, 'the stream was cancelled');
  assert.ok(pulled * chunk.byteLength <= MAX_CATALOG_BYTES + 2 * chunk.byteLength, `read ${pulled} chunks`);
});

test('a declared content-length over the cap is refused before reading', async () => {
  let read = false;
  const body = new ReadableStream({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 });
  const fetchImpl = async () => new Response(body, { headers: { 'content-length': String(MAX_CATALOG_BYTES + 1) } });
  await assert.rejects(setUp({ catalogs: [{ url: URL_ }] }, { fetchImpl }), /larger than/);
  assert.equal(read, false);
});
