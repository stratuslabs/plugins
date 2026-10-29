import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPlugin } from '../index.js';
import { BOT, fakeDiscord } from './fake-discord.js';

const OWNER = '222222222222222222';
const STRANGER = '222222222222222223';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const QUIET = '444444444444444445';
const THREAD = '555555555555555555';
const DM = '777777777777777777';

const until = async (check, what, tries = 200) => {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};

/** A snowflake for a moment `agoMs` before now, plus `n` to keep ids apart. */
const idAt = (agoMs, n = 0) => String(((BigInt(Date.now() - agoMs) - 1420070400000n) << 22n) + BigInt(n));

const config = {
  approvers: [OWNER],
  allowFrom: [OWNER],
  guilds: { [GUILD]: { channels: { [CHANNEL]: { requireMention: false }, [QUIET]: {} } } },
};

/**
 * The gateway as far as backfill needs it: dispatches recorded, each
 * answered with `reply` unless `hold` keeps it running, or rejected with
 * `refuse`. A key it has finished before is repeated as `finished`.
 */
const fakeGateway = ({ hold = false, refuse } = {}) => {
  const listeners = new Set();
  const finished = new Map();
  const turns = [];
  // A held dispatch's way to finish, for `release()`.
  const held = [];
  return {
    turns,
    /** Finish every held dispatch, as a turn that outlived its channel's stop would. */
    release() {
      for (const finish of held.splice(0)) finish();
    },
    bus: { subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
    agents: () => [{ id: 'ava' }],
    activeTurnId: () => undefined,
    finished,
    dispatch(input) {
      turns.push(input);
      if (refuse) {
        return Promise.reject(refuse());
      }
      if (finished.has(input.idempotencyKey)) {
        input.onRepeat?.('finished');
        return Promise.resolve(finished.get(input.idempotencyKey));
      }
      const session = {
        id: input.sessionId,
        status: 'completed',
        messages: [
          { role: 'user', content: input.userMessage, idempotencyKey: input.idempotencyKey },
          { role: 'assistant', content: `answer to ${input.idempotencyKey}` },
        ],
      };
      if (hold) {
        return new Promise((resolve) => {
          held.push(() => {
            finished.set(input.idempotencyKey, session);
            resolve(session);
          });
        });
      }
      finished.set(input.idempotencyKey, session);
      return Promise.resolve(session);
    },
  };
};

const startAdapter = async (env, gateway, { warn = () => {}, noState = false } = {}) => {
  const { discord, stateDir } = env;
  const registered = [];
  await createPlugin(config, { api: discord.api, drainTimeoutMs: 100, positionsWriteDelayMs: 5 }).setup({
    log: () => {},
    warn,
    ...(noState ? {} : { stateDirectory: { prepare: () => stateDir } }),
    channels: { transportSecrets: async () => ({ ava: { botToken: 'tok' } }), register: (c) => registered.push(c) },
  });
  const adapter = registered[0].adapter;
  await adapter.start(gateway);
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await adapter.stop();
    }
  };
  env.stops.push(stop);
  return { adapter, stop };
};

const stored = async (stateDir) => JSON.parse(await readFile(path.join(stateDir, 'positions.json'), 'utf8')).agents.ava;

const raw = (id, fields = {}) => ({
  id, type: 0, content: 'hello', timestamp: new Date().toISOString(),
  author: { id: OWNER, username: 'dylan' }, mentions: [], attachments: [], ...fields,
});

/** Adapters stop before the fake Discord closes, or they'd be reconnecting to it. */
const setUp = async (t) => {
  const discord = await fakeDiscord();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'discord-positions-'));
  const env = { discord, stateDir, stops: [] };
  t.after(async () => {
    for (const stop of env.stops.reverse()) await stop();
    await discord.close();
  });
  return env;
};

