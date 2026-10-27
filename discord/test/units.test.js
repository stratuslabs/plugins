import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiscordConfig } from '../lib/config.js';
import { admit } from '../lib/admission.js';
import { routeFor, sessionIdFor } from '../lib/sessions.js';
import { chunk, DISCORD_LIMIT } from '../lib/chunk.js';

const OWNER = '111111111111111111';
const OTHER = '222222222222222222';
const BOT = '999999999999999999';
const PEER_BOT = '888888888888888888';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const QUIET = '555555555555555555';
const THREAD = '666666666666666666';

const config = () => parseDiscordConfig({
  agents: {
    ava: {
      allowFrom: [OWNER],
      approvers: [OWNER],
      guilds: {
        [GUILD]: { channels: { [CHANNEL]: {}, [QUIET]: { requireMention: false } } },
      },
      allowBots: [PEER_BOT],
    },
  },
});

const message = (overrides = {}) => ({
  id: '777777777777777777',
  guildId: GUILD,
  channelId: CHANNEL,
  authorId: OWNER,
  authorIsBot: false,
  mentions: [BOT],
  mentionsRoleOrEveryone: false,
  replyToAuthorId: undefined,
  content: `<@${BOT}> hello`,
  ...overrides,
});

test('config: ids must be Discord snowflakes, and every agent needs someone who can approve', () => {
  assert.throws(() => parseDiscordConfig({ agents: { ava: { allowFrom: ['alice'], approvers: [OWNER] } } }), /allowFrom.*snowflake/);
  assert.throws(() => parseDiscordConfig({ agents: { ava: { allowFrom: [OWNER] } } }), /approvers/);
  assert.throws(() => parseDiscordConfig({ agents: { 'Bad Id': { allowFrom: [OWNER], approvers: [OWNER] } } }), /agent id/);
  assert.throws(() => parseDiscordConfig({ agents: { ava: { allowFrom: [OWNER], approvers: [OWNER], guilds: { [GUILD]: { channels: { general: {} } } } } } }), /channel.*snowflake/);
  const parsed = config().agents.get('ava');
  assert.equal(parsed.guilds.get(GUILD).requireMention, true, 'mention-gated by default');
  assert.equal(parsed.guilds.get(GUILD).channels.get(QUIET).requireMention, false);
  assert.equal(parsed.guilds.get(GUILD).channels.get(CHANNEL).requireMention, true, 'a channel inherits the guild default');
});

test('config: top-level settings are every agent\'s defaults; an agent entry replaces a key whole', () => {
  const parsed = parseDiscordConfig(
    { allowFrom: [OWNER], approvers: [OWNER], agents: { bo: { allowFrom: [OTHER] } } },
    { withTokens: ['ava', 'bo'] },
  );
  assert.deepEqual([...parsed.agents.keys()].sort(), ['ava', 'bo'], 'an agent with a token is covered by the defaults');
  assert.deepEqual([...parsed.agents.get('ava').allowFrom], [OWNER]);
  assert.deepEqual([...parsed.agents.get('bo').allowFrom], [OTHER], 'not merged with the default list');
  assert.deepEqual([...parsed.agents.get('bo').approvers], [OWNER], 'keys it does not name come from the defaults');
  assert.throws(() => parseDiscordConfig({}, { withTokens: ['ava'] }), /ava has no approvers/);
});

test('admission: DMs only from allowFrom', () => {
  const ava = config().agents.get('ava');
  assert.deepEqual(admit(message({ guildId: undefined, mentions: [], content: 'hi' }), ava, BOT), { admit: true, addressed: true, kind: 'direct', principal: true });
  assert.equal(admit(message({ guildId: undefined, authorId: OTHER, mentions: [] }), ava, BOT).admit, false);
});

