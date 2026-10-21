import test from 'node:test';
import assert from 'node:assert/strict';

import { admit, budgetFor, createPlugin, peerSessionId, sign, DEFAULT_MAX_DEPTH } from '../index.js';

const SECRET = 'a-shared-secret-between-two-daemons';

/** A host handle that records registrations, the way a daemon's PluginContext would. */
const fakeContext = (secrets) => {
  const tools = [];
  const channels = [];
  const logs = [];
  return {
    tools,
    channels,
    logs,
    context: {
      tools: { register: (tool) => tools.push(tool) },
      channels: {
        register: (contribution) => channels.push(contribution),
        transportSecrets: async (kind) => (kind === 'peer' ? secrets : {}),
      },
      log: (line) => logs.push(line),
    },
  };
};

/** A gateway that answers each dispatch with `answer(input)`, recording what it was given. */
const fakeGateway = (answer) => {
  const calls = [];
  return {
    calls,
    async dispatch(input) {
      calls.push(input);
      return answer(input);
    },
  };
};

const answered = (text) => ({ status: 'completed', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: text }] });

/**
 * Two daemons: "home" sends as ava, "studio" receives for nova. Each side
 * holds the same pairwise secret, named for the other daemon.
 */
const twoDaemons = async (t, { answer = (input) => answered(`nova did: ${input.userMessage}`), studioConfig = {}, homeConfig = {} } = {}) => {
  const studio = fakeContext({ nova: { home: SECRET } });
  const listener = await createPlugin({ self: 'studio', listen: { host: '127.0.0.1', port: 0 }, ...studioConfig }).setup(studio.context);
  const gateway = fakeGateway(answer);
  await studio.channels[0].adapter.start(gateway);
  t.after(() => studio.channels[0].adapter.stop());
  const { port } = listener.address();
  const home = fakeContext({ ava: { studio: SECRET } });
  await createPlugin({ self: 'home', peers: { studio: { url: `http://127.0.0.1:${port}` } }, ...homeConfig }).setup(home.context);
  const tool = home.tools.find((entry) => entry.name === 'peer.delegate');
  return { tool, gateway, listener, port, studio };
};

const session = (id = 'slack:ava:T1:C1:1', metadata = {}) => ({ id, agent: { id: 'ava' }, metadata });

test('setup refuses a host with no channel handle, and a config with no self', async () => {
  await assert.rejects(createPlugin({ self: 'home' }).setup({ tools: { register() {} } }), /PluginContext\.channels/);
  await assert.rejects(createPlugin({}).setup(fakeContext({}).context), /needs "self"/);
  await assert.rejects(createPlugin({ self: 'home', peers: { studio: { url: 'file:///etc/passwd' } } }).setup(fakeContext({}).context), /file: url/);
});

test('setup registers a peer channel for the agents holding peer secrets, and a gated peer.delegate', async () => {
  const host = fakeContext({ nova: { home: SECRET } });
  await createPlugin({ self: 'studio' }).setup(host.context);
  assert.deepEqual(host.channels.map((entry) => [entry.adapter.name, entry.agents]), [['peer', ['nova']]]);
  assert.deepEqual(host.tools.map((tool) => [tool.name, tool.risk, tool.outputTrust]), [['peer.delegate', 'gated', 'agent']]);
});

test('a delegated task runs on the other daemon and its answer comes back', async (t) => {
  const { tool, gateway } = await twoDaemons(t);
  const output = await tool.execute({ target: 'studio/nova', prompt: 'summarize the deploy' }, session());
  assert.equal(output.status, 'result');
  assert.equal(output.from, 'studio/nova');
  assert.equal(output.answer, 'nova did: summarize the deploy');
  assert.equal(gateway.calls.length, 1);
  const [call] = gateway.calls;
  assert.equal(call.agentId, 'nova');
  assert.equal(call.addressed, true);
  assert.equal(call.metadata.senderTrust, 'agent');
  assert.deepEqual({ daemon: call.metadata.peer.daemon, agent: call.metadata.peer.agent }, { daemon: 'home', agent: 'ava' });
  assert.match(call.sessionId, new RegExp(`^peer:home:1\\.${DEFAULT_MAX_DEPTH}:[0-9a-f]{16}:nova$`));
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(call.idempotencyKey, `peer:home:${output.requestId}`);
});

