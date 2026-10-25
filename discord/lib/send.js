import { open } from 'node:fs/promises';
import path from 'node:path';
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

/** Post one message with components (an approval prompt). Returns its id. */
export const postPrompt = async (rest, channelId, { content, components }) => {
  const posted = await rest.post(Routes.channelMessages(channelId), {
    body: { content, components, allowed_mentions: NO_PINGS, flags: SUPPRESS_EMBEDS },
  });
  return posted.id;
};

/** Rewrite a prompt: new text, and the buttons it still offers (none once settled). */
export const editPrompt = (rest, channelId, messageId, { content, components = [] }) =>
  rest.patch(Routes.channelMessage(channelId, messageId), { body: { content, components, allowed_mentions: NO_PINGS } });

/**
 * Answer a button click. Discord wants this within three seconds or shows
 * the clicker "This interaction failed". It is authorized by the
 * interaction's own token, not the bot's.
 */
export const answerInteraction = (rest, interaction, body) =>
  rest.post(`/interactions/${interaction.id}/${interaction.token}/callback`, { body, auth: false });

/** Take a message down: a streamed piece the reply no longer needs. One already gone (404) counts as taken down. */
export const removeMessage = async (rest, channelId, messageId) => {
  try {
    await rest.delete(Routes.channelMessage(channelId, messageId));
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
  }
};

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

/**
 * The most a bot may upload in one file to a server with no boost, and to
 * a DM. A boosted server takes more, but the bot can't cheaply tell, so
 * this is the one limit it holds to.
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload a local file as a message of its own (a chart, a screenshot a
 * tool made), named by its basename, with `title` as its text when given.
 * Read through one open handle, so what is checked is what is sent.
 * Returns the message id.
 */
export const uploadFile = async (rest, channelId, filePath, { title } = {}) => {
  const handle = await open(filePath, 'r');
  let data;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`${filePath} is not a file`);
    }
    if (info.size > UPLOAD_MAX_BYTES) {
      throw new Error(`${path.basename(filePath)} is ${info.size} bytes, over the ${UPLOAD_MAX_BYTES} bytes Discord takes from a bot`);
    }
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (data.length > UPLOAD_MAX_BYTES) {
    throw new Error(`${path.basename(filePath)} grew past the ${UPLOAD_MAX_BYTES} bytes Discord takes from a bot while it was read`);
  }
  const posted = await rest.post(Routes.channelMessages(channelId), {
    body: { ...(title ? { content: title.slice(0, 2000) } : {}), allowed_mentions: NO_PINGS, flags: SUPPRESS_EMBEDS },
    files: [{ name: path.basename(filePath), data }],
  });
  return posted.id;
};
