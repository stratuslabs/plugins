import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlugin } from '../index.js';
import { BOT, fakeDiscord } from './fake-discord.js';

// A turn this adapter did not start: a turn another surface ran in a
// Discord conversation, or one the restart's recovery finished. Nobody here is rendering it, so its reply is posted
// from the session's routing, as channel-slack's `reportUnrenderedReply`.

const until = async (check, what) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const OWNER = '222222222222222222';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const THREAD = '555555555555555555';
const ROOT = '666666666666666666';
const DM = '777777777777777777';
const TOKEN = 'bot-token-ava';

const DM_SESSION = `discord:ava:@dm:${DM}`;
const THREAD_SESSION = `discord:ava:${GUILD}:${CHANNEL}:${THREAD}`;
const IN_CHANNEL_SESSION = `discord:ava:${GUILD}:${CHANNEL}:${ROOT}`;

/**
 * Enough of the gateway for these turns. As the real one does, a turn's
 * `session.completed` is emitted while it is still the session's active
 * turn: a dispatch's own completion names the dispatch's `turnId`.
 */
const fakeGateway = () => {
  const listeners = new Set();
  const turns = [];
  const routing = new Map();
  const routingReads = [];
  let active;
  const emit = (event) => {
    for (const fn of listeners) fn(event);
  };
  const completed = (sessionId) => emit({ type: 'session.completed', sessionId, usage: [] });
  return {
    bus: {
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    turns,
    routing,
    routingReads,
    agents: () => [{ id: 'ava' }],
    activeTurnId: () => active,
    async sessionRouting(sessionId) {
      routingReads.push(sessionId);
      return routing.get(sessionId);
    },
    resolveApproval: () => false,
    /** A turn nobody dispatched through this adapter finishes on `sessionId`. */
    finishForeign(sessionId, turnId = 'not-this-adapters') {
      active = turnId;
      completed(sessionId);
      active = undefined;
    },
    dispatch(input) {
      return new Promise((resolve) => {
        turns.push({
          input,
          /** Runs as this dispatch's own turn and answers `reply`. */
          run(reply) {
            active = input.turnId;
            emit({ type: 'session.updated', sessionId: input.sessionId, status: 'running' });
            emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: reply } });
            completed(input.sessionId);
            active = undefined;
            resolve({ id: input.sessionId, status: 'completed', messages: [
              { role: 'user', content: input.userMessage, idempotencyKey: input.idempotencyKey },
              { role: 'assistant', content: reply },
            ] });
          },
          /** A repeat of a turn that is over: nothing runs, the session is as it stands. */
          repeatFinished(messages) {
            input.onRepeat?.('finished');
            resolve({ id: input.sessionId, status: 'completed', messages });
          },
        });
      });
    },
  };
};

const config = { agents: { ava: { allowFrom: [OWNER], approvers: [OWNER], guilds: { [GUILD]: {} } } } };

const setUp = async (t) => {
  const discord = await fakeDiscord();
  const registered = [];
  const logs = [];
  const warns = [];
  const plugin = createPlugin(config, { api: discord.api, cdnHosts: [discord.cdn], drainTimeoutMs: 200 });
  await plugin.setup({
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    channels: {
      transportSecrets: async () => ({ ava: { botToken: TOKEN } }),
      register: (contribution) => registered.push(contribution),
    },
  });
  const gateway = fakeGateway();
  const adapter = registered[0].adapter;
  t.after(async () => {
    await adapter.stop();
    await discord.close();
  });
  await adapter.start(gateway);
  await until(() => logs.some((line) => /ava connected as bot/.test(line)), 'the bot to connect');
  return { discord, gateway, adapter, logs, warns };
};

const routingFor = (fields, reply) => ({
  agentId: 'ava',
  metadata: { channel: 'discord', team: GUILD, discordUser: OWNER, senderTrust: 'user', ...fields },
  ...(reply !== undefined ? { reply } : {}),
});

test('a turn nobody here was rendering posts its reply into the thread it came from', async (t) => {
  const { discord, gateway } = await setUp(t);
  gateway.routing.set(THREAD_SESSION, routingFor({ discordChannel: THREAD, discordConversation: CHANNEL, discordThread: THREAD }, 'The task finished: 3 files changed.'));

  gateway.finishForeign(THREAD_SESSION);

  await until(() => discord.state.posts.length === 1, 'the reply');
  const [post] = discord.state.posts;
  assert.equal(post.channelId, THREAD);
  assert.equal(post.body.content, 'The task finished: 3 files changed.');
  assert.equal(post.authorization, `Bot ${TOKEN}`, 'posted by the agent\'s own bot');
  assert.deepEqual(post.body.allowed_mentions, { parse: [], replied_user: false }, 'pings nobody, like every answer');
  assert.equal(post.body.message_reference, undefined, 'a thread needs no reply reference');
});

test('a DM\'s reply goes to the DM, split into Discord-sized messages', async (t) => {
  const { discord, gateway } = await setUp(t);
  const long = `${'a'.repeat(1990)}\n${'b'.repeat(500)}`;
  gateway.routing.set(DM_SESSION, routingFor({ team: '@dm', discordChannel: DM, discordConversation: DM, conversation: { kind: 'direct' } }, long));

  gateway.finishForeign(DM_SESSION);

  await until(() => discord.state.posts.length === 2, 'both parts');
  assert.ok(discord.state.posts.every((post) => post.channelId === DM));
  assert.equal(discord.state.posts.map((post) => post.body.content).join('\n'), long);
  assert.ok(discord.state.posts.every((post) => post.body.message_reference === undefined), 'a DM is no in-channel conversation');
});