test('the same caller conversation keeps one remote session; another conversation gets its own', async (t) => {
  const { tool, gateway } = await twoDaemons(t);
  await tool.execute({ target: 'studio/nova', prompt: 'one' }, session('conv-a'));
  await tool.execute({ target: 'studio/nova', prompt: 'two' }, session('conv-a'));
  await tool.execute({ target: 'studio/nova', prompt: 'three' }, session('conv-b'));
  const [a1, a2, b] = gateway.calls.map((call) => call.sessionId);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('the sender refuses before any request: unknown peer, no secret of its own, bad target', async (t) => {
  const { tool, gateway } = await twoDaemons(t);
  assert.deepEqual(await tool.execute({ target: 'elsewhere/nova', prompt: 'x' }, session()), { status: 'refused', reason: 'no peer named elsewhere is configured' });
  const kai = { id: 'k1', agent: { id: 'kai' }, metadata: {} };
  assert.deepEqual(await tool.execute({ target: 'studio/nova', prompt: 'x' }, kai), { status: 'refused', reason: 'kai holds no secret for studio' });
  await assert.rejects(tool.execute({ target: 'studio', prompt: 'x' }, session()), /"<daemon>\/<agent>"/);
  await assert.rejects(tool.execute({ target: 'studio/nova/extra', prompt: 'x' }, session()), /"<daemon>\/<agent>"/);
  await assert.rejects(tool.execute({ target: 'studio/nova', prompt: '  ' }, session()), /non-empty/);
  assert.equal(gateway.calls.length, 0);
});

test('the receiver refuses a request for an agent that holds no secret for the sender, without saying which', async (t) => {
  const { tool, gateway } = await twoDaemons(t);
  const toUnknown = await tool.execute({ target: 'studio/ghost', prompt: 'x' }, session());
  assert.deepEqual([toUnknown.status, toUnknown.reason], ['refused', 'not allowed']);
  assert.equal(gateway.calls.length, 0);
});

const signedBody = (overrides = {}) => {
  const body = { v: 1, id: 'r1', from: { daemon: 'home', agent: 'ava' }, to: 'nova', conversation: 'c', prompt: 'p', depth: 0, ceiling: 3, sentAt: 1_000_000, ...overrides };
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, signature: sign(SECRET, raw) };
};
const secrets = { nova: { home: SECRET } };

test('admit: a valid request is admitted one hop deeper, within the lower of the two limits', () => {
  const { raw, signature } = signedBody({ depth: 1, ceiling: 2 });
  const decision = admit({ raw, signature, secrets, maxDepth: 3, now: 1_000_000 });
  assert.equal(decision.refusal, undefined);
  assert.deepEqual([decision.depth, decision.limit], [2, 2]);
});

test('admit: a forged, re-signed, or tampered request is refused as not allowed', () => {
  const { raw } = signedBody();
  assert.equal(admit({ raw, signature: sign('wrong-secret', raw), secrets, maxDepth: 3, now: 1_000_000 }).refusal, 'not allowed');
  assert.equal(admit({ raw, signature: undefined, secrets, maxDepth: 3, now: 1_000_000 }).refusal, 'not allowed');
  const { signature } = signedBody();
  const tampered = Buffer.from(raw.toString().replace('"depth":0', '"depth":0 ').replace('"ceiling":3', '"ceiling":9'));
  assert.equal(admit({ raw: tampered, signature, secrets, maxDepth: 3, now: 1_000_000 }).refusal, 'not allowed');
  // A sender claiming another daemon's name signs with a secret nobody holds for that name.
  const { raw: claimed } = signedBody({ from: { daemon: 'other', agent: 'ava' } });
  assert.equal(admit({ raw: claimed, signature: sign(SECRET, claimed), secrets, maxDepth: 3, now: 1_000_000 }).refusal, 'not allowed');
  // An inherited key never counts as an agent with secrets.
  const { raw: proto } = signedBody({ to: 'constructor' });
  assert.equal(admit({ raw: proto, signature: sign(SECRET, proto), secrets, maxDepth: 3, now: 1_000_000 }).refusal, 'not allowed');
});

test('admit: a stale or future-dated request is refused once its signature holds', () => {
  const { raw, signature } = signedBody({ sentAt: 1_000_000 });
  assert.equal(admit({ raw, signature, secrets, maxDepth: 3, now: 1_000_000 + 11 * 60_000 }).refusal, 'stale');
  assert.equal(admit({ raw, signature, secrets, maxDepth: 3, now: 1_000_000 - 2 * 60_000 }).refusal, 'stale');
});

test('admit: depth at the limit is refused, whichever side set the lower limit', () => {
  const atCeiling = signedBody({ depth: 1, ceiling: 1 });
  assert.equal(admit({ ...atCeiling, secrets, maxDepth: 3, now: 1_000_000 }).refusal, 'depth limit');
  const atReceiver = signedBody({ depth: 2, ceiling: 5 });
  assert.equal(admit({ ...atReceiver, secrets, maxDepth: 2, now: 1_000_000 }).refusal, 'depth limit');
});

test('admit: malformed bodies are refused before any secret is looked at', () => {
  for (const overrides of [{ v: 2 }, { to: 'a:b' }, { from: { daemon: 'x/y', agent: 'ava' } }, { prompt: '' }, { depth: -1 }, { depth: 1.5 }, { sentAt: 'now' }]) {
    const { raw, signature } = signedBody(overrides);
    assert.equal(admit({ raw, signature, secrets, maxDepth: 3, now: 1_000_000 }).refusal, 'malformed', JSON.stringify(overrides));
  }
  assert.equal(admit({ raw: Buffer.from('{not json'), signature: 'x', secrets, maxDepth: 3 }).refusal, 'malformed');
});

test('budget: a session descending from a peer turn spends that turn\'s budget plus its local hops', () => {
  const root = peerSessionId({ fromDaemon: 'home', depth: 1, limit: 2, conversation: 'c', agentId: 'nova' });
  assert.deepEqual(budgetFor({ id: root, metadata: {} }, 3), { depth: 1, ceiling: 2 });
  // A local agent.delegate child: core copies rootSessionId and bumps delegationDepth.
  assert.deepEqual(budgetFor({ id: 'child', metadata: { rootSessionId: root, delegationDepth: 1 } }, 3), { depth: 2, ceiling: 2 });
  // The receiving daemon's own limit still applies when it is lower.
  assert.deepEqual(budgetFor({ id: root, metadata: {} }, 1), { depth: 1, ceiling: 1 });
  // A session with no peer ancestry starts at its own delegation depth.
  assert.deepEqual(budgetFor({ id: 'slack:x', metadata: { delegationDepth: 2 } }, 3), { depth: 2, ceiling: 3 });
});

test('an A -> B -> A loop spends one budget and stops', async (t) => {
  // Studio answers by delegating straight back to home, as a looping agent would.
  let tool;
  const { tool: homeTool, gateway } = await twoDaemons(t, {
    answer: async (input) => {
      const back = await tool.execute({ target: 'studio/nova', prompt: 'again' }, { id: input.sessionId, agent: { id: 'ava' }, metadata: {} });
      return answered(JSON.stringify(back));
    },
  });
  tool = homeTool;
  const output = await homeTool.execute({ target: 'studio/nova', prompt: 'start' }, session());
  assert.equal(output.status, 'result');
  // Three hops at the default limit of 3, then the sender refuses on its own.
  assert.equal(gateway.calls.length, DEFAULT_MAX_DEPTH);
  assert.match(output.answer, /depth limit/);
});

test('a failed remote turn and a throwing gateway both come back as failed, with no detail leaked', async (t) => {
  const { tool } = await twoDaemons(t, { answer: () => ({ status: 'failed', messages: [] }) });
  assert.deepEqual((({ status, error }) => ({ status, error }))(await tool.execute({ target: 'studio/nova', prompt: 'x' }, session())), { status: 'failed', error: 'the remote turn failed' });
  const second = await twoDaemons(t, { answer: () => { throw new Error('secret internal path /Users/x'); } });
  const output = await second.tool.execute({ target: 'studio/nova', prompt: 'x' }, session());
  assert.equal(output.status, 'failed');
  assert.doesNotMatch(JSON.stringify(output), /Users/);
});

test('a duplicate request id is not run twice', async (t) => {
  const seen = new Set();
  const { port, gateway } = await twoDaemons(t, {
    answer: (input) => {
      if (seen.has(input.idempotencyKey)) {
        input.onRepeat?.('finished');
        return answered('');
      }
      seen.add(input.idempotencyKey);
      return answered('ran');
    },
  });
  const raw = JSON.stringify({ v: 1, id: 'dup-1', from: { daemon: 'home', agent: 'ava' }, to: 'nova', conversation: 'c', prompt: 'p', depth: 0, ceiling: 3, sentAt: Date.now() });
  const post = () => fetch(`http://127.0.0.1:${port}/peer/v1/delegate`, { method: 'POST', headers: { 'x-stratus-peer-signature': sign(SECRET, raw) }, body: raw }).then((r) => r.json());
  assert.equal((await post()).status, 'result');
  assert.deepEqual(await post(), { status: 'refused', reason: 'already answered' });
  assert.equal(gateway.calls.length, 2);
});

test('cancelling the caller aborts the remote turn', async (t) => {
  let remoteSignal;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const { tool } = await twoDaemons(t, {
    answer: (input) => new Promise((resolve) => {
      remoteSignal = input.signal;
      started();
      input.signal.addEventListener('abort', () => resolve({ status: 'cancelled', messages: [] }));
    }),
  });
  const controller = new AbortController();
  const pending = tool.execute({ target: 'studio/nova', prompt: 'long task' }, session(), { signal: controller.signal });
  await running;
  controller.abort();
  const output = await pending;
  assert.equal(output.status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remoteSignal.aborted, true);
});

test('a peer that does not answer in time comes back as timed out, and one that is down as unreachable', async (t) => {
  const { tool } = await twoDaemons(t, {
    homeConfig: { timeoutMs: 100 },
    answer: (input) => new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({ status: 'cancelled', messages: [] }))),
  });
  const slow = await tool.execute({ target: 'studio/nova', prompt: 'x' }, session());
  assert.deepEqual([slow.status, slow.afterMs], ['timed out', 100]);

  const home = fakeContext({ ava: { down: SECRET } });
  await createPlugin({ self: 'home', peers: { down: { url: 'http://127.0.0.1:9' } } }).setup(home.context);
  const down = await home.tools[0].execute({ target: 'down/nova', prompt: 'x' }, session());
  assert.equal(down.status, 'unreachable');
});