test('a DM answered before a restart is not answered again; one sent while it was down is', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const first = idAt(60_000);
  const gateway = fakeGateway();
  const one = await startAdapter(env, gateway);
  discord.dispatch('MESSAGE_CREATE', raw(first, { channel_id: DM }));
  await until(() => discord.state.posts.some((p) => p.body.content === `answer to discord:${first}`), 'the live answer');
  await one.stop();
  assert.equal((await stored(stateDir))[DM].last, first);

  // Down: one more message lands in the DM.
  const missed = idAt(30_000);
  discord.state.channels[DM] = { id: DM, type: 1 };
  discord.state.history[DM] = [raw(first, { channel_id: DM }), raw(missed, { channel_id: DM, content: 'while you were out' })];
  const posts = discord.state.posts.length;
  await startAdapter(env, gateway);
  await until(() => discord.state.posts.some((p) => p.body.content === `answer to discord:${missed}`), 'the missed message answered');
  assert.deepEqual(gateway.turns.map((turn) => turn.idempotencyKey), [`discord:${first}`, `discord:${missed}`], 'the answered one is not dispatched again');
  assert.equal(discord.state.posts.length, posts + 1);
});

test('a message still being answered when the daemon stops is read again at the next start', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const id = idAt(10_000);
  const one = await startAdapter(env, fakeGateway({ hold: true }));
  discord.dispatch('MESSAGE_CREATE', raw(id, { channel_id: DM }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await one.stop();
  assert.equal((await stored(stateDir))[DM].last, String(BigInt(id) - 1n), 'held below the unanswered message');

  discord.state.channels[DM] = { id: DM, type: 1 };
  discord.state.history[DM] = [raw(id, { channel_id: DM })];
  const gateway = fakeGateway();
  await startAdapter(env, gateway);
  await until(() => gateway.turns.length === 1, 'the held message dispatched again');
  assert.equal(gateway.turns[0].idempotencyKey, `discord:${id}`);
});

test('a turn that settles after a stop gave up waiting for it posts nothing from the stopped channel, and is answered at the next start', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const id = idAt(10_000);
  const gateway = fakeGateway({ hold: true });
  const one = await startAdapter(env, gateway);
  discord.dispatch('MESSAGE_CREATE', raw(id, { channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'the dispatch');
  await one.stop();
  const posts = discord.state.posts.length;
  const edits = discord.state.patches.length;
  // The turn finishes after the stop's drain gave up on it.
  gateway.release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(discord.state.posts.length, posts, 'the stopped channel posts no answer');
  assert.equal(discord.state.patches.length, edits, 'nor edits one in');
  assert.equal((await stored(stateDir))[DM].last, String(BigInt(id) - 1n), 'still held below the message');

  discord.state.channels[DM] = { id: DM, type: 1 };
  discord.state.history[DM] = [raw(id, { channel_id: DM })];
  await startAdapter(env, gateway);
  await until(() => discord.state.posts.some((p) => p.body.content === `answer to discord:${id}`), 'the answer from the next start');
  assert.equal(discord.state.posts.filter((p) => p.body.content === `answer to discord:${id}`).length, 1, 'answered once');
  assert.equal(gateway.turns.length, 2, 'the finished turn is repeated, not run again');
});

test('with no state directory, a stop that gives up on a turn says its reply will not be answered, and posts nothing', async (t) => {
  const env = await setUp(t);
  const { discord } = env;
  const id = idAt(10_000);
  const gateway = fakeGateway({ hold: true });
  const warnings = [];
  const one = await startAdapter(env, gateway, { noState: true, warn: (line) => warnings.push(line) });
  discord.dispatch('MESSAGE_CREATE', raw(id, { channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'the dispatch');
  await one.stop();
  const stopped = warnings.find((line) => line.includes('unfinished'));
  assert.ok(stopped, 'the stop warns about the unfinished reply');
  assert.match(stopped, /no state directory/, 'and says why it is lost');
  assert.match(stopped, /will not be answered/);
  const posts = discord.state.posts.length;
  gateway.release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(discord.state.posts.length, posts, 'the stopped channel still posts nothing');
});

test('with a state directory, a stop that gives up on a turn says it is held for the next start', async (t) => {
  const env = await setUp(t);
  const { discord } = env;
  const gateway = fakeGateway({ hold: true });
  const warnings = [];
  const one = await startAdapter(env, gateway, { warn: (line) => warnings.push(line) });
  discord.dispatch('MESSAGE_CREATE', raw(idAt(10_000), { channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'the dispatch');
  await one.stop();
  const stopped = warnings.find((line) => line.includes('unfinished'));
  assert.match(stopped, /held for the next start/);
});

test('a message refused by a daemon on its way down is told so and kept for the next start', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const id = idAt(10_000);
  const stopping = () => Object.assign(new Error('restarting'), { name: 'GatewayStoppingError', restarting: true });
  const one = await startAdapter(env, fakeGateway({ refuse: stopping }));
  discord.dispatch('MESSAGE_CREATE', raw(id, { channel_id: DM }));
  await until(() => discord.state.posts.some((p) => /restarting\. I'll answer this when I'm back/.test(p.body.content)), 'the notice');
  await one.stop();
  assert.equal((await stored(stateDir))[DM].last, String(BigInt(id) - 1n));
});

test('chatter the agent does not answer moves a tracked channel on; a stranger never opens one', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const asked = idAt(20_000);
  const chatter = idAt(10_000);
  const one = await startAdapter(env, fakeGateway());
  discord.dispatch('MESSAGE_CREATE', raw(asked, { channel_id: CHANNEL, guild_id: GUILD }));
  await until(() => discord.state.posts.some((p) => p.body.content === `answer to discord:${asked}`), 'the answer');
  discord.dispatch('MESSAGE_CREATE', raw(chatter, { channel_id: CHANNEL, guild_id: GUILD, content: 'hey <@222222222222222223>', mentions: [{ id: STRANGER }] }));
  discord.dispatch('MESSAGE_CREATE', raw(idAt(9_000), { channel_id: '444444444444444449', guild_id: GUILD }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await one.stop();
  const positions = await stored(stateDir);
  assert.equal(positions[CHANNEL].last, chatter);
  assert.equal(positions[CHANNEL].guildId, GUILD);
  assert.deepEqual(Object.keys(positions).sort(), [CHANNEL, asked].sort(), 'the channel and the thread opened on the answered message; an unlisted channel is never tracked');
  assert.equal(positions[asked].parentId, CHANNEL);
});

test('a thread is read again under its parent, so a listed channel\'s thread still admits it', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const first = idAt(60_000);
  const one = await startAdapter(env, fakeGateway());
  discord.dispatch('THREAD_CREATE', { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHANNEL });
  discord.dispatch('MESSAGE_CREATE', raw(first, { channel_id: THREAD, guild_id: GUILD }));
  await until(() => discord.state.posts.some((p) => p.channelId === THREAD), 'the thread answer');
  await one.stop();
  assert.equal((await stored(stateDir))[THREAD].parentId, CHANNEL);

  const missed = idAt(5_000);
  discord.state.channels[THREAD] = { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHANNEL };
  discord.state.history[THREAD] = [raw(missed)];
  const gateway = fakeGateway();
  await startAdapter(env, gateway);
  await until(() => gateway.turns.length === 1, 'the thread message dispatched');
  assert.equal(gateway.turns[0].metadata.discordThread, THREAD);
  assert.equal(gateway.turns[0].metadata.team, GUILD);
});

test('a reply with no mention sent while it was down, in the thread a mention opened, is answered at the next start', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const first = idAt(60_000);
  const one = await startAdapter(env, fakeGateway());
  discord.dispatch('MESSAGE_CREATE', raw(first, { channel_id: QUIET, guild_id: GUILD, content: `<@${BOT}> start`, mentions: [{ id: BOT }] }));
  await until(() => discord.state.posts.some((p) => p.channelId === first), 'the answer in the new thread');
  await one.stop();
  assert.equal((await stored(stateDir))[first]?.parentId, QUIET, 'the thread is a conversation it works in');

  const missed = idAt(5_000);
  discord.state.history[first] = [raw(missed, { content: 'while you were out' })];
  const gateway = fakeGateway();
  await startAdapter(env, gateway);
  await until(() => gateway.turns.length === 1, 'the follow-up dispatched');
  assert.equal(gateway.turns[0].idempotencyKey, `discord:${missed}`);
  assert.equal(gateway.turns[0].metadata.discordThread, first);
});

test('a restart does not answer what is more than a day old, and forgets a conversation that is gone', async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const first = idAt(3 * 24 * 3600_000);
  const one = await startAdapter(env, fakeGateway());
  discord.dispatch('MESSAGE_CREATE', raw(first, { channel_id: DM }));
  discord.dispatch('MESSAGE_CREATE', raw(idAt(3 * 24 * 3600_000, 1), { channel_id: '777777777777777770' }));
  await until(() => discord.state.posts.length >= 2, 'both answered');
  await one.stop();

  discord.state.channels[DM] = { id: DM, type: 1 };
  discord.state.history[DM] = [raw(idAt(2 * 24 * 3600_000), { channel_id: DM }), raw(idAt(1_000), { channel_id: DM })];
  const gateway = fakeGateway();
  const two = await startAdapter(env, gateway);
  await until(() => gateway.turns.length === 1, 'the recent one');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(gateway.turns.length, 1, 'the two-day-old one is left');
  await two.stop();
  assert.deepEqual(Object.keys(await stored(stateDir)), [DM], 'the unknown DM was dropped');
});

test('a new gateway session after a long disconnect reads what was missed', { timeout: 30_000 }, async (t) => {
  const env = await setUp(t);
  const { discord, stateDir } = env;
  const first = idAt(60_000);
  const gateway = fakeGateway();
  await startAdapter(env, gateway);
  discord.dispatch('MESSAGE_CREATE', raw(first, { channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'the live one');
  const missed = idAt(1_000);
  discord.state.channels[DM] = { id: DM, type: 1 };
  discord.state.history[DM] = [raw(first, { channel_id: DM }), raw(missed, { channel_id: DM })];
  discord.invalidate();
  // Discord's identify throttle spaces identifies 5s apart.
  await until(() => gateway.turns.length === 2, 'the missed one after re-identify', 600);
  assert.equal(gateway.turns[1].idempotencyKey, `discord:${missed}`);
  assert.ok(discord.state.identifies.length >= 2, 'a fresh identify, not a resume');
});

test('a message sent while a restart is still reading the missed ones waits behind them', async (t) => {
  const env = await setUp(t);
  const { discord } = env;
  const first = idAt(60_000);
  const gateway = fakeGateway();
  const one = await startAdapter(env, gateway);
  discord.dispatch('MESSAGE_CREATE', raw(first, { channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'the live one');
  await one.stop();

  const missed = idAt(30_000);
  discord.state.channels[DM] = { id: DM, type: 1 };
  discord.state.history[DM] = [raw(first, { channel_id: DM }), raw(missed, { channel_id: DM, content: 'while you were out' })];
  discord.state.historyDelayMs = 300;
  const turns = gateway.turns.length;
  await startAdapter(env, gateway);
  // Live while the history read is still out.
  const live = idAt(0, 1);
  discord.dispatch('MESSAGE_CREATE', raw(live, { channel_id: DM, content: 'and now' }));
  await until(() => gateway.turns.length === turns + 2, 'both dispatched');
  assert.deepEqual(gateway.turns.slice(turns).map((turn) => turn.idempotencyKey), [`discord:${missed}`, `discord:${live}`]);
});

test('a message sent while a new gateway session is reading what was missed waits behind it', { timeout: 30_000 }, async (t) => {
  const env = await setUp(t);
  const { discord } = env;
  const first = idAt(60_000);
  const gateway = fakeGateway();
  await startAdapter(env, gateway);
  discord.dispatch('MESSAGE_CREATE', raw(first, { channel_id: DM }));
  await until(() => gateway.turns.length === 1, 'the live one');
  const missed = idAt(1_000);
  discord.state.channels[DM] = { id: DM, type: 1 };
  discord.state.history[DM] = [raw(first, { channel_id: DM }), raw(missed, { channel_id: DM })];
  discord.state.historyDelayMs = 500;
  const gets = discord.state.gets.length;
  discord.invalidate();
  await until(() => discord.state.gets.slice(gets).some((url) => url.startsWith(`/channels/${DM}/messages`)), 'the history read after re-identify', 600);
  const live = idAt(0, 1);
  discord.dispatch('MESSAGE_CREATE', raw(live, { channel_id: DM, content: 'and now' }));
  await until(() => gateway.turns.length === 3, 'both dispatched');
  assert.deepEqual(gateway.turns.slice(1).map((turn) => turn.idempotencyKey), [`discord:${missed}`, `discord:${live}`]);
});

/** A reply (Discord's Reply) to one of the agent's own messages, as Discord sends it. */
const replyTo = (id, answerId, content) => raw(id, {
  type: 19,
  content,
  message_reference: { message_id: answerId, channel_id: CHANNEL, guild_id: GUILD },
  referenced_message: { id: answerId, channel_id: CHANNEL, type: 19, content: 'an answer', author: { id: BOT, username: 'ava', bot: true }, mentions: [] },
});

test('with no permission to open threads, a reply to an answer in the channel continues its conversation, after a restart too', async (t) => {
  const env = await setUp(t);
  const { discord } = env;
  discord.state.refuseThreads = true;
  const gateway = fakeGateway();
  const one = await startAdapter(env, gateway);
  const first = idAt(60_000, 1);
  discord.dispatch('MESSAGE_CREATE', raw(first, { guild_id: GUILD, channel_id: CHANNEL, content: 'which plan are we on?' }));
  await until(() => discord.state.posts.length === 1, 'the first answer');
  const session = `discord:ava:${GUILD}:${CHANNEL}:${first}`;
  assert.equal(gateway.turns[0].sessionId, session);
  assert.equal(discord.state.posts[0].body.message_reference?.message_id, first, 'answered under the message, in the channel');

  const second = idAt(50_000, 2);
  discord.dispatch('MESSAGE_CREATE', { ...replyTo(second, discord.state.posts[0].id, 'and what does it cost?'), guild_id: GUILD, channel_id: CHANNEL });
  await until(() => discord.state.posts.length === 2, 'the second answer');
  assert.equal(gateway.turns[1].sessionId, session, 'the reply continues the first message\'s session');
  assert.equal(discord.state.posts[1].channelId, CHANNEL);
  assert.equal(discord.state.posts[1].body.message_reference?.message_id, second, 'and is answered under the reply');
  await one.stop();

  // Down: a reply to the second answer lands in the channel.
  const third = idAt(40_000, 3);
  discord.state.channels[CHANNEL] = { id: CHANNEL, type: 0, guild_id: GUILD };
  discord.state.history[CHANNEL] = [replyTo(third, discord.state.posts[1].id, 'and per seat?')];
  await startAdapter(env, gateway);
  await until(() => gateway.turns.length === 3, 'the reply sent while it was down');
  assert.equal(gateway.turns[2].sessionId, session, 'still the same session after a restart');
  await until(() => discord.state.posts.length === 3, 'the third answer');
  assert.equal(discord.state.posts[2].channelId, CHANNEL);
  assert.equal(discord.state.posts[2].body.message_reference?.message_id, third);
});

test('a reply to a message of the agent\'s it has no conversation for starts its own', async (t) => {
  const env = await setUp(t);
  const { discord } = env;
  discord.state.refuseThreads = true;
  const gateway = fakeGateway();
  await startAdapter(env, gateway);
  const id = idAt(10_000, 4);
  discord.dispatch('MESSAGE_CREATE', { ...replyTo(id, '900000000000099999', 'about this?'), guild_id: GUILD, channel_id: CHANNEL });
  await until(() => discord.state.posts.length === 1, 'the answer');
  assert.equal(gateway.turns[0].sessionId, `discord:ava:${GUILD}:${CHANNEL}:${id}`);
});
