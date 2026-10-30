import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES,
  imageDimensions,
  isImageAttachmentMediaType,
} from '@stratusagent/core';

/**
 * Where Discord serves attachments. A message's attachment URLs come from
 * Discord, but they are fetched only from these hosts, over https, and
 * never with the bot token: the CDN's links are signed, so they need none.
 */
export const CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

/** The longest one message's downloads may take together. */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** The most one text attachment may weigh to be read into the message, and all of a message's together. */
export const TEXT_ATTACHMENT_MAX_BYTES = 100 * 1024;
export const TEXT_ATTACHMENTS_MAX_TOTAL_BYTES = 200 * 1024;

/** At most this many unread attachment names are listed; the rest are counted. */
const MAX_LISTED = 5;

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/x-sh',
  'application/sql',
]);
const TEXT_EXTENSIONS = /\.(md|markdown|txt|text|csv|tsv|json|ya?ml|toml|xml|log|ini|conf)$/i;

const REASON_TEXT = {
  unsupported: 'not a kind of file that can be read here',
  'too-large': 'too large to read here',
  failed: 'could not be downloaded',
  'timed-out': 'not downloaded in time',
  unreadable: 'not readable as text or as an image',
};

/** Discord's content type without parameters, lowercased; undefined when absent. */
const typeOf = (attachment) => attachment.content_type?.split(';')[0]?.trim().toLowerCase() || undefined;

const nameOf = (attachment) => attachment.filename || 'an unnamed file';

/**
 * Whether an attachment is text the model can be handed as it is. HTML is
 * left out (it is what an error page is too). An unhelpful type falls back
 * to the name, the same rule as channel-slack.
 */
export const isTextAttachment = (attachment) => {
  const type = typeOf(attachment);
  if (type === 'text/html') {
    return false;
  }
  if (type !== undefined && (type.startsWith('text/') || TEXT_APPLICATION_TYPES.has(type))) {
    return true;
  }
  return (type === undefined || type === 'application/octet-stream') && TEXT_EXTENSIONS.test(attachment.filename ?? '');
};

const allowedUrl = (url, cdnHosts) => {
  try {
    const parsed = new URL(url);
    return cdnHosts.some((host) => {
      if (host.includes('://')) {
        // A test's own CDN, given as an origin.
        return parsed.origin === new URL(host).origin;
      }
      return parsed.protocol === 'https:' && parsed.hostname === host;
    });
  } catch {
    return false;
  }
};

