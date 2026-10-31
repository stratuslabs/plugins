import { chunk } from './chunk.js';
import { editText, postText, removeMessage, typing, uploadFile } from './send.js';

/**
 * Discord as an addressable channel: `discord:` destinations for
 * `message.send` and schedules, `message.read`, and whether a conversation
 * is a channel or a DM (for the operator's standing channel authorization).
 *
 * The boundary is the one admission draws for what comes in: a guild
 * channel (or a thread in one) in a guild this agent works in, and only a
 * listed channel when that guild lists them. A DM is a destination only
 * when it is with someone in allowFrom or approvers, and is never read: its
 * only members are the people in it, and a read from elsewhere would carry
 * what they said to people who were never there.
 *
 * Every id is Discord's own: a channel, thread or DM channel id, never a
 * name. Nothing here is cached except the answer to "channel or DM", which
 * never changes for an id.
 */

const SNOWFLAKE = /^[0-9]{17,20}$/;
const DISCORD_EPOCH = 1420070400000n;

/** Channel types. */
const DM = 1;
const GROUP_DM = 3;
const THREAD_TYPES = new Set([10, 11, 12]);
/** Text channels, announcement channels, voice text chat, threads. */
const POSTABLE = new Set([0, 2, 5, 13, 10, 11, 12]);
/** Message types that are something someone said, not a notice. */
const SPOKEN = new Set([0, 19, 20, 23]);

const KIND_CACHE_LIMIT = 1000;
/** Posts per connection whose messages an edit can still rewrite. */
const POSTS_KEPT = 100;
const PAGE = 100;
/** Pages one read may fetch, so a history of notices can't make it walk forever. */
const MAX_PAGES = 10;

const describe = (error) => (error instanceof Error ? error.message : String(error));
const notFound = (error) => error?.status === 404;

/** A message id, or a time as the id of its first possible message. */
const boundary = (value) => {
  if (value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  if (SNOWFLAKE.test(text)) {
    return BigInt(text);
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error(`discord: ${JSON.stringify(text)} is neither a message id nor a time.`);
  }
  return ms <= Number(DISCORD_EPOCH) ? 0n : (BigInt(ms) - DISCORD_EPOCH) << 22n;
};

const nameOfUser = (user) => user?.global_name ?? user?.username ?? user?.id ?? 'someone';

/** Discord markup as plain text: mentions by name, emoji by name, times as ISO. */
export const plainText = (message) => {
  const users = new Map((message.mentions ?? []).map((user) => [user.id, nameOfUser(user)]));
  return String(message.content ?? '')
    .replace(/<@!?(\d+)>/g, (_, id) => `@${users.get(id) ?? id}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@role:${id}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${id}`)
    .replace(/<a?:(\w+):\d+>/g, (_, name) => `:${name}:`)
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (whole, seconds) => {
      const date = new Date(Number(seconds) * 1000);
      return Number.isNaN(date.getTime()) ? whole : date.toISOString();
    });
};

const toConversationMessage = (raw, thread) => ({
  id: raw.id,
  author: raw.author?.id ?? 'unknown',
  authorName: nameOfUser(raw.author),
  text: plainText(raw),
  ...(raw.timestamp ? { at: new Date(raw.timestamp).toISOString() } : {}),
  ...(thread !== undefined ? { thread } : {}),
  ...(raw.thread?.message_count !== undefined ? { replies: raw.thread.message_count } : {}),
  ...((raw.attachments ?? []).length > 0 ? { files: raw.attachments.map((file) => file.filename ?? file.id ?? 'file') } : {}),
});