test('stopping the channel aborts turns still running and closes the listener', async (t) => {
  let remoteSignal;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const { tool, studio, port } = await twoDaemons(t, {
    answer: (input) => new Promise((resolve) => {
      remoteSignal = input.signal;
      started();
      input.signal.addEventListener('abort', () => resolve({ status: 'cancelled', messages: [] }));
    }),
  });
  const pending = tool.execute({ target: 'studio/nova', prompt: 'x' }, session());
  await running;
  await studio.channels[0].adapter.stop();
  assert.equal(remoteSignal.aborted, true);
  const output = await pending;
  assert.notEqual(output.status, 'result');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/peer/v1/delegate`, { method: 'POST', body: '{}' }));
});

test('a reused session whose newest turn says nothing returns no answer, not the previous turn\'s', async (t) => {
  const history = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'answer to one' }];
  const { tool } = await twoDaemons(t, {
    answer: (input) => {
      history.push({ role: 'user', content: input.userMessage });
      if (input.userMessage === 'one') {
        return { status: 'completed', messages: history.slice(0, 2) };
      }
      history.push({ role: 'assistant', content: '' });
      return { status: 'completed', messages: [...history] };
    },
  });
  const first = await tool.execute({ target: 'studio/nova', prompt: 'one' }, session('conv-a'));
  assert.equal(first.answer, 'answer to one');
  const second = await tool.execute({ target: 'studio/nova', prompt: 'two' }, session('conv-a'));
  assert.equal(second.status, 'result');
  assert.equal(second.answer, '');
});

test('a peer whose body is still streaming at the deadline or on cancel keeps the timed out / cancelled outcome', async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"status":"res');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const home = fakeContext({ ava: { slow: SECRET } });
  await createPlugin({ self: 'home', timeoutMs: 150, peers: { slow: { url: `http://127.0.0.1:${server.address().port}` } } }).setup(home.context);
  const tool = home.tools[0];

  const timedOut = await tool.execute({ target: 'slow/nova', prompt: 'x' }, session());
  assert.deepEqual([timedOut.status, timedOut.afterMs], ['timed out', 150]);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const cancelled = await tool.execute({ target: 'slow/nova', prompt: 'x' }, session(), { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
});
