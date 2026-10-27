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
  return {
    turns,
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
      if (hold) {
        return new Promise(() => {});
      }
      const session = {
        id: input.sessionId,
        status: 'completed',
        messages: [
          { role: 'user', content: input.userMessage, idempotencyKey: input.idempotencyKey },
          { role: 'assistant', content: `answer to ${input.idempotencyKey}` },
        ],
      };
      finished.set(input.idempotencyKey, session);
      return Promise.resolve(session);
    },
  };
};

const startAdapter = async (env, gateway) => {
  const { discord, stateDir } = env;
  const registered = [];
  await createPlugin(config, { api: discord.api, drainTimeoutMs: 100, positionsWriteDelayMs: 5 }).setup({
    log: () => {},
    warn: () => {},
    stateDirectory: { prepare: () => stateDir },
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
