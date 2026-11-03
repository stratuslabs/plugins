import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createWebSearchTool } from '@stratusagent/search';
import { parsePluginManifest, PluginConfigError, validatePluginConfig } from '@stratusagent/plugins';

import {
  BRAVE_ENDPOINT,
  BRAVE_MAX_COUNT,
  braveFreshness,
  braveResults,
  createBraveSearchProvider,
  createPlugin,
} from '../index.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// A fixed clock: Oct 27, 2026, 12:00 UTC. P7D then reaches back to Oct 20, 12:00.
const NOW = new Date('2026-10-27T12:00:00Z');

const KEYS = { ava: 'key-for-ava', ben: 'key-for-ben' };
const resolver = {
  async resolve(agent, name) {
    assert.equal(name, 'search.apiKey');
    const key = KEYS[agent.id];
    if (key === undefined) throw new Error(`Agent ${agent.id} is not allowed to access credential: ${name}`);
    return key;
  },
};
const sessionFor = (id) => ({ id: `s-${id}`, agent: { id, credentials: ['search.apiKey'] } });

// One local stand-in for api.search.brave.com. Each test queues the answers
// it wants; every request is recorded so a test can check what was sent.
let server;
let endpoint;
const requests = [];
let answers = [];

const answer = (status, body, headers = {}) => ({ status, body, headers });

