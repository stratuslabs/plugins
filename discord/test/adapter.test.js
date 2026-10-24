import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPlugin } from '../index.js';
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
            reject(error);
          },
        };
        turns.push(turn);
      });
    },
    resolveApproval: () => false,
  };
};

const config = {
  agents: {
    ava: { allowFrom: [OWNER], approvers: [OWNER], guilds: { [GUILD]: {} } },
  },
};

const setUp = async (t, { pluginConfig = config, secrets = { ava: { botToken: TOKEN } } } = {}) => {
  const discord = await fakeDiscord();
  const registered = [];
  const plugin = createPlugin(pluginConfig, { api: discord.api, drainTimeoutMs: 200 });
  await plugin.setup({
    bus: undefined,
    tools: undefined,
    log: () => {},
    warn: () => {},
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
