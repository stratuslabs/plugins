import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPlugin } from '../index.js';
import { connectBot } from '../lib/gateway.js';
import { png } from './png.js';
import { BOT, fakeDiscord } from './fake-discord.js';

const until = async (check, what) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const OWNER = '222222222222222222';
const STRANGER = '222222222222222223';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const DM = '777777777777777777';
const TOKEN = 'bot-token-ava';

/**
 * Enough of the Stratus gateway for an adapter: a bus, the roster and a
 * dispatch the test answers. `turns` holds each dispatch with `emit` (a bus
 * event for its session, while it is the running turn) and `finish(reply)`.
 */
const fakeGateway = (agents = ['ava']) => {
  const listeners = new Set();
  const turns = [];
  let active;
  const bus = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    },
  };
  return {
    bus,
    turns,
    listeners,
    agents: () => agents.map((id) => ({ id })),
    activeTurnId: () => active,
    dispatch(input) {
      return new Promise((resolve, reject) => {
        const turn = {
          input,
          start() {
            active = input.turnId;
            bus.emit({ type: 'session.updated', sessionId: input.sessionId, status: 'running' });
          },
          emit: (event) => bus.emit({ sessionId: input.sessionId, ...event }),
          finish(reply) {
            active = undefined;
            turn.settled = true;
            resolve({
              id: input.sessionId,
              status: 'completed',
              messages: [
                { role: 'user', content: input.userMessage, idempotencyKey: input.idempotencyKey },
                { role: 'assistant', content: reply },
              ],
            });
          },
          reject(error) {
            active = undefined;
            turn.settled = true;
            reject(error);
          },
        };
        turns.push(turn);
      });
    },
    resolutions: [],
    pending: new Set(),
    resolveApproval(input) {
      this.resolutions.push(input);
      if (!this.pending.has(input.requestId)) {
        return false;
      }
      this.pending.delete(input.requestId);
      bus.emit({ type: 'tool.approval-resolved', sessionId: 'any', requestId: input.requestId, answer: input.answer, reason: input.reason ?? 'decided', ...(input.actor ? { actor: input.actor } : {}) });
      return true;
    },
    aborts: [],
    abortTurns(sessionId, reason) {
      this.aborts.push({ sessionId, reason });
      return turns.filter((turn) => turn.input.sessionId === sessionId && !turn.settled).length;
    },
    /** Park a gated call the way the gateway does, and say so on the bus. */
    ask(fields) {
      this.pending.add(fields.requestId);
      bus.emit({ type: 'tool.approval-requested', agentId: 'ava', risk: 'gated', call: { id: 'c1', toolName: 'shell.run', input: { command: 'ls' } }, ...fields });
    },
  };
};

const config = {
  agents: {
    ava: { allowFrom: [OWNER], approvers: [OWNER], guilds: { [GUILD]: {} } },
  },
};

const setUp = async (t, { pluginConfig = config, secrets = { ava: { botToken: TOKEN } }, refuse, options = {}, warns = [] } = {}) => {
  const discord = await fakeDiscord(refuse ? { closeOnIdentify: refuse } : {});
  const registered = [];
  const plugin = createPlugin(pluginConfig, { api: discord.api, cdnHosts: [discord.cdn], drainTimeoutMs: 200, ...options });
  await plugin.setup({
    bus: undefined,
    tools: undefined,
    log: () => {},
    warn: (line) => warns.push(line),
    channels: {
      transportSecrets: async (kind) => {
        assert.equal(kind, 'discord');
        return secrets;
      },
      register: (contribution) => registered.push(contribution),
    },
  });
  const gateway = fakeGateway();
  t.after(async () => {
    for (const { adapter } of registered) await adapter.stop();
    await discord.close();
  });
  return { discord, registered, gateway };
};