export const createAddressing = ({ bots, config }) => {
  const kinds = new Map();

  const botFor = (agentId, verb, what) => {
    const bot = bots.get(agentId);
    if (bot) {
      return bot;
    }
    throw new Error(config.agents.has(agentId)
      ? `discord: ${agentId}'s Discord bot is not connected right now, so ${what} cannot be ${verb}.`
      : `discord: ${agentId} has no Discord bot, so it cannot use Discord at all.`);
  };

  const channelId = (value, what) => {
    const id = String(value ?? '').trim();
    if (!SNOWFLAKE.test(id)) {
      throw new Error(`discord: ${what} needs a Discord channel id (17-20 digits), not ${JSON.stringify(id)}. Copy it with Developer Mode on.`);
    }
    return id;
  };

  const fetchChannel = async (bot, agentId, id) => {
    try {
      return await bot.rest.get(`/channels/${id}`);
    } catch (error) {
      // Unknown and not visible to this bot look the same from here, and
      // the message doesn't pretend otherwise.
      throw new Error(`discord: ${agentId}'s bot cannot see ${id} (${describe(error)}). Use the channel id, and check the bot is in that server with View Channel.`);
    }
  };

  /** A guild channel this agent works in, judged the way admission judges a message there. */
  const assertWorksIn = (agentId, channel) => {
    const agent = config.agents.get(agentId);
    const guild = channel.guild_id ? agent?.guilds.get(channel.guild_id) : undefined;
    if (!guild) {
      throw new Error(`discord: ${channel.id} is in a server that is not one this agent works in. Add the server under guilds in the plugin config first.`);
    }
    const listed = THREAD_TYPES.has(channel.type) ? channel.parent_id : channel.id;
    if (guild.channels && !guild.channels.has(listed)) {
      throw new Error(`discord: ${channel.id} is not one of the channels this agent works in on that server. Add it under the server's channels in the plugin config first.`);
    }
  };

  const rememberKind = (key, kind) => {
    if (kinds.size >= KIND_CACHE_LIMIT) {
      kinds.delete(kinds.keys().next().value);
    }
    kinds.set(key, kind);
  };

  /**
   * Where a destination's `thread` sends the words: a thread in `to` (its
   * id), or a message in `to` with no thread, which the post replies under.
   * No thread is `to` itself. Throws, saying why, for anything else.
   */
  const threadTarget = async (bot, agentId, to, value) => {
    const thread = value?.trim() || undefined;
    if (thread === undefined) {
      return { target: to };
    }
    channelId(thread, 'a thread');
    let threadChannel;
    try {
      threadChannel = await bot.rest.get(`/channels/${thread}`);
    } catch (error) {
      if (!notFound(error)) {
        throw new Error(`discord: ${agentId}'s bot could not look up thread ${thread} (${describe(error)}).`);
      }
    }
    if (threadChannel) {
      if (!THREAD_TYPES.has(threadChannel.type) || threadChannel.parent_id !== to) {
        throw new Error(`discord: ${thread} is not a thread in ${to}.`);
      }
      return { target: thread };
    }
    try {
      await bot.rest.get(`/channels/${to}/messages/${thread}`);
    } catch (error) {
      throw new Error(`discord: there is no thread or message ${thread} in ${to} that ${agentId}'s bot can see (${describe(error)}).`);
    }
    return { target: to, replyTo: thread };
  };

  const resolveOutbound = async (address) => {
    const to = channelId(address.to, 'a destination');
    const bot = botFor(address.agentId, 'reached', to);
    const agent = config.agents.get(address.agentId);
    const channel = await fetchChannel(bot, address.agentId, to);
    if (channel.type === DM) {
      const with_ = (channel.recipients ?? []).map((user) => user.id);
      if (!with_.some((id) => agent.allowFrom.has(id) || agent.approvers.has(id))) {
        throw new Error(`discord: ${to} is a DM with someone not in allowFrom or approvers, so this agent doesn't post there.`);
      }
    } else if (channel.type === GROUP_DM) {
      throw new Error(`discord: ${to} is a group DM, which a bot can't post in.`);
    } else {
      assertWorksIn(address.agentId, channel);
      if (!POSTABLE.has(channel.type)) {
        throw new Error(`discord: ${to} can't be posted in directly (a category, forum or media channel). Name a text channel, or one of the forum's posts.`);
      }
    }

    const { target, replyTo } = await threadTarget(bot, address.agentId, to, address.thread);

    // A post over 2000 characters is several messages. An edit rewrites all
    // of them, so the ids of each post are kept, by its first id.
    const posts = new Map();
    const remember = (first, ids) => {
      posts.delete(first);
      posts.set(first, ids);
      if (posts.size > POSTS_KEPT) {
        posts.delete(posts.keys().next().value);
      }
    };

    return {
      async post(text) {
        const ids = await postText(bot.rest, target, text.trim().length > 0 ? text : '(empty message)', replyTo ? { replyTo } : {});
        if (ids.length > 0) {
          remember(ids[0], ids);
        }
        return { channel: target, ts: ids[0] ?? '' };
      },
      async edit(ref, text) {
        const pieces = chunk(text.trim().length > 0 ? text : '(empty message)');
        const ids = [...(posts.get(ref.ts) ?? [ref.ts])];
        try {
          for (const [index, piece] of pieces.entries()) {
            if (index < ids.length) {
              await editText(bot.rest, ref.channel, ids[index], piece);
            } else {
              ids.push(...await postText(bot.rest, ref.channel, piece));
            }
          }
          // A shorter text takes down the continuations it no longer needs.
          while (ids.length > pieces.length) {
            await removeMessage(bot.rest, ref.channel, ids.at(-1));
            ids.pop();
          }
        } finally {
          // What got posted or is still up stays known, even if a call failed.
          remember(ref.ts, ids);
        }
      },
      async upload(filePath, title) {
        await uploadFile(bot.rest, target, filePath, title ? { title } : {});
      },
      async typing() {
        await typing(bot.rest, target);
      },
    };
  };

  const conversationKindFor = async (agentId, conversation) => {
    const id = String(conversation ?? '').trim();
    const bot = bots.get(agentId);
    if (!SNOWFLAKE.test(id) || !bot) {
      return undefined;
    }
    const key = `${agentId}:${id}`;
    if (kinds.has(key)) {
      return kinds.get(key);
    }
    let channel;
    try {
      channel = await bot.rest.get(`/channels/${id}`);
    } catch {
      return undefined;
    }
    const kind = channel?.type === DM || channel?.type === GROUP_DM ? 'direct' : channel?.guild_id ? 'channel' : undefined;
    if (kind !== undefined) {
      rememberKind(key, kind);
    }
    return kind;
  };

  /**
   * Up to `want` spoken messages from one channel inside (after, before),
   * newest first or oldest first, and whether there were more.
   */
  const collect = async (rest, id, { after, before, want, oldestFirst }) => {
    const kept = [];
    let cursor = oldestFirst ? after : before;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (cursor !== undefined) {
        query.set(oldestFirst ? 'after' : 'before', String(cursor));
      }
      const page = await rest.get(`/channels/${id}/messages`, { query });
      if (!Array.isArray(page) || page.length === 0) {
        return { kept, more: false };
      }
      const ordered = [...page].sort((a, b) => {
        const order = BigInt(a.id) < BigInt(b.id) ? -1 : 1;
        return oldestFirst ? order : -order;
      });
      for (const raw of ordered) {
        const at = BigInt(raw.id);
        if ((oldestFirst && before !== undefined && at >= before) || (!oldestFirst && after !== undefined && at <= after)) {
          return { kept, more: false };
        }
        if (SPOKEN.has(raw.type ?? 0)) {
          if (kept.length === want) {
            return { kept, more: true };
          }
          kept.push(raw);
        }
      }
      if (page.length < PAGE) {
        return { kept, more: false };
      }
      cursor = BigInt(ordered[ordered.length - 1].id);
    }
    return { kept, more: true };
  };

  const readConversation = async (request) => {
    const id = channelId(request.conversation, 'a read');
    const bot = botFor(request.agentId, 'read', id);
    const channel = await fetchChannel(bot, request.agentId, id);
    if (channel.type === DM || channel.type === GROUP_DM) {
      throw new Error(`discord: ${id} is a direct message, and direct messages are never read from outside them. Approval cannot unlock this; read a channel instead.`);
    }
    assertWorksIn(request.agentId, channel);
    const after = boundary(request.after);
    const before = boundary(request.before);
    const inWindow = (messageId) => {
      const at = BigInt(messageId);
      return (after === undefined || at > after) && (before === undefined || at < before);
    };

    if (request.thread === undefined) {
      const { kept, more } = await collect(bot.rest, id, { after, before, want: request.limit, oldestFirst: false });
      return { messages: kept.map((raw) => toConversationMessage(raw)), more };
    }

    const threadId = channelId(request.thread, 'a thread read');
    let thread;
    try {
      thread = await bot.rest.get(`/channels/${threadId}`);
    } catch (error) {
      throw new Error(`discord: ${request.agentId}'s bot cannot see thread ${threadId} (${describe(error)}).`);
    }
    if (!THREAD_TYPES.has(thread.type) || thread.parent_id !== id) {
      throw new Error(`discord: ${threadId} is not a thread in ${id}.`);
    }
    // The root of a thread opened on a message is that message, in the
    // parent channel, with the thread's id. A forum post or a thread
    // opened from nothing has none there.
    const messages = [];
    if (inWindow(threadId)) {
      try {
        const root = await bot.rest.get(`/channels/${id}/messages/${threadId}`);
        if (SPOKEN.has(root.type ?? 0)) {
          messages.push(toConversationMessage(root));
        }
      } catch (error) {
        if (!notFound(error)) {
          throw error;
        }
      }
    }
    // Everything in a thread is newer than its id, but a forum post's first
    // message has the thread's own id, so the floor sits just below it.
    const floor = after ?? BigInt(threadId) - 1n;
    const { kept, more } = await collect(bot.rest, threadId, { after: floor, before, want: request.limit - messages.length, oldestFirst: true });
    messages.push(...kept.map((raw) => toConversationMessage(raw, threadId)));
    return { messages, more };
  };

  return { resolveOutbound, readConversation, conversationKindFor, threadTarget };
};
