import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES,
  imageDimensions,
  isImageAttachmentMediaType,
} from '@stratusagent/core';

/**
 * A message's attachments, read from the files Messages keeps for them.
 *
 * chat.db names each file (attachment.filename, usually under
 * ~/Library/Messages/Attachments). Only files that resolve inside that
 * folder are read, so a row can't point the channel at any other file on
 * the Mac. Messages downloads an attachment after the message row appears,
 * so a file that isn't there yet is waited for, up to one deadline for the
 * whole message.
 *
 * Images the model takes as they are (JPEG, PNG, GIF, WebP within core's
 * limits) go as they are. Any other image, an iPhone's HEIC above all, and
 * one too large to send, is converted to JPEG with sips, made smaller if
 * its longer side is past CONVERTED_MAX_SIDE. Small UTF-8 text files are
 * read into the message. Everything else reaches the turn by name, with
 * why. Logs name the row, never a file name.
 */

export const ATTACHMENTS_DIRECTORY = path.join(homedir(), 'Library', 'Messages', 'Attachments');

/** The longest one message's files may take to arrive and be read, together. */
export const ATTACHMENTS_TIMEOUT_MS = 30_000;

/** The longer side of an image this channel converts, at most. */
export const CONVERTED_MAX_SIDE = 2048;

/** The largest image file that is converted rather than named. */
export const CONVERT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

export const TEXT_ATTACHMENT_MAX_BYTES = 100 * 1024;
export const TEXT_ATTACHMENTS_MAX_TOTAL_BYTES = 200 * 1024;

const POLL_MS = 500;
const MAX_LISTED = 5;
const SIPS = '/usr/bin/sips';

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
const IMAGE_UTIS = new Set(['public.jpeg', 'public.png', 'com.compuserve.gif', 'org.webmproject.webp', 'public.heic', 'public.heif', 'public.tiff', 'com.microsoft.bmp']);

const REASON_TEXT = {
  unsupported: 'not a kind of file that can be read here',
  'too-large': 'too large to read here',
  missing: 'not downloaded to this Mac',
  failed: 'could not be read',
  unreadable: 'not readable as text or as an image',
};

const typeOf = (attachment) => attachment.mimeType?.split(';')[0]?.trim().toLowerCase() || undefined;

const nameOf = (attachment) => attachment.transferName
  || (typeof attachment.filename === 'string' && attachment.filename.length > 0 ? path.basename(attachment.filename) : '')
  || 'an unnamed file';

const isImage = (attachment) => {
  const type = typeOf(attachment);
  return type !== undefined ? type.startsWith('image/') && type !== 'image/svg+xml' : IMAGE_UTIS.has(attachment.uti);
};

const isText = (attachment) => {
  const type = typeOf(attachment);
  if (type === 'text/html') {
    return false;
  }
  if (type !== undefined && (type.startsWith('text/') || TEXT_APPLICATION_TYPES.has(type))) {
    return true;
  }
  return (type === undefined || type === 'application/octet-stream') && TEXT_EXTENSIONS.test(nameOf(attachment));
};

/** chat.db's path for a file, with ~ expanded; undefined when it names none. */
const expand = (filename) => {
  if (typeof filename !== 'string' || filename.length === 0) {
    return undefined;
  }
  if (filename === '~' || filename.startsWith('~/')) {
    return path.join(homedir(), filename.slice(1));
  }
  return path.isAbsolute(filename) ? filename : undefined;
};

const within = (file, directory) => {
  const relative = path.relative(directory, file);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  }
  signal.addEventListener('abort', done, { once: true });
});

const run = promisify(execFile);

/** At most `limit` bytes of `file`; `over` says it held more, which a file still growing can. */
const readAtMost = async (file, limit) => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    return { body: buffer.subarray(0, Math.min(length, limit)), over: length > limit };
  } finally {
    await handle.close();
  }
};

