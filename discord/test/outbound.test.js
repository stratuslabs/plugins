import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlugin } from '../index.js';
import { BOT, fakeDiscord } from './fake-discord.js';

const OWNER = '222222222222222222';
const STRANGER = '222222222222222223';
const GUILD = '333333333333333333';
const OTHER_GUILD = '333333333333333334';
const CHANNEL = '444444444444444444';
const LISTED = '444444444444444445';
const UNLISTED = '444444444444444446';
const FORUM = '444444444444444447';
const THREAD = '555555555555555555';
const ELSEWHERE_THREAD = '555555555555555556';
const DM = '777777777777777777';
const STRANGER_DM = '777777777777777778';
const LISTED_GUILD = '333333333333333335';

const config = {
  approvers: [OWNER],
  allowFrom: [OWNER],
  guilds: { [GUILD]: {}, [LISTED_GUILD]: { channels: { [LISTED]: {} } } },
};

const channels = {
  [CHANNEL]: { id: CHANNEL, type: 0, guild_id: GUILD },
  [LISTED]: { id: LISTED, type: 0, guild_id: LISTED_GUILD },
  [UNLISTED]: { id: UNLISTED, type: 0, guild_id: LISTED_GUILD },
  [FORUM]: { id: FORUM, type: 15, guild_id: GUILD },
  [THREAD]: { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHANNEL, message_count: 2 },
  [ELSEWHERE_THREAD]: { id: ELSEWHERE_THREAD, type: 11, guild_id: GUILD, parent_id: FORUM },
  '444444444444444448': { id: '444444444444444448', type: 0, guild_id: OTHER_GUILD },
  [DM]: { id: DM, type: 1, recipients: [{ id: OWNER, username: 'dylan' }] },
  [STRANGER_DM]: { id: STRANGER_DM, type: 1, recipients: [{ id: STRANGER, username: 'who' }] },
};

const setUp = async (t, { secrets = { ava: { botToken: 'bot-token-ava' } } } = {}) => {
  const discord = await fakeDiscord();
  Object.assign(discord.state.channels, structuredClone(channels));
  const registered = [];
  await createPlugin(config, { api: discord.api, drainTimeoutMs: 200 }).setup({
    log: () => {},
    warn: () => {},
    channels: { transportSecrets: async () => secrets, register: (contribution) => registered.push(contribution) },
  });
  const adapter = registered[0].adapter;
  await adapter.start({ bus: { subscribe: () => () => {} }, agents: () => [{ id: 'ava' }, { id: 'bo' }] });
  t.after(async () => {
    await adapter.stop();
    await discord.close();
  });
  return { discord, adapter };
};

const at = (id) => new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
const msg = (id, fields = {}) => ({
  id, type: 0, content: `message ${id}`, timestamp: at(id),
  author: { id: OWNER, username: 'dylan', global_name: 'Dylan' }, mentions: [], attachments: [], ...fields,
});

test('a guild channel in a configured guild is a destination: posts there, pinging nobody, and returns the first id', async (t) => {
  const { discord, adapter } = await setUp(t);
  const connection = await adapter.resolveOutbound({ agentId: 'ava', to: CHANNEL });
  const ref = await connection.post(`report\n${'x'.repeat(2500)}`);
  assert.equal(discord.state.posts.length, 2, 'split to Discord-sized messages');
  for (const post of discord.state.posts) {
    assert.equal(post.channelId, CHANNEL);
    assert.deepEqual(post.body.allowed_mentions.parse, []);
    assert.equal(post.authorization, 'Bot bot-token-ava');
  }
  assert.equal(ref.channel, CHANNEL);
  assert.match(ref.ts, /^\d+$/);
  await connection.edit(ref, 'edited');
  assert.deepEqual(discord.state.patches.map((p) => [p.channelId, p.messageId, p.body.content]), [[CHANNEL, ref.ts, 'edited']]);
});

test('an empty post still says something', async (t) => {
  const { discord, adapter } = await setUp(t);
  await (await adapter.resolveOutbound({ agentId: 'ava', to: CHANNEL })).post('   ');
  assert.equal(discord.state.posts[0].body.content, '(empty message)');
});

