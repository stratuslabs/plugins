import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { connectBot, INTENTS, stopManager } from '../lib/gateway.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { postText, editText, threadFrom, typing, uploadFile, UPLOAD_MAX_BYTES } from '../lib/send.js';
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

// plugins#20: a close that lands while the shard is reconnecting to an
// unreachable Discord, including in the library's 500ms wait between
// attempts, must still stop it, or the daemon never exits.
test('closing while Discord is unreachable stops reconnecting, so the process can exit', async () => {
  const fixture = new URL('./fixtures/stop-unreachable.mjs', import.meta.url).pathname;
  const run = (delay, mode = 'connected') => new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture, String(delay), mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (part) => {
      out += part;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ delay, exited: false, out });
    }, 6000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ delay, exited: true, code, out });
    });
  });
  // Before the first retry, inside the 500ms wait, and a few attempts in.
  const results = await Promise.all([0, 100, 300, 520, 700, 1300].map(run));
  for (const result of results) {
    assert.equal(result.out, 'closed\n', `close() resolved (delay ${result.delay}ms)`);
    assert.equal(result.exited, true, `the process exited on its own after close() (delay ${result.delay}ms)`);
    assert.equal(result.code, 0);
  }
  // Giving up a connect whose gateway refuses, at the same kinds of moment.
  const abandoned = await Promise.all([0, 100, 520, 700].map((delay) => run(delay, 'connecting')));
  for (const result of abandoned) {
    assert.equal(result.out, 'given up\n', `connect() rejected with the signal's reason (delay ${result.delay}ms)`);
    assert.equal(result.exited, true, `the process exited on its own after giving up (delay ${result.delay}ms)`);
    assert.equal(result.code, 0, `nothing crashed after giving up (delay ${result.delay}ms)`);
  }
  // Given up while the gateway socket is still opening: that socket's later
  // failure must not reach the process as an unhandled 'error' event.
  const held = await Promise.all([0, 50].map((delay) => run(delay, 'held')));
  for (const result of held) {
    assert.equal(result.out, 'given up\n', `connect() rejected with the signal's reason (held, delay ${result.delay}ms)`);
    assert.equal(result.exited, true, `the process exited on its own (held, delay ${result.delay}ms)`);
    assert.equal(result.code, 0, `the opening socket's failure didn't crash the process (held, delay ${result.delay}ms)`);
  }
});

test('a connect given up while REST is still answering never opens the gateway', async (t) => {
  const discord = await fakeDiscord({ gatewayDelayMs: 150 });
  t.after(() => discord.close());
  const controller = new AbortController();
  const attempt = connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {}, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('given up')), 30);
  await assert.rejects(attempt, /given up/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(discord.state.sockets, [], 'no gateway connection after the answer came');
});

test('an already-fired signal fails at once', async () => {
  await assert.rejects(connectBot({ token: 't', api: 'http://127.0.0.1:9/api', onMessage: () => {}, signal: AbortSignal.abort(new Error('too late')) }), /too late/);
});

test('an attempt already underway when the manager is destroyed is destroyed as well', async () => {
  // A shard that had just started connecting: idle when destroy() looked,
  // Connecting a moment later.
  const destroyed = [];
  const shard = {
    status: 0,
    async destroy(options) {
      destroyed.push(options);
      this.status = 0;
    },
  };
  const manager = {
    strategy: { shards: new Map([[0, shard]]) },
    async destroy() {
      queueMicrotask(() => {
        shard.status = 1;
      });
    },
  };
  await stopManager(manager, { code: 1000 });
  assert.equal(shard.status, 0);
  assert.deepEqual(destroyed, [{ code: 1000 }]);
  await shard.internalConnect();
  assert.equal(shard.status, 0, 'a scheduled reconnect is a no-op');
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

test('a file is uploaded as a message of its own, by name, pinging nobody', async (t) => {
  const discord = await fakeDiscord();
  const bot = await connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {} });
  t.after(async () => {
    await bot.close();
    await discord.close();
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-upload-'));
  const file = path.join(dir, 'chart.png');
  await writeFile(file, Buffer.from([1, 2, 3, 255]));
  const id = await uploadFile(bot.rest, CHANNEL, file);
  assert.equal(typeof id, 'string');
  const [post] = discord.state.posts;
  assert.equal(post.channelId, CHANNEL);
  assert.equal(post.authorization, 'Bot bot-token-a');
  assert.deepEqual(post.body.allowed_mentions, { parse: [], replied_user: false });
  assert.deepEqual(post.files.map((f) => [f.name, [...f.bytes]]), [['chart.png', [1, 2, 3, 255]]]);

  await uploadFile(bot.rest, CHANNEL, file, { title: 'The chart' });
  assert.equal(discord.state.posts[1].body.content, 'The chart');

  await mkdir(path.join(dir, 'folder'));
  await assert.rejects(uploadFile(bot.rest, CHANNEL, path.join(dir, 'folder')), /not a file/);
  await assert.rejects(uploadFile(bot.rest, CHANNEL, path.join(dir, 'missing.png')), /ENOENT/);
  const big = path.join(dir, 'big.bin');
  await writeFile(big, Buffer.alloc(UPLOAD_MAX_BYTES + 1));
  await assert.rejects(uploadFile(bot.rest, CHANNEL, big), /over the 10485760 bytes Discord takes from a bot/);
  assert.equal(discord.state.posts.length, 2, 'nothing posted for a refused file');
});