const message = (fields) => ({
  id: '600000000000000001', content: 'hello', author: { id: OWNER, username: 'dylan', global_name: 'Dylan' },
  mentions: [], mention_roles: [], mention_everyone: false, ...fields,
});

test('the manifest declares the discord channel and the package exports the entry point', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.stratus.contributes.channels, [{ name: 'discord' }]);
  assert.equal(pkg.exports, './index.js');
  assert.equal(pkg.stratus.pluginVersion, 1);
});

test('a stored token with no approvers anywhere fails the load, naming the agent', async () => {
  const plugin = createPlugin({ agents: { ava: config.agents.ava } });
  const registered = [];
  await assert.rejects(plugin.setup({
    channels: {
      transportSecrets: async () => ({ ava: { botToken: TOKEN }, cy: { botToken: 'other' } }),
      register: (contribution) => registered.push(contribution),
    },
  }), /cy has no approvers/);
  assert.equal(registered.length, 0, 'nothing half-registered');
});

test('setup registers one discord adapter for the agents that have a token, under the defaults', async (t) => {
  const { registered } = await setUp(t, {
    pluginConfig: { approvers: [OWNER], agents: { ava: config.agents.ava, bo: { allowFrom: [OWNER] } } },
    secrets: { ava: { botToken: TOKEN }, cy: { botToken: 'other' } },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].adapter.name, 'discord');
  assert.deepEqual(registered[0].agents.sort(), ['ava', 'cy'], 'bo has no token; cy is covered by the defaults');
});

test('a host without a channel handle is refused at setup, saying why', async () => {
  await assert.rejects(createPlugin(config).setup({ log() {} }), /PluginContext\.channels/);
});

test('a DM from an allowed user becomes a turn, streams into the DM and ends with the reply', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  const adapter = registered[0].adapter;
  await adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  const [turn] = gateway.turns;
  assert.equal(turn.input.sessionId, `discord:ava:@dm:${DM}`);
  assert.equal(turn.input.agentId, 'ava');
  assert.equal(turn.input.userMessage, 'hello', 'a DM is not prefixed with a name');
  assert.equal(turn.input.idempotencyKey, 'discord:600000000000000001');
  assert.equal(turn.input.metadata.channel, 'discord');
  assert.equal(turn.input.metadata.senderTrust, 'user');
  assert.deepEqual(turn.input.metadata.conversation, { kind: 'direct', with: 'Dylan' });
  assert.equal(turn.input.metadata.discordChannel, DM);
  assert.ok(!JSON.stringify(turn.input).includes(TOKEN), 'the bot token never reaches the turn');

  turn.start();
  await until(() => discord.state.typing.length >= 1, 'typing');
  turn.emit({ type: 'provider.delta', delta: { type: 'text', text: 'Hi' } });
  await until(() => discord.state.posts.length === 1, 'the first words');
  assert.equal(discord.state.posts[0].channelId, DM);
  assert.equal(discord.state.posts[0].body.content, 'Hi');
  assert.equal(discord.state.posts[0].authorization, `Bot ${TOKEN}`);
  turn.emit({ type: 'provider.delta', delta: { type: 'text', text: ' there' } });
  turn.finish('Hi there, Dylan.');
  await until(() => discord.state.patches.some((patch) => patch.body.content === 'Hi there, Dylan.'), 'the final edit');
  assert.equal(discord.state.posts.length, 1, 'the reply edits the streamed message, not a second one');
});