test('an in-channel conversation\'s reply answers under its first message, and a reply to it carries the conversation on', async (t) => {
  const { discord, gateway } = await setUp(t);
  gateway.routing.set(IN_CHANNEL_SESSION, routingFor({ discordChannel: CHANNEL, discordConversation: CHANNEL, discordThread: ROOT }, 'Done.'));

  gateway.finishForeign(IN_CHANNEL_SESSION);

  await until(() => discord.state.posts.length === 1, 'the reply');
  const [post] = discord.state.posts;
  assert.equal(post.channelId, CHANNEL);
  assert.deepEqual(post.body.message_reference, { message_id: ROOT, fail_if_not_exists: false });

  discord.dispatch('MESSAGE_CREATE', {
    id: '600000000000000009', channel_id: CHANNEL, guild_id: GUILD, content: 'and the tests?',
    author: { id: OWNER, username: 'dylan' }, mentions: [], mention_roles: [], mention_everyone: false,
    referenced_message: { id: post.id, author: { id: BOT } },
  });
  await until(() => gateway.turns.length === 1, 'the follow-up');
  assert.equal(gateway.turns[0].input.sessionId, IN_CHANNEL_SESSION, 'the follow-up is the same conversation');
});

test('nothing is posted for another channel\'s session, a turn with no reply, or an agent with no bot here', async (t) => {
  const { discord, gateway, warns } = await setUp(t);
  gateway.routing.set(DM_SESSION, routingFor({ discordChannel: DM, discordConversation: DM }));
  gateway.routing.set(THREAD_SESSION, routingFor({ discordChannel: THREAD, discordConversation: CHANNEL, discordThread: THREAD }, '   '));
  gateway.routing.set('discord:bo:@dm:888888888888888888', { ...routingFor({ discordChannel: '888888888888888888' }, 'Hi.'), agentId: 'bo' });
  gateway.routing.set('discord:ava:elsewhere', { agentId: 'ava', metadata: { channel: 'slack', discordChannel: DM }, reply: 'Hi.' });

  gateway.finishForeign(DM_SESSION);
  gateway.finishForeign(THREAD_SESSION);
  gateway.finishForeign('discord:bo:@dm:888888888888888888');
  gateway.finishForeign('discord:ava:elsewhere');
  gateway.finishForeign('discord:ava:gone');
  gateway.finishForeign('slack:ava:T1:C1:1.0');
  await settle();

  assert.equal(discord.state.posts.length, 0);
  assert.ok(!gateway.routingReads.includes('slack:ava:T1:C1:1.0'), 'a session that is not a Discord one is not even read');
  assert.ok(warns.some((line) => /bo has no Discord connection/.test(line)), 'the reply an agent without a bot could not post is said out loud');
});

test('the adapter\'s own turn is answered once: its completion is not reported as nobody\'s', async (t) => {
  const { discord, gateway } = await setUp(t);
  gateway.routing.set(DM_SESSION, routingFor({ discordChannel: DM, discordConversation: DM }, 'Hi there.'));
  discord.dispatch('MESSAGE_CREATE', {
    id: '600000000000000001', channel_id: DM, content: 'hello',
    author: { id: OWNER, username: 'dylan' }, mentions: [], mention_roles: [], mention_everyone: false,
  });
  await until(() => gateway.turns.length === 1, 'a dispatch');

  gateway.turns[0].run('Hi there.');

  await until(() => discord.state.posts.length === 1, 'the answer');
  await settle();
  assert.equal(discord.state.posts.length, 1, 'one answer, not a second from the report');
  assert.deepEqual(gateway.routingReads, [], 'a rendered turn is never looked up');
});

const redelivered = async (t, { refuseReport = false, olderMessage = false } = {}) => {
  const setup = await setUp(t);
  const { discord, gateway } = setup;
  gateway.routing.set(DM_SESSION, routingFor({ discordChannel: DM, discordConversation: DM }, 'Approved, and done.'));
  // The message a turn parked on approval answered, read again after a restart
  // and queued behind the recovery that is finishing that turn.
  discord.dispatch('MESSAGE_CREATE', {
    id: '600000000000000001', channel_id: DM, content: 'deploy it',
    author: { id: OWNER, username: 'dylan' }, mentions: [], mention_roles: [], mention_everyone: false,
  });
  await until(() => gateway.turns.length === 1, 'the redelivery');
  if (refuseReport) {
    discord.state.refusePosts = true;
  }
  gateway.finishForeign(DM_SESSION, 'recovery');
  await settle();
  discord.state.refusePosts = false;
  const keyed = { role: 'user', content: 'deploy it', idempotencyKey: 'discord:600000000000000001' };
  gateway.turns[0].repeatFinished(olderMessage
    ? [keyed, { role: 'assistant', content: 'Earlier answer.' }, { role: 'user', content: 'from the CLI' }, { role: 'assistant', content: 'Approved, and done.' }]
    : [keyed, { role: 'assistant', content: 'Approved, and done.' }]);
  await settle();
  return setup;
};

test('a redelivery queued behind the reported turn posts nothing more', async (t) => {
  const { discord } = await redelivered(t);
  assert.deepEqual(discord.state.posts.map((post) => post.body.content), ['Approved, and done.']);
  assert.equal(discord.state.patches.length, 0);
});

test('a redelivery posts the reply itself when the report did not reach Discord', async (t) => {
  const { discord, warns } = await redelivered(t, { refuseReport: true });
  assert.ok(warns.some((line) => /could not post the reply of a turn nobody here was rendering/.test(line)));
  assert.deepEqual(discord.state.posts.map((post) => post.body.content), ['Approved, and done.']);
});

test('a redelivery whose own turn is not the one reported still posts its own reply', async (t) => {
  const { discord } = await redelivered(t, { olderMessage: true });
  assert.deepEqual(discord.state.posts.map((post) => post.body.content), ['Approved, and done.', 'Earlier answer.']);
});