test('admission: guilds and channels are allowlists, and a guild channel needs a mention by default', () => {
  const ava = config().agents.get('ava');
  assert.equal(admit(message(), ava, BOT).admit, true);
  assert.equal(admit(message({ guildId: '123123123123123123' }), ava, BOT).reason, 'guild not allowed');
  assert.equal(admit(message({ channelId: '121212121212121212' }), ava, BOT).reason, 'channel not allowed');
  assert.equal(admit(message({ mentions: [], content: 'hello' }), ava, BOT).reason, 'not addressed');
  assert.equal(admit(message({ mentions: [], replyToAuthorId: BOT }), ava, BOT).admit, true, 'a reply to the bot addresses it');
  assert.equal(admit(message({ channelId: QUIET, mentions: [] }), ava, BOT).admit, true, 'unless the channel opts out');
  // A thread is judged by its parent channel.
  assert.equal(admit(message({ channelId: THREAD, parentId: CHANNEL }), ava, BOT).admit, true);
  assert.equal(admit(message({ channelId: THREAD, parentId: '121212121212121212' }), ava, BOT).admit, false);
});

test('admission: a message aimed at someone else, or @everyone, is not for the agent', () => {
  const ava = config().agents.get('ava');
  assert.equal(admit(message({ channelId: QUIET, mentions: [OTHER] }), ava, BOT).reason, 'addressed to someone else');
  assert.equal(admit(message({ channelId: QUIET, mentions: [], mentionsRoleOrEveryone: true }), ava, BOT).reason, 'addressed to someone else');
  assert.equal(admit(message({ mentions: [BOT, OTHER] }), ava, BOT).admit, true, 'a mention of the bot still wins');
});

test('admission: in a thread the agent works in, a reply needs no mention, but is still not for it when aimed elsewhere', () => {
  const ava = config().agents.get('ava');
  const reply = { channelId: THREAD, parentId: CHANNEL, mentions: [], content: 'and then?' };
  assert.equal(admit(message(reply), ava, BOT).reason, 'not addressed', 'a thread it is not in still needs one');
  assert.deepEqual(admit(message(reply), ava, BOT, { engaged: true }), { admit: true, addressed: false, kind: 'channel', principal: true });
  assert.equal(admit(message({ ...reply, mentions: [OTHER] }), ava, BOT, { engaged: true }).reason, 'addressed to someone else');
  assert.equal(admit(message({ ...reply, mentionsRoleOrEveryone: true }), ava, BOT, { engaged: true }).reason, 'addressed to someone else');
  assert.equal(admit(message({ ...reply, parentId: '121212121212121212' }), ava, BOT, { engaged: true }).reason, 'channel not allowed', 'the allowlist still decides');
  assert.equal(admit(message({ mentions: [], content: 'top level' }), ava, BOT, { engaged: true }).reason, 'not addressed', 'only a thread');
});

test('admission: senders in a guild channel are anyone who can post there, but only principals are trusted', () => {
  const ava = config().agents.get('ava');
  const fromOther = admit(message({ authorId: OTHER }), ava, BOT);
  assert.equal(fromOther.admit, true);
  assert.equal(fromOther.principal, false);
  assert.equal(admit(message(), ava, BOT).principal, true);
});

test('admission: bots only from allowBots, never itself', () => {
  const ava = config().agents.get('ava');
  assert.equal(admit(message({ authorId: BOT, authorIsBot: true }), ava, BOT).reason, 'own message');
  assert.equal(admit(message({ authorId: '101010101010101010', authorIsBot: true }), ava, BOT).reason, 'bot not allowed');
  assert.equal(admit(message({ authorId: PEER_BOT, authorIsBot: true }), ava, BOT).admit, true);
});

test('sessions: a DM per user, a thread per thread, and a top-level mention opens a thread on itself', () => {
  assert.deepEqual(routeFor(message({ guildId: undefined, channelId: '131313131313131313' })), { team: '@dm', conversation: '131313131313131313', thread: undefined, startThread: false });
  assert.deepEqual(routeFor(message({ channelId: THREAD, parentId: CHANNEL })), { team: GUILD, conversation: CHANNEL, thread: THREAD, startThread: false });
  assert.deepEqual(routeFor(message()), { team: GUILD, conversation: CHANNEL, thread: '777777777777777777', startThread: true });
  // Discord gives a thread started on a message the message's own id, so
  // the follow-ups in that thread land on the same session.
  assert.equal(
    sessionIdFor('ava', routeFor(message())),
    sessionIdFor('ava', routeFor(message({ id: '787878787878787878', channelId: '777777777777777777', parentId: CHANNEL }))),
  );
  assert.equal(sessionIdFor('ava', routeFor(message())), `discord:ava:${GUILD}:${CHANNEL}:777777777777777777`);
  assert.notEqual(sessionIdFor('ava', routeFor(message())), sessionIdFor('bo', routeFor(message())));
});