/**
 * sips, the image tool every Mac has. `dimensions` reads an image's size
 * (undefined when sips can't read it as one) and `toJpeg` writes it as a
 * JPEG, scaled to `maxSide` when given. Neither goes through a shell.
 */
export const createSips = ({ command = SIPS } = {}) => ({
  dimensions: async (file, { signal }) => {
    const { stdout } = await run(command, ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { signal });
    const width = Number(/pixelWidth: ([0-9]+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight: ([0-9]+)/.exec(stdout)?.[1]);
    return width > 0 && height > 0 ? { width, height } : undefined;
  },
  toJpeg: async (file, out, { maxSide, signal }) => {
    await run(command, ['-s', 'format', 'jpeg', ...(maxSide ? ['-Z', String(maxSide)] : []), file, '--out', out], { signal });
  },
});

/**
 * Reads `attachments` (chat.db rows: filename, mimeType, uti, transferName,
 * totalBytes) for one message's turn. Resolves { images, texts, unread }.
 * `signal` (the turn stopped, or the channel stopping) ends the wait; what
 * was not read by then is named.
 */
export const readAttachments = async (attachments, {
  directory = ATTACHMENTS_DIRECTORY,
  sips = createSips(),
  timeoutMs = ATTACHMENTS_TIMEOUT_MS,
  pollMs = POLL_MS,
  signal,
  warn = () => {},
  label = 'a message',
} = {}) => {
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
      warn(`imessage: an attachment on ${label} ${why}; the turn is told it cannot be read.`);
    }
    unread.push({ name: nameOf(attachment), reason });
  };
  let root;
  const rootOf = async () => {
    root ??= await realpath(directory).catch(() => null);
    return root;
  };
  /**
   * The file's real path and size once it is inside the folder and fully
   * written: not empty, and as large as chat.db says when it says. A reason
   * when it won't be read.
   */
  const locate = async (attachment) => {
    const expected = Number(attachment.totalBytes ?? 0);
    let partial = false;
    for (;;) {
      const file = expand(attachment.filename);
      if (file !== undefined) {
        const real = await realpath(file).catch((error) => (error.code === 'ENOENT' ? undefined : error));
        if (real instanceof Error) {
          return { reason: 'failed', why: `could not be opened (${real.code ?? real.message})` };
        }
        if (real !== undefined) {
          const inside = await rootOf();
          if (inside === null || !within(real, inside)) {
            return { reason: 'failed', why: "is not in Messages' attachments folder, so it was not read" };
          }
          let size;
          try {
            size = (await stat(real)).size;
          } catch (error) {
            return { reason: 'failed', why: `could not be opened (${error.code ?? error.message})` };
          }
          if (size > 0 && !(expected > 0 && size < expected)) {
            return { file: real, size };
          }
          partial = true;
        }
      }
      if (both.aborted) {
        return { reason: 'missing', why: deadline.aborted ? `had not ${partial ? 'finished downloading' : 'downloaded'} after ${timeoutMs}ms` : undefined };
      }
      await sleep(pollMs, both);
    }
  };
  let scratch;
  let imageBytes = 0;
  let textBytes = 0;
  try {
    for (const attachment of attachments) {
      const image = isImage(attachment);
      const text = !image && isText(attachment);
      if (!image && !text) {
        skip(attachment, 'unsupported');
        continue;
      }
      if (image && images.length >= IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT) {
        skip(attachment, 'too-large', `is past the ${IMAGE_ATTACHMENTS_MAX_REPLAY_COUNT} images one message can carry`);
        continue;
      }
      const found = await locate(attachment);
      if (found.file === undefined) {
        skip(attachment, found.reason, found.why);
        continue;
      }
      const { size } = found;
      if (text) {
        const limit = Math.min(TEXT_ATTACHMENT_MAX_BYTES, TEXT_ATTACHMENTS_MAX_TOTAL_BYTES - textBytes);
        if (size > limit) {
          skip(attachment, 'too-large', `is ${size} bytes, over the ${limit} this message could still take`);
          continue;
        }
        let decoded;
        try {
          const read = await readAtMost(found.file, limit);
          if (read.over) {
            skip(attachment, 'too-large', `grew past the ${limit} bytes this message could still take`);
            continue;
          }
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(read.body);
        } catch (error) {
          skip(attachment, error instanceof TypeError ? 'unreadable' : 'failed', error instanceof TypeError ? 'is not UTF-8 text' : `could not be read (${error.code ?? error.message})`);
          continue;
        }
        textBytes += Buffer.byteLength(decoded);
        texts.push({ name: nameOf(attachment), text: decoded });
        continue;
      }
      const limit = Math.min(IMAGE_ATTACHMENT_MAX_BYTES, IMAGE_ATTACHMENTS_MAX_TOTAL_BYTES - imageBytes);
      const type = typeOf(attachment);
      let body;
      let mediaType;
      if (isImageAttachmentMediaType(type) && size <= limit) {
        try {
          const read = await readAtMost(found.file, limit);
          // A file that grew past the limit is converted like any large image.
          body = read.over ? undefined : read.body;
        } catch (error) {
          skip(attachment, 'failed', `could not be read (${error.code ?? error.message})`);
          continue;
        }
        const dimensions = body && imageDimensions(body, type);
        if (dimensions !== undefined && dimensions.width <= IMAGE_ATTACHMENT_MAX_DIMENSION && dimensions.height <= IMAGE_ATTACHMENT_MAX_DIMENSION) {
          mediaType = type;
        } else {
          body = undefined;
        }
      }
      if (body === undefined) {
        // Not a type the model takes, too large, or not what its type says: sips.
        if (size > CONVERT_SOURCE_MAX_BYTES) {
          skip(attachment, 'too-large', `is ${size} bytes, over the ${CONVERT_SOURCE_MAX_BYTES} this channel converts`);
          continue;
        }
        if (both.aborted) {
          skip(attachment, 'missing', deadline.aborted ? `was not converted: this message's files took longer than ${timeoutMs}ms` : undefined);
          continue;
        }
        try {
          const dimensions = await sips.dimensions(found.file, { signal: both });
          if (dimensions === undefined) {
            skip(attachment, 'unreadable', 'is not an image sips can read');
            continue;
          }
          scratch ??= await mkdtemp(path.join(tmpdir(), 'stratus-imessage-'));
          const out = path.join(scratch, `${images.length}-${unread.length}.jpg`);
          const maxSide = Math.max(dimensions.width, dimensions.height) > CONVERTED_MAX_SIDE ? CONVERTED_MAX_SIDE : undefined;
          await sips.toJpeg(found.file, out, { maxSide, signal: both });
          body = await readFile(out);
        } catch (error) {
          if (both.aborted) {
            skip(attachment, 'missing', deadline.aborted ? `was not converted: this message's files took longer than ${timeoutMs}ms` : undefined);
          } else {
            skip(attachment, 'unreadable', `could not be converted to JPEG (${error.code ?? error.message})`);
          }
          continue;
        }
        const dimensions = imageDimensions(body, 'image/jpeg');
        if (dimensions === undefined) {
          skip(attachment, 'unreadable', 'did not convert to a complete JPEG');
          continue;
        }
        if (body.length > limit || dimensions.width > IMAGE_ATTACHMENT_MAX_DIMENSION || dimensions.height > IMAGE_ATTACHMENT_MAX_DIMENSION) {
          skip(attachment, 'too-large', `is ${body.length} bytes as a JPEG, over the ${limit} this message could still take`);
          continue;
        }
        mediaType = 'image/jpeg';
      }
      imageBytes += body.length;
      images.push({ mediaType, data: body.toString('base64'), name: nameOf(attachment) });
    }
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
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