test('a mention in a guild channel opens a thread on it and answers there, naming who spoke', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({
    id: '600000000000000002', guild_id: GUILD, channel_id: CHANNEL, content: `<@${BOT}> what's up?`,
    author: { id: STRANGER, username: 'sam' }, mentions: [{ id: BOT }],
  }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  const [turn] = gateway.turns;
  assert.equal(turn.input.sessionId, `discord:ava:${GUILD}:${CHANNEL}:600000000000000002`);
  assert.equal(turn.input.userMessage, "sam: what's up?", 'the bot mention is dropped and the speaker named');
  assert.equal(turn.input.metadata.senderTrust, 'unknown', 'not a principal');
  assert.equal(turn.input.metadata.conversation, undefined, 'a guild channel is not described as public or private without knowing');
  assert.equal(discord.state.threads.length, 1);
  assert.equal(discord.state.threads[0].messageId, '600000000000000002');
  const thread = discord.state.threads[0].id;
  assert.equal(turn.input.metadata.discordChannel, thread);
  turn.start();
  turn.finish('Not much.');
  await until(() => discord.state.posts.length === 1, 'the reply');
  assert.equal(discord.state.posts[0].channelId, thread);
  assert.deepEqual(discord.state.posts[0].body.allowed_mentions, { parse: [], replied_user: false });
});

test('a message admission refuses never becomes a turn', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000003', channel_id: DM, author: { id: STRANGER, username: 'sam' } }));
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000004', guild_id: GUILD, channel_id: CHANNEL, content: 'no mention' }));
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000005', channel_id: DM, content: 'allowed' }));
  await until(() => gateway.turns.length === 1, 'the allowed one');
  assert.equal(gateway.turns[0].input.userMessage, 'allowed');
});

test('a failed turn says why in the conversation', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  gateway.turns[0].reject(new Error('The provider is unavailable.'));
  await until(() => discord.state.posts.length === 1, 'the failure');
  assert.equal(discord.state.posts[0].body.content, '⚠ The provider is unavailable.');
});

test('a message absorbed into a running turn posts nothing of its own', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  const [turn] = gateway.turns;
  turn.input.onAbsorbed?.();
  turn.finish('the merged answer, posted by the leading message');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(discord.state.posts.length, 0);
});

test('stop disconnects the bot and leaves the bus', async (t) => {
  const { registered, gateway } = await setUp(t);
  const adapter = registered[0].adapter;
  await adapter.start(gateway);
  assert.equal(gateway.listeners.size, 1);
  await adapter.stop();
  assert.equal(gateway.listeners.size, 0);
});

const click = (discord, { requestId, answer, user, channelId = DM, messageId = '1', interactionId = '880000000000000001' }) =>
  discord.dispatch('INTERACTION_CREATE', {
    id: interactionId, token: `tok-${interactionId}`, type: 3, channel_id: channelId,
    data: { custom_id: `stratus:approval:${answer}:${requestId}`, component_type: 2 },
    message: { id: messageId }, user: { id: user },
  });

test('an approval is asked in the conversation, and an approver\'s click decides it', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  gateway.ask({ sessionId: `discord:ava:@dm:${DM}`, requestId: 'req-1', always: 'scope', metadata: { channel: 'discord', discordChannel: DM } });
  await until(() => discord.state.posts.length === 1, 'the prompt');
  const prompt = discord.state.posts[0];
  assert.equal(prompt.channelId, DM);
  assert.match(prompt.body.content, /wants to run `shell.run` \(gated\)/);
  assert.equal(prompt.body.components[0].components.length, 3);
  assert.deepEqual(prompt.body.allowed_mentions, { parse: [], replied_user: false });

  click(discord, { requestId: 'req-1', answer: 'always', user: OWNER });
  await until(() => discord.state.callbacks.length === 1, 'the click answered');
  assert.deepEqual(gateway.resolutions, [{ requestId: 'req-1', answer: 'always', actor: OWNER }]);
  assert.equal(discord.state.callbacks[0].body.type, 6, 'acknowledged without a message');
  assert.equal(discord.state.callbacks[0].authorization, undefined, 'answered with the interaction token, not the bot token');
  await until(() => discord.state.patches.length === 1, 'the prompt settled');
  assert.match(discord.state.patches[0].body.content, /Allowed, and this command's scope now runs without asking/);
  assert.deepEqual(discord.state.patches[0].body.components, [], 'no buttons left on a settled prompt');
});