test('sessions: a reply to an answer the agent gave in the channel continues where that conversation started', () => {
  const ANSWER = '909090909090909090';
  const ROOT = '767676767676767676';
  const rootOf = (id) => (id === ANSWER ? ROOT : undefined);
  assert.deepEqual(routeFor(message({ replyToId: ANSWER }), rootOf), { team: GUILD, conversation: CHANNEL, thread: ROOT, startThread: false, inChannel: true });
  assert.equal(sessionIdFor('ava', routeFor(message({ replyToId: ANSWER }), rootOf)), sessionIdFor('ava', routeFor(message({ id: ROOT }))));
  // Unknown answers, threads and DMs route as before.
  assert.equal(routeFor(message({ replyToId: '121212121212121212' }), rootOf).startThread, true);
  assert.equal(routeFor(message({ replyToId: ANSWER, channelId: THREAD, parentId: CHANNEL }), rootOf).thread, THREAD);
  assert.equal(routeFor(message({ replyToId: ANSWER, guildId: undefined }), rootOf).thread, undefined);
});

test('positions: which conversation each in-channel answer belongs to is kept across a restart, up to a limit, and an older file still loads', async () => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createPositions, ANSWER_LIMIT } = await import('../lib/positions.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-answers-'));
  const stateDirectory = { prepare: () => dir };
  const ROOT = '767676767676767676';
  const answerId = (n) => String(900000000000000000n + BigInt(n));

  const before = createPositions({ stateDirectory, writeDelayMs: 1 });
  before.answered('ava', [answerId(1), answerId(2)], ROOT);
  before.flush();
  const after = createPositions({ stateDirectory });
  after.load();
  assert.equal(after.rootOf('ava', answerId(2)), ROOT);
  assert.equal(after.rootOf('bo', answerId(2)), undefined, 'per agent');

  for (let n = 3; n <= ANSWER_LIMIT + 1; n += 1) after.answered('ava', [answerId(n)], ROOT);
  assert.equal(after.rootOf('ava', answerId(1)), undefined, 'the oldest goes first');
  assert.equal(after.rootOf('ava', answerId(2)), ROOT);
  after.flush();
  const stored = JSON.parse(await readFile(path.join(dir, 'positions.json'), 'utf8'));
  assert.equal(stored.answers.ava.length, ANSWER_LIMIT);

  // Written by a version without answers: it loads, with none known.
  await writeFile(path.join(dir, 'positions.json'), JSON.stringify({ version: 1, agents: { ava: { [CHANNEL]: { last: ROOT, guildId: GUILD } } } }));
  const older = createPositions({ stateDirectory });
  older.load();
  assert.equal(older.tracks('ava', CHANNEL), true);
  assert.equal(older.rootOf('ava', answerId(2)), undefined);
});

test('chunk: every piece fits Discord, splits at lines, and code fences stay closed', () => {
  assert.deepEqual(chunk('short'), ['short']);
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
  const pieces = chunk(long);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((piece) => piece.length <= DISCORD_LIMIT));
  assert.equal(pieces.join('\n'), long, 'nothing lost or reordered');
  const fenced = '```js\n' + Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```';
  const code = chunk(fenced);
  assert.ok(code.length > 1);
  for (const piece of code) {
    assert.ok(piece.length <= DISCORD_LIMIT);
    assert.equal((piece.match(/```/g) ?? []).length % 2, 0, 'each piece opens and closes its fences');
  }
  const word = 'y'.repeat(DISCORD_LIMIT * 2 + 5);
  assert.ok(chunk(word).every((piece) => piece.length <= DISCORD_LIMIT), 'a line longer than the limit is cut');
  assert.equal(chunk(word).join(''), word);
});