/** GETs `url` and reads at most `limit` bytes of it; `truncated` says there was more. */
const download = async (fetchImpl, url, signal, limit) => {
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return { body: Buffer.concat(chunks), truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { body: Buffer.concat(chunks), truncated: false };
};

/**
 * A message's attachments, read for its turn: images the model can take
 * go as images, small UTF-8 text files are read into the message, and
 * everything else reaches the turn by name, with why. One deadline covers
 * the whole message's downloads, and `signal` (the channel stopping) ends
 * them too. Limits are core's, so an image that would fail the turn, or
 * every later one once stored, is a name instead.
 */
export const readAttachments = async (attachments, { fetch: fetchImpl = globalThis.fetch, cdnHosts = CDN_HOSTS, timeoutMs = DOWNLOAD_TIMEOUT_MS, signal, warn = () => {} } = {}) => {
  const images = [];
  const texts = [];
  const unread = [];
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { images, texts, unread };
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const skip = (attachment, reason, why) => {
    if (why) {
      warn(`discord: ${nameOf(attachment)} ${why}; the turn is told it cannot be read.`);
    }
    unread.push({ name: nameOf(attachment), reason });
  };
  let imageBytes = 0;
  let textBytes = 0;
  for (const attachment of attachments) {
    const type = typeOf(attachment);
    const image = isImageAttachmentMediaType(type);
    const text = !image && isTextAttachment(attachment);
    if (!image && !text) {
      skip(attachment, 'unsupported');
      continue;
    }
    if (typeof attachment.url !== 'string' || !allowedUrl(attachment.url, cdnHosts)) {
      skip(attachment, 'failed', `is not on Discord's CDN (${CDN_HOSTS.join(', ')}), so it was not downloaded`);
      continue;
    }
    let limit;
    if (image) {
      if (images.length >= IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT) {
        skip(attachment, 'too-large', `is past the ${IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT} images one message can carry`);
        continue;
      }
      limit = Math.min(IMAGE_ATTACHMENT_MAX_BYTES, IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES - imageBytes);
      const side = Math.max(attachment.width ?? 0, attachment.height ?? 0);
      if (side > IMAGE_ATTACHMENT_MAX_DIMENSION) {
        skip(attachment, 'too-large', `is ${attachment.width}×${attachment.height}, over the ${IMAGE_ATTACHMENT_MAX_DIMENSION}-pixel side the model can take`);
        continue;
      }
    } else {
      limit = Math.min(TEXT_ATTACHMENT_MAX_BYTES, TEXT_ATTACHMENTS_MAX_TOTAL_BYTES - textBytes);
    }
    if (typeof attachment.size === 'number' && attachment.size > limit) {
      skip(attachment, 'too-large', `is ${attachment.size} bytes, over the ${limit} this message could still take`);
      continue;
    }
    if (both.aborted) {
      skip(attachment, 'timed-out', deadline.aborted ? `was not downloaded: this message's downloads took longer than ${timeoutMs}ms` : undefined);
      continue;
    }
    let got;
    try {
      got = await download(fetchImpl, attachment.url, both, limit);
    } catch (error) {
      if (deadline.aborted) {
        skip(attachment, 'timed-out', `was not downloaded: this message's downloads took longer than ${timeoutMs}ms`);
      } else if (signal?.aborted) {
        skip(attachment, 'timed-out');
      } else {
        skip(attachment, 'failed', `could not be downloaded: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (got.truncated) {
      skip(attachment, 'too-large', `is larger than the ${limit} bytes this message could still take`);
      continue;
    }
    if (image) {
      const dimensions = imageDimensions(got.body, type);
      if (dimensions === undefined) {
        skip(attachment, 'unreadable', `is not a complete ${type} image`);
        continue;
      }
      if (dimensions.width > IMAGE_ATTACHMENT_MAX_DIMENSION || dimensions.height > IMAGE_ATTACHMENT_MAX_DIMENSION) {
        skip(attachment, 'too-large', `is ${dimensions.width}×${dimensions.height}, over the ${IMAGE_ATTACHMENT_MAX_DIMENSION}-pixel side the model can take`);
        continue;
      }
      imageBytes += got.body.length;
      images.push({ mediaType: type, data: got.body.toString('base64'), name: nameOf(attachment) });
      continue;
    }
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(got.body);
    } catch {
      skip(attachment, 'unreadable', 'is not UTF-8 text');
      continue;
    }
    textBytes += got.body.length;
    texts.push({ name: nameOf(attachment), text: decoded });
  }
  return { images, texts, unread };
};

/** Read text files, set into the message after what was said. */
export const textBlocks = (texts) =>
  texts.map(({ name, text }) => `\n[Attached: ${name}. Its contents follow.]\n${text.replace(/\s+$/, '')}\n[End of ${name}]`).join('');

/**
 * The attachments the turn could not open, named with why, so the agent
 * says it has only the names rather than answering as though it had read
 * them. Images it was shown travel on the dispatch and aren't listed.
 */
export const unreadNote = (unread) => {
  if (unread.length === 0) {
    return '';
  }
  const listed = unread.slice(0, MAX_LISTED);
  const groups = new Map();
  for (const { name, reason } of listed) {
    groups.set(reason, [...(groups.get(reason) ?? []), name]);
  }
  const parts = [...groups].map(([reason, names]) => `${names.join(', ')} (${REASON_TEXT[reason]})`);
  const rest = unread.length - listed.length;
  const all = rest > 0 ? `${parts.join('; ')}; and ${rest} more` : parts.join('; ');
  return `\n[Attached, name only: ${all}. You have only the names, so say so rather than guessing at what is in them.]`;
};