test('someone who is not an approver is told so privately, and the request stays pending', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  gateway.ask({ sessionId: `discord:ava:@dm:${DM}`, requestId: 'req-2', metadata: { channel: 'discord', discordChannel: DM } });
  await until(() => discord.state.posts.length === 1, 'the prompt');
  click(discord, { requestId: 'req-2', answer: 'deny', user: STRANGER });
  await until(() => discord.state.callbacks.length === 1, 'the refusal');
  assert.equal(discord.state.callbacks[0].body.type, 4);
  assert.equal(discord.state.callbacks[0].body.data.flags, 64, 'ephemeral');
  assert.match(discord.state.callbacks[0].body.data.content, /not an approver/);
  assert.deepEqual(gateway.resolutions, []);
  assert.ok(gateway.pending.has('req-2'));
});

test('a request for another channel\'s conversation, or none, is left alone', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  gateway.ask({ sessionId: 'slack:ava:T1:C1:1', requestId: 'req-3', metadata: { channel: 'slack', slackChannel: 'C1' } });
  gateway.ask({ sessionId: 'cli', requestId: 'req-4' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(discord.state.posts.length, 0);
  assert.deepEqual(gateway.resolutions, [], 'not denied: another surface may be asking');
});

test('a request in a Discord conversation whose bot could not connect is denied as undeliverable, not left to time out', async (t) => {
  const { registered, gateway } = await setUp(t, { refuse: 4004 });
  await registered[0].adapter.start(gateway);
  gateway.ask({ sessionId: `discord:ava:@dm:${DM}`, requestId: 'req-5', metadata: { channel: 'discord', discordChannel: DM } });
  assert.deepEqual(gateway.resolutions, [{ requestId: 'req-5', answer: 'deny', reason: 'undeliverable' }]);
});

test('a click on a prompt nothing is waiting for says so and takes its buttons off', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  click(discord, { requestId: 'gone', answer: 'once', user: OWNER });
  await until(() => discord.state.callbacks.length === 1, 'the answer');
  assert.equal(discord.state.callbacks[0].body.type, 7, 'updates the message it was on');
  assert.deepEqual(discord.state.callbacks[0].body.data.components, []);
  assert.match(discord.state.callbacks[0].body.data.content, /no longer pending/);
});

test('an approver saying stop ends the running turn and the reply says who stopped it', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM, content: 'write me an essay' }));
  await until(() => gateway.turns.length === 1, 'the turn');
  const [turn] = gateway.turns;
  turn.start();
  turn.emit({ type: 'provider.delta', delta: { type: 'text', text: 'Once upon' } });
  await until(() => discord.state.posts.length === 1, 'streaming');
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000009', channel_id: DM, content: 'stop' }));
  await until(() => gateway.aborts.length === 1, 'the stop');
  assert.equal(gateway.aborts[0].sessionId, `discord:ava:@dm:${DM}`);
  assert.equal(turn.input.signal.aborted, true, 'the turn this adapter started is aborted too');
  assert.equal(gateway.turns.length, 1, 'the stop is not a turn of its own');
  turn.reject(new Error('aborted'));
  await until(() => discord.state.patches.some((patch) => /Stopped by Dylan/.test(patch.body.content)), 'the stopped reply');
  assert.match(discord.state.patches.at(-1).body.content, /^Once upon\n\n-# Stopped by Dylan\.$/);
});

test('stop from someone who is not an approver, or with nothing running, is an ordinary message', async (t) => {
  const { discord, registered, gateway } = await setUp(t, {
    pluginConfig: { agents: { ava: { allowFrom: [OWNER, STRANGER], approvers: [OWNER] } } },
  });
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM, content: 'stop', author: { id: STRANGER, username: 'sam' } }));
  await until(() => gateway.turns.length === 1, 'a turn');
  assert.equal(gateway.aborts.length, 0);
  gateway.turns[0].finish('ok');
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000010', channel_id: '777777777777777778', content: 'stop' }));
  await until(() => gateway.turns.length === 2, 'a second turn');
  assert.equal(gateway.turns[1].input.userMessage, 'stop');
});

