import assert from 'node:assert/strict';
import test from 'node:test';
import { connectBot, INTENTS } from '../lib/gateway.js';
import { postText, editText, threadFrom, typing } from '../lib/send.js';
import { BOT, fakeDiscord } from './fake-discord.js';

const until = async (check, what) => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const USER = '222222222222222222';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const THREAD = '555555555555555555';

test('the bot identifies with its token and the four intents, and hands on messages in the adapter form', async (t) => {
  const discord = await fakeDiscord();
  const seen = [];
  const bot = await connectBot({ token: 'bot-token-a', api: discord.api, onMessage: (message) => seen.push(message) });
  t.after(async () => {
    await bot.close();
    await discord.close();
  });
  assert.equal(bot.botId, BOT);
  assert.deepEqual(discord.state.identifies, [{ token: 'bot-token-a', intents: INTENTS }]);
  assert.equal(INTENTS, 1 | 512 | 4096 | 32768, 'Guilds, GuildMessages, DirectMessages, MessageContent');

  discord.dispatch('THREAD_CREATE', { id: THREAD, type: 11, parent_id: CHANNEL, guild_id: GUILD });
  discord.dispatch('MESSAGE_CREATE', {
    id: '600000000000000001', guild_id: GUILD, channel_id: THREAD, content: 'hi <@111111111111111111>',
    author: { id: USER }, mentions: [{ id: BOT }], mention_roles: [], mention_everyone: false,
  });
  discord.dispatch('MESSAGE_CREATE', { id: '600000000000000002', channel_id: '777777777777777777', content: 'dm', author: { id: USER }, mentions: [] });
  await until(() => seen.length === 2, 'two messages');
  assert.deepEqual(seen[0], {
    id: '600000000000000001', guildId: GUILD, channelId: THREAD, parentId: CHANNEL, authorId: USER, authorIsBot: false,
    mentions: [BOT], mentionsRoleOrEveryone: false, content: 'hi <@111111111111111111>',
  });
  assert.equal(seen[1].guildId, undefined, 'a DM has no guild');
});

test('a dropped connection resumes the same session from the last sequence, and messages keep coming', async (t) => {
  const discord = await fakeDiscord();
  const seen = [];
  const bot = await connectBot({ token: 'bot-token-a', api: discord.api, onMessage: (message) => seen.push(message.id) });
  t.after(async () => {
    await bot.close();
    await discord.close();
  });
  discord.dispatch('MESSAGE_CREATE', { id: '600000000000000003', channel_id: CHANNEL, guild_id: GUILD, content: 'one', author: { id: USER }, mentions: [] });
  await until(() => seen.length === 1, 'the first message');
  const lastSeq = discord.state.seq;
  discord.drop();
  await until(() => discord.state.resumes.length === 1, 'a resume');
  assert.deepEqual(discord.state.resumes[0], { token: 'bot-token-a', sessionId: 'session-1', seq: lastSeq });
  assert.equal(discord.state.identifies.length, 1, 'resumed, not identified again');
  assert.match(discord.state.sockets.at(-1), /^\/resume/, 'at the resume URL Discord gave');
  discord.dispatch('MESSAGE_CREATE', { id: '600000000000000004', channel_id: CHANNEL, guild_id: GUILD, content: 'two', author: { id: USER }, mentions: [] });
  await until(() => seen.length === 2, 'a message after the resume');
});

test('a refused Message Content intent fails the connection with the Developer Portal toggle to flip', async () => {
  const discord = await fakeDiscord({ closeOnIdentify: 4014 });
  try {
    await assert.rejects(
      connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {} }),
      /Message Content Intent.*Developer Portal/,
    );
  } finally {
    await discord.close();
  }
});

test('a refused token says how to store a new one', async () => {
  const discord = await fakeDiscord({ closeOnIdentify: 4004 });
  try {
    await assert.rejects(connectBot({ token: 'bad', api: discord.api, onMessage: () => {} }), /stratus channel set discord/);
  } finally {
    await discord.close();
  }
});

test('replies are chunked, ping nobody, suppress link previews and reply to the message that asked', async (t) => {
  const discord = await fakeDiscord();
  const bot = await connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {} });
  t.after(async () => {
    await bot.close();
    await discord.close();
  });
  const ids = await postText(bot.rest, CHANNEL, `@everyone ${'x'.repeat(2500)}`, { replyTo: '600000000000000001' });
  assert.equal(ids.length, 2);
  const [first, second] = discord.state.posts;
  assert.equal(first.authorization, 'Bot bot-token-a');
  assert.deepEqual(first.body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(first.body.flags, 4);
  assert.deepEqual(first.body.message_reference, { message_id: '600000000000000001', fail_if_not_exists: false });
  assert.equal(second.body.message_reference, undefined, 'only the first part replies');
  assert.ok(first.body.content.length <= 2000 && second.body.content.length <= 2000);
  assert.equal(first.body.content + second.body.content, `@everyone ${'x'.repeat(2500)}`, 'nothing lost');

  await editText(bot.rest, CHANNEL, ids[0], 'edited');
  assert.deepEqual(discord.state.patches[0], { channelId: CHANNEL, messageId: ids[0], body: { content: 'edited', allowed_mentions: { parse: [], replied_user: false } } });
  await typing(bot.rest, CHANNEL);
  assert.deepEqual(discord.state.typing, [CHANNEL]);
  const thread = await threadFrom(bot.rest, CHANNEL, '600000000000000001', '  ');
  assert.equal(discord.state.threads[0].body.name, 'Conversation');
  assert.equal(thread, discord.state.threads[0].id);
});