before(async () => {
  server = http.createServer((request, response) => {
    requests.push({ url: new URL(request.url, 'http://127.0.0.1'), headers: request.headers });
    const next = answers.shift();
    if (next === 'hang') return; // never answers; the test aborts it
    const { status, body, headers } = next ?? answer(500, '{}');
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/res/v1/web/search`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const reset = (...queued) => {
  requests.length = 0;
  answers = queued;
};

const sleeps = [];
const toolWith = (providerOptions = {}, config = {}) => createWebSearchTool({
  provider: createBraveSearchProvider({
    endpoint,
    sleep: async (ms) => { sleeps.push(ms); },
    ...providerOptions,
  }),
  // The stand-in listens on 127.0.0.1, which the address policy refuses
  // unless an operator exempts it.
  config: { allowedHosts: ['127.0.0.1'], ...config },
  credentials: resolver,
  now: () => NOW,
});

describe('a search', () => {
  it('sends the query as literal text with the calling agent\'s key, and reshapes the results', async () => {
    reset(answer(200, fixture('web-search-200.json')));
    const result = await toolWith().execute({ query: 'kettle "descaling" -vinegar', count: 5 }, sessionFor('ava'));

    assert.equal(requests.length, 1);
    const { url, headers } = requests[0];
    assert.equal(url.pathname, '/res/v1/web/search');
    assert.equal(url.searchParams.get('q'), 'kettle "descaling" -vinegar');
    // Quotes and a minus are characters to search for, not operators, and
    // the spellchecker must not swap in a query nobody asked for.
    assert.equal(url.searchParams.get('operators'), 'false');
    assert.equal(url.searchParams.get('spellcheck'), 'false');
    assert.equal(url.searchParams.get('count'), '5');
    assert.equal(url.searchParams.get('result_filter'), 'web');
    assert.equal(url.searchParams.get('text_decorations'), 'false');
    assert.equal(url.searchParams.has('freshness'), false);
    assert.equal(headers['x-subscription-token'], 'key-for-ava');
    assert.equal(headers.accept, 'application/json');

    assert.equal(result.provider, 'brave');
    assert.equal(result.query, 'kettle "descaling" -vinegar');
    assert.equal(result.untrusted, true);
    assert.deepEqual(result.results.map((row) => row.url), [
      'https://www.example.com/guides/descale-kettle',
      'https://docs.example.com/kettles/faq',
      'https://notexample.com/limescale',
      'https://forum.example.org/t/descaling',
    ]);
    assert.deepEqual(result.results[0], {
      title: 'How to descale a kettle without vinegar',
      url: 'https://www.example.com/guides/descale-kettle',
      snippet: 'Citric acid works as well as descaling tablets. Fill the kettle halfway…',
      publishedAt: '2026-10-20T09:15:00.000Z',
    });
  });

  it('uses each agent\'s own key', async () => {
    reset(answer(200, fixture('web-search-200.json')));
    await toolWith().execute({ query: 'kettles' }, sessionFor('ben'));
    assert.equal(requests[0].headers['x-subscription-token'], 'key-for-ben');
  });

  it('asks for at most 20, Brave\'s page size', async () => {
    reset(answer(200, fixture('web-search-200.json')));
    await toolWith().execute({ query: 'kettles', count: 50 }, sessionFor('ava'));
    assert.equal(requests[0].url.searchParams.get('count'), String(BRAVE_MAX_COUNT));
  });

  it('asks for a full page when results are filtered afterwards, and never puts site: in the query', async () => {
    reset(answer(200, fixture('web-search-200.json')));
    const result = await toolWith().execute({ query: 'kettles', count: 3, site: 'example.com' }, sessionFor('ava'));
    const { searchParams } = requests[0].url;
    assert.equal(searchParams.get('q'), 'kettles');
    assert.equal(searchParams.get('count'), '20');
    assert.deepEqual(result.results.map((row) => row.url), [
      'https://www.example.com/guides/descale-kettle',
      'https://docs.example.com/kettles/faq',
    ]);
  });

  it('sends freshness as Brave\'s date range and keeps only results dated inside it', async () => {
    reset(answer(200, fixture('web-search-200.json')));
    const result = await toolWith().execute({ query: 'kettles', freshness: 'P7D' }, sessionFor('ava'));
    const { searchParams } = requests[0].url;
    assert.equal(searchParams.get('freshness'), '2026-10-20to2026-10-27');
    assert.equal(searchParams.get('count'), '20');
    // Oct 20 09:15 UTC is older than Oct 20 12:00, Jan 3 is older still, and
    // the forum thread has no date at all.
    assert.deepEqual(result.results.map((row) => row.url), ['https://docs.example.com/kettles/faq']);
    assert.equal(result.results[0].publishedAt, '2026-10-25T16:00:00.000Z');
  });
});

describe('Brave\'s dates', () => {
  it('reads a page_age with no zone as UTC, keeps one with a zone, and drops anything else', () => {
    const rows = braveResults(JSON.stringify({
      web: {
        results: [
          { title: 'a', url: 'https://a.example/', page_age: '2026-10-20T09:15:00' },
          { title: 'b', url: 'https://b.example/', page_age: '2026-10-20T09:15:00.250' },
          { title: 'c', url: 'https://c.example/', page_age: '2026-10-25T18:00:00+02:00' },
          { title: 'd', url: 'https://d.example/', page_age: '2026-01-03' },
          { title: 'e', url: 'https://e.example/', page_age: 'March 2, 2023' },
          { title: 'e2', url: 'https://e2.example/', page_age: '2026-02-30T10:00:00' },
          { title: 'f', url: 'https://f.example/', age: '2 days ago' },
        ],
      },
    }));
    assert.deepEqual(rows.map((row) => row.publishedAt), [
      '2026-10-20T09:15:00.000Z',
      '2026-10-20T09:15:00.250Z',
      '2026-10-25T16:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
      undefined,
      undefined,
      undefined,
    ]);
    assert.equal('publishedAt' in rows[6], false);
  });

  it('a response with no web results is an empty list, not an error', () => {
    assert.deepEqual(braveResults(JSON.stringify({ type: 'search', query: { original: 'zzzz' } })), []);
  });

  it('a freshness range runs from the day of since to the day of now, in UTC', () => {
    assert.equal(
      braveFreshness({ duration: 'PT2H', ms: 7_200_000, since: '2026-10-26T23:30:00.000Z' }),
      '2026-10-26to2026-10-27',
    );
  });
});

describe('a failure says what happened', () => {
  // Captured from the live API on Oct 27, 2026 with a made-up key: Brave
  // answers a bad key with 422, not 401, and says so in meta.component.
  for (const [status, label] of [[422, 'as Brave really answers it (422)'], [401, 'as a 401'], [403, 'as a 403']]) {
    it(`a refused key names the credential and the status, never the key: ${label}`, async () => {
      reset(answer(status, fixture('error-invalid-key.json')));
      await assert.rejects(
        toolWith().execute({ query: 'kettles' }, sessionFor('ava')),
        (error) => {
          assert.match(error.message, /refused the key in search\.apiKey/);
          assert.match(error.message, new RegExp(`HTTP ${status}, SUBSCRIPTION_TOKEN_INVALID`));
          assert.match(error.message, /stratus credential set search\.apiKey/);
          assert.doesNotMatch(error.message, /key-for-ava/);
          return true;
        },
      );
      assert.equal(requests.length, 1);
    });
  }

  it('a used-up monthly quota says so and when it resets, without retrying', async () => {
    reset(answer(429, fixture('error-429.json'), {
      'x-ratelimit-limit': '1, 2000',
      'x-ratelimit-remaining': '1, 0',
      'x-ratelimit-reset': '1, 864000',
    }));
    await assert.rejects(
      toolWith().execute({ query: 'kettles' }, sessionFor('ava')),
      /monthly quota of 2000 searches is used up\. It resets in 10 days/,
    );
    assert.equal(requests.length, 1);
  });

  it('a per-second limit waits for the window and tries once more', async () => {
    sleeps.length = 0;
    reset(
      answer(429, fixture('error-429.json'), { 'x-ratelimit-remaining': '0, 1500', 'x-ratelimit-reset': '1, 864000' }),
      answer(200, fixture('web-search-200.json')),
    );
    const result = await toolWith().execute({ query: 'kettles' }, sessionFor('ava'));
    assert.equal(requests.length, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(result.results.length, 4);
  });

  it('a per-second limit that holds after the retry is reported as a rate limit', async () => {
    sleeps.length = 0;
    const limited = () => answer(429, fixture('error-429.json'), {
      'x-ratelimit-remaining': '0, 1500',
      'x-ratelimit-reset': '1, 864000',
    });
    reset(limited(), limited());
    await assert.rejects(
      toolWith().execute({ query: 'kettles' }, sessionFor('ava')),
      /per-second rate limit .*HTTP 429, RATE_LIMITED/,
    );
    assert.equal(requests.length, 2);
  });

  it('a 429 without rate-limit headers is not retried and still says 429', async () => {
    reset(answer(429, fixture('error-429.json')));
    await assert.rejects(toolWith().execute({ query: 'kettles' }, sessionFor('ava')), /HTTP 429/);
    assert.equal(requests.length, 1);
  });

  it('a refused request carries Brave\'s own reason', async () => {
    reset(answer(422, fixture('error-422.json')));
    await assert.rejects(
      toolWith().execute({ query: 'kettles' }, sessionFor('ava')),
      /refused the request \(HTTP 422, VALIDATION\): Unable to validate request parameter\(s\)/,
    );
  });

  it('a body that is not JSON is an error, not an empty result', async () => {
    reset(answer(200, '<html>maintenance</html>'));
    await assert.rejects(toolWith().execute({ query: 'kettles' }, sessionFor('ava')), /not JSON/);
  });

  it('a body over the size cap is an error, not a half-parsed result', async () => {
    reset(answer(200, fixture('web-search-200.json')));
    await assert.rejects(
      toolWith({ maxBytes: 64 }).execute({ query: 'kettles' }, sessionFor('ava')),
      /cut off at 64 bytes/,
    );
  });

  it('an agent without the key sends nothing', async () => {
    reset();
    await assert.rejects(
      toolWith().execute({ query: 'kettles' }, sessionFor('cal')),
      /not allowed to access credential: search\.apiKey/,
    );
    assert.equal(requests.length, 0);
  });

  it('an empty stored key sends nothing', async () => {
    reset();
    const tool = createWebSearchTool({
      provider: createBraveSearchProvider({ endpoint }),
      config: { allowedHosts: ['127.0.0.1'] },
      credentials: { async resolve() { return '  '; } },
      now: () => NOW,
    });
    await assert.rejects(tool.execute({ query: 'kettles' }, sessionFor('ava')), /search\.apiKey is empty/);
    assert.equal(requests.length, 0);
  });

  it('a cancelled turn stops the request', async () => {
    reset('hang');
    const controller = new AbortController();
    const pending = toolWith().execute({ query: 'kettles' }, sessionFor('ava'), { signal: controller.signal });
    while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError' || /abort/i.test(error.message));
  });

  it('the real endpoint is the default, reached through the policy it was handed', async () => {
    const calls = [];
    const policy = { allowedHosts: [] };
    const signal = new AbortController().signal;
    const provider = createBraveSearchProvider({
      request: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, headers: {}, body: '{}', truncated: false };
      },
    });
    assert.equal(provider.name, 'brave');
    await provider.search('kettles', { count: 1 }, { credentials: { async get() { return 'k'; } }, policy, signal });
    assert.equal(new URL(calls[0].url).origin + new URL(calls[0].url).pathname, BRAVE_ENDPOINT);
    assert.equal(calls[0].options.policy, policy);
    assert.equal(calls[0].options.signal, signal);
  });
});

describe('the plugin', () => {
  it('its manifest loads, and its config takes the shared settings with per-agent overrides', () => {
    const parsed = parsePluginManifest(manifest, manifest.name);
    assert.deepEqual(parsed.credentials, ['search.apiKey']);
    validatePluginConfig(parsed, {
      enabled: true,
      maxSearchesPerDay: 100,
      agents: { ava: { maxSearchesPerDay: 0 } },
    });
    assert.throws(() => validatePluginConfig(parsed, { apiKey: 'literal-key' }), PluginConfigError);
  });

  it('registers web.search, resolves the calling agent\'s key per call, and logs no query', async () => {
    const registered = [];
    const logged = [];
    const config = { allowedHosts: ['127.0.0.1'], agents: { ben: { maxSearchesPerDay: 0 } } };
    const plugin = createPlugin(config, { endpoint });
    await plugin.setup({
      tools: { register: (tool) => registered.push(tool) },
      credentials: resolver,
      log: (line) => logged.push(line),
    });
    assert.deepEqual(registered.map((tool) => tool.name), ['web.search']);

    reset(answer(200, fixture('web-search-200.json')));
    await registered[0].execute({ query: 'secret kettle plans' }, sessionFor('ava'));
    assert.equal(requests[0].headers['x-subscription-token'], 'key-for-ava');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /web\.search via brave/);
    assert.doesNotMatch(logged[0], /secret kettle plans/);

    // ben's override turns his search off without touching his soul.
    reset();
    await assert.rejects(registered[0].execute({ query: 'kettles' }, sessionFor('ben')), /used its 0 web\.search calls/);
    assert.equal(requests.length, 0);
  });
});