test('stopping with a turn still running stops its typing too', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  const adapter = registered[0].adapter;
  await adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  gateway.turns[0].start();
  await until(() => discord.state.typing.length === 1, 'typing');
  await adapter.stop();
  const typed = discord.state.typing.length;
  await new Promise((resolve) => setTimeout(resolve, 8500));
  assert.equal(discord.state.typing.length, typed, 'no typing after stop');
});

// What Discord being down looks like from fetch: no status, a network cause.
const unreachable = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

test('a bot that cannot reach Discord at start keeps trying, and answers once it connects', async (t) => {
  let calls = 0;
  const warns = [];
  const connect = (options) => {
    calls += 1;
    return calls === 1 ? Promise.reject(unreachable()) : connectBot(options);
  };
  const { discord, registered, gateway } = await setUp(t, { warns, options: { connect, reconnectDelaysMs: [30] } });
  await registered[0].adapter.start(gateway);
  assert.match(warns.join('\n'), /ava could not connect: fetch failed\. Trying again in/);
  await until(() => discord.state.identifies.length === 1, 'the second attempt');
  assert.equal(calls, 2);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'a dispatch after the retry');
});

test('attempts back off along the delays, repeating the last', async (t) => {
  const at = [];
  const connect = () => {
    at.push(Date.now());
    return Promise.reject(unreachable());
  };
  const { registered, gateway } = await setUp(t, { options: { connect, reconnectDelaysMs: [20, 120] } });
  await registered[0].adapter.start(gateway);
  await until(() => at.length === 4, 'four attempts');
  const gaps = at.slice(1).map((time, i) => time - at[i]);
  assert.ok(gaps[0] < 100, `first wait is short (${gaps[0]}ms)`);
  assert.ok(gaps[1] >= 110 && gaps[2] >= 110, `then the last delay, again (${gaps})`);
});

test('a refused token is not retried', async (t) => {
  const warns = [];
  const { discord, registered, gateway } = await setUp(t, { refuse: 4004, warns, options: { reconnectDelaysMs: [20] } });
  await registered[0].adapter.start(gateway);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(discord.state.identifies.length, 1);
  assert.doesNotMatch(warns.join('\n'), /Trying again/);
});

test('stop cancels a wait for the next attempt, so it holds nothing open', async (t) => {
  let calls = 0;
  const connect = () => {
    calls += 1;
    return Promise.reject(unreachable());
  };
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const { registered, gateway } = await setUp(t, { options: { connect, reconnectDelaysMs: [60_000] } });
  const before = timers();
  await registered[0].adapter.start(gateway);
  assert.equal(timers(), before + 1, 'one wait for the next attempt');
  await registered[0].adapter.stop();
  assert.equal(timers(), before, 'a stopped daemon is not kept up for the wait');
  assert.equal(calls, 1);
});