test('chunk: a long line inside a fence still fits once the fence reopens', () => {
  for (const lang of ['', 'x', 'js', 'typescript', 'a-very-long-language-tag-somebody-wrote']) {
    for (const length of [DISCORD_LIMIT - 9, DISCORD_LIMIT - 8, DISCORD_LIMIT, 5000]) {
      const body = 'a'.repeat(length);
      const text = '```' + lang + '\n' + body + '\n```';
      const pieces = chunk(text);
      for (const piece of pieces) {
        assert.ok(piece.length <= DISCORD_LIMIT, `lang ${JSON.stringify(lang)}, line ${length}: a piece is ${piece.length}`);
        assert.equal((piece.match(/```/g) ?? []).length % 2, 0, 'each piece opens and closes its fences');
      }
      const kept = pieces.map((piece) => piece.split('\n').filter((line) => !line.startsWith('```')).join('')).join('');
      assert.equal(kept, body, `lang ${JSON.stringify(lang)}, line ${length}: nothing lost`);
    }
  }
});

test('chunk: a fence opened at the end of a piece leaves room to close it', () => {
  const text = 'b'.repeat(DISCORD_LIMIT - 8) + '\n```js\n' + 'c'.repeat(100) + '\n```';
  const pieces = chunk(text);
  for (const piece of pieces) {
    assert.ok(piece.length <= DISCORD_LIMIT, `a piece is ${piece.length}`);
    assert.equal((piece.match(/```/g) ?? []).length % 2, 0, 'each piece opens and closes its fences');
  }
});

test('stop: only the word, with this bot mentioned or nobody', async () => {
  const { isStopRequest } = await import('../lib/stop.js');
  for (const yes of ['stop', 'Stop.', `<@${BOT}> stop!`, `stop <@!${BOT}>`]) {
    assert.equal(isStopRequest(yes, BOT), true, yes);
  }
  for (const no of ['stop that', 'please stop', `<@${OTHER}> stop`, 'stop <@&123456789012345678>', 'don\'t stop']) {
    assert.equal(isStopRequest(no, BOT), false, no);
  }
});

test('approval prompt: shows the call, offers Always only when it means something, and round-trips its ids', async () => {
  const { approvalMessage, parseCustomId, outcomeMessage } = await import('../lib/approvals.js');
  const prompt = approvalMessage({ agentName: 'Ava', toolName: 'shell.run', risk: 'gated', input: { command: 'rm -rf build ```' }, oneShot: false, always: 'scope', requestId: 'req-1' });
  assert.match(prompt.content, /\*\*Ava\*\* wants to run `shell.run` \(gated\)/);
  assert.match(prompt.content, /"command": "rm -rf build `​``"/, 'model text cannot close the code block');
  assert.match(prompt.content, /Always allow\*\* remembers this command's scope/);
  const ids = prompt.components[0].components.map((button) => parseCustomId(button.custom_id));
  assert.deepEqual(ids, [{ answer: 'once', requestId: 'req-1' }, { answer: 'always', requestId: 'req-1' }, { answer: 'deny', requestId: 'req-1' }]);
  const oneShot = approvalMessage({ agentName: 'Ava', toolName: 'x', risk: 'dangerous', input: {}, oneShot: true, requestId: 'req-2' });
  assert.deepEqual(oneShot.components[0].components.map((button) => button.label), ['Allow once', 'Deny']);
  assert.equal(parseCustomId('something:else'), undefined);
  assert.equal(parseCustomId('stratus:approval:maybe:req'), undefined);
  const post = { agentName: 'Ava', agentId: 'ava', toolName: 'x', risk: 'gated', oneShot: false, always: 'session', approvers: new Set([OWNER]) };
  assert.equal(outcomeMessage(post, { answer: 'once', reason: 'decided', actor: OWNER }), `**Ava**: \`x\` (gated): Allowed once by <@${OWNER}>.`);
  assert.equal(outcomeMessage(post, { answer: 'deny', reason: 'timeout' }), '**Ava**: `x` (gated): Expired without an answer, denied.');
  assert.match(outcomeMessage(post, { answer: 'once', reason: 'decided', actor: 'dashboard' }), /by `dashboard`/);
});

test('deleting a message that is already gone is done; any other refusal is not', async () => {
  const { removeMessage } = await import('../lib/send.js');
  const refusing = (status) => ({ delete: async () => { throw Object.assign(new Error(`status ${status}`), { status }); } });
  await removeMessage(refusing(404), '1', '2');
  await assert.rejects(removeMessage(refusing(403), '1', '2'), /status 403/);
});
