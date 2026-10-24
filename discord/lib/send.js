import { chunk } from './chunk.js';

const Routes = {
  channelMessages: (channel) => `/channels/${channel}/messages`,
  channelMessage: (channel, message) => `/channels/${channel}/messages/${message}`,
  channelTyping: (channel) => `/channels/${channel}/typing`,
  threads: (channel, message) => `/channels/${channel}/messages/${message}/threads`,
};

/** SUPPRESS_EMBEDS: no link previews unless asked for. */
const SUPPRESS_EMBEDS = 1 << 2;

/**
 * Nothing an agent writes pings anyone: `@everyone`, a role or a user id in
 * the text stays text. A reply doesn't ping its author either.
 */
const NO_PINGS = { parse: [], replied_user: false };

/**
 * Post `text` in a channel or thread, split into Discord-sized messages.
 * The first part replies to `replyTo` when given. Returns the posted ids in
 * order.
 */
export const postText = async (rest, channelId, text, { replyTo, embeds = false } = {}) => {
  const ids = [];
  for (const [index, part] of chunk(text).entries()) {
    const body = {
      content: part,
      allowed_mentions: NO_PINGS,
      ...(embeds ? {} : { flags: SUPPRESS_EMBEDS }),
      ...(index === 0 && replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    };
    const posted = await rest.post(Routes.channelMessages(channelId), { body });
    ids.push(posted.id);
  }
  return ids;
};

/** Replace one message's text: the streaming edit. Text over the limit is the caller's to split. */
export const editText = (rest, channelId, messageId, text) =>
  rest.patch(Routes.channelMessage(channelId, messageId), { body: { content: text, allowed_mentions: NO_PINGS } });

/** "Agent is typing…" for about ten seconds. */
export const typing = (rest, channelId) => rest.post(Routes.channelTyping(channelId));

/**
 * Open a thread on a top-level message and return its id: a mention in a
 * channel is answered in a thread of its own, one session per thread.
 */
export const threadFrom = async (rest, channelId, messageId, name) => {
  const thread = await rest.post(Routes.threads(channelId, messageId), {
    body: { name: (name.trim() || 'Conversation').slice(0, 100), auto_archive_duration: 1440 },
  });
  return thread.id;
};