test('an attempt that hangs is given up after the connect timeout and tried again; stop abandons one underway', async (t) => {
  const signals = [];
  const connect = ({ signal }) => {
    signals.push(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const warns = [];
  const { registered, gateway } = await setUp(t, { warns, options: { connect, connectTimeoutMs: 40, reconnectDelaysMs: [10] } });
  await registered[0].adapter.start(gateway);
  assert.equal(signals[0].aborted, true, 'the first attempt was given up');
  assert.match(warns.join('\n'), /ava could not connect: no answer from Discord in 40ms\. Trying again in/);
  await until(() => signals.length === 2, 'a second attempt');
  await registered[0].adapter.stop();
  assert.equal(signals[1].aborted, true, 'stop abandons the attempt underway');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(signals.length, 2, 'and nothing is tried after stop');
});

const file = (discord, name, bytes, fields = {}) => {
  discord.state.files[name] = bytes;
  return { id: `9${name.length}`, filename: name, size: bytes.length, url: `${discord.cdn}/cdn/${name}`, ...fields };
};

test('an image and a text file in a DM reach the turn: the image on the dispatch, the text in the message', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  const image = png(2, 2);
  discord.dispatch('MESSAGE_CREATE', message({
    channel_id: DM,
    content: 'what do you make of these?',
    attachments: [
      file(discord, 'shot.png', image, { content_type: 'image/png', width: 2, height: 2 }),
      file(discord, 'notes.txt', Buffer.from('line one\n'), { content_type: 'text/plain; charset=utf-8' }),
      file(discord, 'report.pdf', Buffer.from('%PDF'), { content_type: 'application/pdf' }),
    ],
  }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  const { input } = gateway.turns[0];
  assert.deepEqual(input.images, [{ mediaType: 'image/png', data: image.toString('base64'), name: 'shot.png' }]);
  assert.equal(input.userMessage, 'what do you make of these?\n[Attached: notes.txt. Its contents follow.]\nline one\n[End of notes.txt]\n[Attached, name only: report.pdf (not a kind of file that can be read here). You have only the names, so say so rather than guessing at what is in them.]');
  assert.deepEqual(discord.state.downloads.map((d) => d.name).sort(), ['notes.txt', 'shot.png']);
  assert.ok(discord.state.downloads.every((d) => d.authorization === undefined), 'the bot token never goes to the CDN');
});

test('an image with nothing said is still a question; a file nothing here opens, with nothing said, is not', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000010', channel_id: DM, content: '', attachments: [file(discord, 'x.zip', Buffer.from('PK'), { content_type: 'application/zip' })] }));
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000011', channel_id: DM, content: '', attachments: [file(discord, 'y.png', png(1, 1), { content_type: 'image/png' })] }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(gateway.turns.length, 1);
  assert.equal(gateway.turns[0].input.idempotencyKey, 'discord:600000000000000011');
  assert.equal(gateway.turns[0].input.userMessage, '');
  assert.equal(gateway.turns[0].input.images.length, 1);
});

test('in a guild channel an image-only message says who sent it', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({
    guild_id: GUILD, channel_id: CHANNEL, content: `<@${BOT}>`, mentions: [{ id: BOT }],
    attachments: [file(discord, 'z.png', png(1, 1), { content_type: 'image/png' })],
  }));
  await until(() => gateway.turns.length === 1, 'a dispatch');
  assert.equal(gateway.turns[0].input.userMessage, 'Dylan:');
});

test('a message admission refuses has its attachments left undownloaded', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  await registered[0].adapter.start(gateway);
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM, author: { id: STRANGER, username: 'sam' }, attachments: [file(discord, 's.png', png(1, 1), { content_type: 'image/png' })] }));
  discord.dispatch('MESSAGE_CREATE', message({ id: '600000000000000012', channel_id: DM, content: 'after' }));
  await until(() => gateway.turns.length === 1, 'the later message');
  assert.deepEqual(discord.state.downloads, []);
});

test('stopping while a message\'s attachments download leaves it unanswered, for the next start', async (t) => {
  const { discord, registered, gateway } = await setUp(t);
  const adapter = registered[0].adapter;
  await adapter.start(gateway);
  discord.state.fileDelayMs = 3000;
  discord.dispatch('MESSAGE_CREATE', message({ channel_id: DM, content: 'look', attachments: [file(discord, 'slow.png', png(1, 1), { content_type: 'image/png' })] }));
  await until(() => discord.state.downloads.length === 1, 'the download to start');
  const started = Date.now();
  await adapter.stop();
  assert.ok(Date.now() - started < 1000, 'stop does not wait out the download');
  assert.equal(gateway.turns.length, 0, 'not answered with the image missing');
});