test('a destination the agent could not deliver to is refused at resolve, with why', async (t) => {
  const { discord, adapter } = await setUp(t);
  const refused = async (address, pattern) => {
    await assert.rejects(adapter.resolveOutbound({ agentId: 'ava', ...address }), pattern);
  };
  await assert.rejects(adapter.resolveOutbound({ agentId: 'bo', to: CHANNEL }), /bo has no Discord bot/);
  await refused({ to: 'general' }, /a Discord channel id/);
  await refused({ to: '999999999999999990' }, /cannot see 999999999999999990/);
  await refused({ to: '444444444444444448' }, /not one this agent works in/);
  await refused({ to: UNLISTED }, /not one of the channels this agent works in/);
  await refused({ to: FORUM }, /can't be posted in directly/);
  await refused({ to: STRANGER_DM }, /a DM with someone not in allowFrom or approvers/);
  await refused({ to: CHANNEL, thread: ELSEWHERE_THREAD }, /not a thread in 444444444444444444/);
  await refused({ to: CHANNEL, thread: '600000000000000009' }, /no thread or message 600000000000000009 in 444444444444444444/);
  assert.equal(discord.state.posts.length, 0, 'nothing was sent while checking');
});

test('a listed channel, a DM with an allowed person and a thread in the channel are destinations', async (t) => {
  const { discord, adapter } = await setUp(t);
  await (await adapter.resolveOutbound({ agentId: 'ava', to: LISTED })).post('a');
  await (await adapter.resolveOutbound({ agentId: 'ava', to: DM })).post('b');
  await (await adapter.resolveOutbound({ agentId: 'ava', to: CHANNEL, thread: THREAD })).post('c');
  assert.deepEqual(discord.state.posts.map((p) => [p.channelId, p.body.content, p.body.message_reference]), [
    [LISTED, 'a', undefined],
    [DM, 'b', undefined],
    [THREAD, 'c', undefined],
  ]);
});

test('a thread naming a message with no thread replies under that message', async (t) => {
  const { discord, adapter } = await setUp(t);
  discord.state.history[CHANNEL] = [msg('600000000000000001')];
  await (await adapter.resolveOutbound({ agentId: 'ava', to: CHANNEL, thread: '600000000000000001' })).post(`one\n${'y'.repeat(2500)}`);
  assert.equal(discord.state.posts.length, 2);
  assert.equal(discord.state.posts[0].channelId, CHANNEL);
  assert.equal(discord.state.posts[0].body.message_reference.message_id, '600000000000000001');
  assert.equal(discord.state.posts[0].body.allowed_mentions.replied_user, false);
});

test('a channel read is newest first, plain text, bounded, and says when there is more', async (t) => {
  const { discord, adapter } = await setUp(t);
  discord.state.history[CHANNEL] = [
    msg('600000000000000001'),
    msg('600000000000000002', { content: `hi <@${BOT}> and <@!${STRANGER}>, see <#${LISTED}> :) <:party:123456789012345678> at <t:1792800000:R> <@&123456789012345679>`, mentions: [{ id: BOT, username: 'ava', bot: true }, { id: STRANGER, username: 'who', global_name: 'Who' }] }),
    msg('600000000000000003', { type: 7, content: '' }),
    msg('600000000000000004', { content: '', attachments: [{ id: '1', filename: 'screen.png' }], author: { id: BOT, username: 'ava', bot: true } }),
    msg('600000000000000005', { thread: { id: '600000000000000005', message_count: 3 } }),
  ];
  const all = await adapter.readConversation({ agentId: 'ava', conversation: CHANNEL, limit: 10 });
  assert.equal(all.more, false);
  assert.deepEqual(all.messages.map((m) => m.id), ['600000000000000005', '600000000000000004', '600000000000000002', '600000000000000001'], 'a join notice is not a message');
  const [root, file, mentions] = all.messages;
  assert.equal(root.replies, 3);
  assert.equal(root.thread, undefined);
  assert.deepEqual(file.files, ['screen.png']);
  assert.equal(file.author, BOT);
  assert.equal(file.authorName, 'ava');
  assert.equal(mentions.text, `hi @ava and @Who, see #${LISTED} :) :party: at 2026-10-24T00:00:00.000Z @role:123456789012345679`);
  assert.equal(mentions.authorName, 'Dylan');
  assert.equal(mentions.at, at('600000000000000002'));

  const two = await adapter.readConversation({ agentId: 'ava', conversation: CHANNEL, limit: 2 });
  assert.deepEqual(two.messages.map((m) => m.id), ['600000000000000005', '600000000000000004']);
  assert.equal(two.more, true);
  const window = await adapter.readConversation({ agentId: 'ava', conversation: CHANNEL, after: '600000000000000001', before: '600000000000000005', limit: 10 });
  assert.deepEqual(window.messages.map((m) => m.id), ['600000000000000004', '600000000000000002']);
  assert.equal(window.more, false);
});

test('a thread read is its root then its replies, oldest first, in pages past 100', async (t) => {
  const { discord, adapter } = await setUp(t);
  discord.state.history[CHANNEL] = [msg(THREAD, { content: 'the question', thread: { id: THREAD, message_count: 2 } })];
  const replies = [msg('555555555555555556', { type: 21, content: '' })];
  for (let i = 0; i < 150; i += 1) {
    replies.push(msg(String(600000000000000000n + BigInt(i)), { content: `reply ${i}` }));
  }
  discord.state.history[THREAD] = replies;
  const read = await adapter.readConversation({ agentId: 'ava', conversation: CHANNEL, thread: THREAD, limit: 120 });
  assert.equal(read.messages.length, 120);
  assert.equal(read.more, true);
  assert.equal(read.messages[0].text, 'the question');
  assert.equal(read.messages[0].replies, 2);
  assert.equal(read.messages[1].text, 'reply 0');
  assert.equal(read.messages[119].text, 'reply 118');
  assert.ok(read.messages.slice(1).every((m) => m.thread === THREAD));
  const after = await adapter.readConversation({ agentId: 'ava', conversation: CHANNEL, thread: THREAD, after: '600000000000000147', limit: 10 });
  assert.deepEqual(after.messages.map((m) => m.text), ['reply 148', 'reply 149'], 'the root is before the window');
  assert.equal(after.more, false);
});

test('a read is refused for a DM, a guild it does not work in, a thread elsewhere and an agent with no bot', async (t) => {
  const { adapter } = await setUp(t);
  await assert.rejects(adapter.readConversation({ agentId: 'ava', conversation: DM, limit: 5 }), /direct message, and direct messages are never read from outside them/);
  await assert.rejects(adapter.readConversation({ agentId: 'ava', conversation: '444444444444444448', limit: 5 }), /not one this agent works in/);
  await assert.rejects(adapter.readConversation({ agentId: 'ava', conversation: UNLISTED, limit: 5 }), /not one of the channels/);
  await assert.rejects(adapter.readConversation({ agentId: 'ava', conversation: CHANNEL, thread: ELSEWHERE_THREAD, limit: 5 }), /not a thread in/);
  await assert.rejects(adapter.readConversation({ agentId: 'bo', conversation: CHANNEL, limit: 5 }), /bo has no Discord bot/);
});

test('conversationKindFor asks Discord, keeps definite answers and says nothing for what it cannot see', async (t) => {
  const { discord, adapter } = await setUp(t);
  assert.equal(await adapter.conversationKindFor('ava', DM), 'direct');
  assert.equal(await adapter.conversationKindFor('ava', CHANNEL), 'channel');
  assert.equal(await adapter.conversationKindFor('ava', THREAD), 'channel');
  assert.equal(await adapter.conversationKindFor('ava', '999999999999999990'), undefined);
  assert.equal(await adapter.conversationKindFor('ava', 'general'), undefined);
  assert.equal(await adapter.conversationKindFor('bo', CHANNEL), undefined);
  const asked = discord.state.gets.length;
  assert.equal(await adapter.conversationKindFor('ava', DM), 'direct');
  assert.equal(discord.state.gets.length, asked, 'cached');
});

test('a destination takes a file: uploaded into the thread it names', async (t) => {
  const { discord, adapter } = await setUp(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-out-'));
  const file = path.join(dir, 'report.csv');
  await writeFile(file, 'a,b\n1,2\n');
  const connection = await adapter.resolveOutbound({ agentId: 'ava', to: CHANNEL, thread: THREAD });
  await connection.upload(file, 'Weekly report');
  const [post] = discord.state.posts;
  assert.equal(post.channelId, THREAD);
  assert.equal(post.body.content, 'Weekly report');
  assert.deepEqual(post.files.map((f) => [f.name, f.bytes.toString()]), [['report.csv', 'a,b\n1,2\n']]);
});
