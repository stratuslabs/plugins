import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { IMAGE_ATTACHMENT_MAX_BYTES } from '@stratusagent/core';

import { CONVERTED_MAX_SIDE, readAttachments, textBlocks, unreadNote } from '../lib/attachments.js';
import { jpegSize, png, tinyJpeg, writeHeic } from './images.js';

const onMac = process.platform === 'darwin';

const folders = (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'imessage-attachments-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, 'Attachments');
  mkdirSync(path.join(directory, 'ab', '01'), { recursive: true });
  return { base, directory, at: (name) => path.join(directory, 'ab', '01', name) };
};

/** A sips stand-in that records what it was asked. */
const fakeSips = ({ dimensions = { width: 640, height: 480 }, fail } = {}) => {
  const calls = [];
  return {
    calls,
    dimensions: async (file) => {
      calls.push(['dimensions', file]);
      return dimensions;
    },
    toJpeg: async (file, out, { maxSide }) => {
      calls.push(['toJpeg', file, out, maxSide]);
      if (fail) {
        throw fail;
      }
      // A real JPEG, so the result is checked as one.
      const { createSips } = await import('../lib/attachments.js');
      await createSips().toJpeg(file, out, {});
    },
  };
};

test('a JPEG or PNG within the limits goes to the model as it is', async (t) => {
  const { directory, at } = folders(t);
  const image = png(40, 30);
  writeFileSync(at('IMG_0001.png'), image);
  const sips = fakeSips();
  const { images, texts, unread } = await readAttachments([
    { filename: at('IMG_0001.png'), mimeType: 'image/png', transferName: 'IMG_0001.png' },
  ], { directory, sips });
  assert.deepEqual(unread, []);
  assert.deepEqual(texts, []);
  assert.equal(images.length, 1);
  assert.equal(images[0].mediaType, 'image/png');
  assert.equal(images[0].name, 'IMG_0001.png');
  assert.deepEqual(Buffer.from(images[0].data, 'base64'), image);
  assert.equal(sips.calls.length, 0, 'not converted');
});

test('an iPhone HEIC is converted to JPEG at its own size', { skip: !onMac && 'needs sips' }, async (t) => {
  const { directory, at } = folders(t);
  writeHeic(at('IMG_0002.HEIC'), 640, 480);
  const { images, unread } = await readAttachments([
    { filename: at('IMG_0002.HEIC'), mimeType: 'image/heic', uti: 'public.heic', transferName: 'IMG_0002.HEIC' },
  ], { directory });
  assert.deepEqual(unread, []);
  assert.equal(images.length, 1);
  assert.equal(images[0].mediaType, 'image/jpeg');
  assert.equal(images[0].name, 'IMG_0002.HEIC');
  // sips -Z would enlarge it; it is only ever made smaller.
  assert.deepEqual(jpegSize(Buffer.from(images[0].data, 'base64')), { width: 640, height: 480 });
});

test(`a photo past ${CONVERTED_MAX_SIDE} pixels is made smaller as it converts`, { skip: !onMac && 'needs sips' }, async (t) => {
  const { directory, at } = folders(t);
  writeHeic(at('IMG_0003.HEIC'), 3000, 2000);
  const { images, unread } = await readAttachments([
    { filename: at('IMG_0003.HEIC'), mimeType: 'image/heic' },
  ], { directory });
  assert.deepEqual(unread, []);
  const size = jpegSize(Buffer.from(images[0].data, 'base64'));
  assert.equal(size.width, CONVERTED_MAX_SIDE);
  assert.ok(Math.abs(size.height - Math.round(2000 * CONVERTED_MAX_SIDE / 3000)) <= 1, `height ${size.height}`);
});

test('a PNG too large to send as it is is converted rather than dropped', async (t) => {
  const { directory, at } = folders(t);
  // Pad the file past core's per-image limit; it stays a complete PNG.
  const image = png(40, 30);
  const padded = Buffer.concat([image.subarray(0, 33), Buffer.alloc(IMAGE_ATTACHMENT_MAX_BYTES), image.subarray(33)]);
  writeFileSync(at('big.png'), padded);
  const sips = { calls: [], dimensions: async () => ({ width: 40, height: 30 }), toJpeg: async (file, out, options) => {
    sips.calls.push(options.maxSide);
    writeFileSync(out, tinyJpeg());
  } };
  const { images, unread } = await readAttachments([{ filename: at('big.png'), mimeType: 'image/png' }], { directory, sips });
  assert.deepEqual(unread, []);
  assert.equal(images[0].mediaType, 'image/jpeg');
  assert.deepEqual(sips.calls, [undefined]);
});

test('the converter only scales down, and only past the cap', async (t) => {
  const { directory, at } = folders(t);
  writeFileSync(at('a.heic'), 'not read by the fake');
  for (const [dimensions, expected] of [
    [{ width: 640, height: 480 }, undefined],
    [{ width: CONVERTED_MAX_SIDE, height: 100 }, undefined],
    [{ width: 100, height: CONVERTED_MAX_SIDE + 1 }, CONVERTED_MAX_SIDE],
    [{ width: 4032, height: 3024 }, CONVERTED_MAX_SIDE],
  ]) {
    let asked = 'not called';
    const sips = {
      dimensions: async () => dimensions,
      toJpeg: async (file, out, { maxSide }) => {
        asked = maxSide;
        writeFileSync(out, tinyJpeg());
      },
    };
    await readAttachments([{ filename: at('a.heic'), mimeType: 'image/heic' }], { directory, sips });
    assert.equal(asked, expected, JSON.stringify(dimensions));
  }
});

test('its scratch folder is gone once the message is read', async (t) => {
  const { directory, at } = folders(t);
  writeFileSync(at('a.heic'), 'x');
  let out;
  const sips = {
    dimensions: async () => ({ width: 10, height: 10 }),
    toJpeg: async (file, target) => {
      out = target;
      writeFileSync(target, tinyJpeg());
    },
  };
  await readAttachments([{ filename: at('a.heic'), mimeType: 'image/heic' }], { directory, sips });
  assert.ok(out);
  assert.equal(existsSync(path.dirname(out)), false);
});

test('a file outside Messages\' attachments folder is never read, named instead', async (t) => {
  const { base, directory, at } = folders(t);
  const secret = path.join(base, 'secret.txt');
  writeFileSync(secret, 'private');
  symlinkSync(secret, at('link.txt'));
  const warnings = [];
  const { texts, unread } = await readAttachments([
    { filename: secret, mimeType: 'text/plain', transferName: 'secret.txt' },
    { filename: at('link.txt'), mimeType: 'text/plain', transferName: 'link.txt' },
    { filename: `${directory}/../secret.txt`, mimeType: 'text/plain', transferName: 'dots.txt' },
    { filename: 'relative/notes.txt', mimeType: 'text/plain', transferName: 'relative.txt' },
  ], { directory, timeoutMs: 50, pollMs: 10, warn: (line) => warnings.push(line), label: 'row 7' });
  assert.deepEqual(texts, []);
  assert.deepEqual(unread.map(({ name, reason }) => [name, reason]), [
    ['secret.txt', 'failed'],
    ['link.txt', 'failed'],
    ['dots.txt', 'failed'],
    ['relative.txt', 'missing'],
  ]);
  assert.ok(warnings.every((line) => line.includes('row 7') && !line.includes('secret')), warnings.join('\n'));
});

test('a file still downloading is waited for', async (t) => {
  const { directory, at } = folders(t);
  const image = png(8, 8);
  setTimeout(() => writeFileSync(at('late.png'), image), 60);
  const { images, unread } = await readAttachments([{ filename: at('late.png'), mimeType: 'image/png' }], { directory, pollMs: 10 });
  assert.deepEqual(unread, []);
  assert.deepEqual(Buffer.from(images[0].data, 'base64'), image);
});

test('a file that never arrives is named once the message\'s deadline passes', async (t) => {
  const { directory, at } = folders(t);
  const started = Date.now();
  const { images, unread } = await readAttachments([
    { filename: at('never.png'), mimeType: 'image/png', transferName: 'never.png' },
    { filename: null, mimeType: 'image/jpeg', transferName: 'nofile.jpg' },
  ], { directory, timeoutMs: 80, pollMs: 10 });
  assert.deepEqual(images, []);
  assert.deepEqual(unread, [{ name: 'never.png', reason: 'missing' }, { name: 'nofile.jpg', reason: 'missing' }]);
  // One deadline for the message, not one per file.
  assert.ok(Date.now() - started < 400, `${Date.now() - started}ms`);
});

test('a stop ends the wait at once', async (t) => {
  const { directory, at } = folders(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const { unread } = await readAttachments([{ filename: at('never.png'), mimeType: 'image/png' }], { directory, signal: controller.signal, pollMs: 1000, timeoutMs: 10_000 });
  assert.equal(unread[0].reason, 'missing');
  assert.ok(Date.now() - started < 500, `${Date.now() - started}ms`);
});

test('a small text file is read into the message; other files are named with why', async (t) => {
  const { directory, at } = folders(t);
  writeFileSync(at('notes.md'), '# plan\nship it\n');
  writeFileSync(at('latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  writeFileSync(at('huge.txt'), 'x'.repeat(101 * 1024));
  writeFileSync(at('Audio Message.caf'), 'audio');
  writeFileSync(at('page.html'), '<p>hi</p>');
  const { images, texts, unread } = await readAttachments([
    { filename: at('notes.md'), mimeType: null, transferName: 'notes.md' },
    { filename: at('latin1.txt'), mimeType: 'text/plain', transferName: 'latin1.txt' },
    { filename: at('huge.txt'), mimeType: 'text/plain', transferName: 'huge.txt' },
    { filename: at('Audio Message.caf'), mimeType: 'audio/x-caf', transferName: 'Audio Message.caf' },
    { filename: at('page.html'), mimeType: 'text/html', transferName: 'page.html' },
  ], { directory });
  assert.deepEqual(images, []);
  assert.deepEqual(texts, [{ name: 'notes.md', text: '# plan\nship it\n' }]);
  assert.deepEqual(unread.map(({ name, reason }) => [name, reason]), [
    ['latin1.txt', 'unreadable'],
    ['huge.txt', 'too-large'],
    ['Audio Message.caf', 'unsupported'],
    ['page.html', 'unsupported'],
  ]);
  assert.match(textBlocks(texts), /\[Attached: notes\.md\. Its contents follow\.\]\n# plan\nship it\n\[End of notes\.md\]/);
  assert.match(unreadNote(unread), /latin1\.txt \(not readable as text or as an image\); huge\.txt \(too large to read here\); Audio Message\.caf, page\.html \(not a kind of file that can be read here\)/);
});

test('a file that claims to be an image but is not one is named as unreadable', { skip: !onMac && 'needs sips' }, async (t) => {
  const { directory, at } = folders(t);
  writeFileSync(at('fake.heic'), 'hello');
  writeFileSync(at('fake.jpg'), 'hello');
  const { images, unread } = await readAttachments([
    { filename: at('fake.heic'), mimeType: 'image/heic', transferName: 'fake.heic' },
    { filename: at('fake.jpg'), mimeType: 'image/jpeg', transferName: 'fake.jpg' },
  ], { directory });
  assert.deepEqual(images, []);
  assert.deepEqual(unread, [{ name: 'fake.heic', reason: 'unreadable' }, { name: 'fake.jpg', reason: 'unreadable' }]);
});

test('a failed conversion names the file rather than failing the message', async (t) => {
  const { directory, at } = folders(t);
  writeFileSync(at('a.heic'), 'x');
  writeFileSync(at('b.png'), png(4, 4));
  const sips = { dimensions: async () => ({ width: 10, height: 10 }), toJpeg: async () => {
    throw Object.assign(new Error('sips exited 13'), { code: 13 });
  } };
  const { images, unread } = await readAttachments([
    { filename: at('a.heic'), mimeType: 'image/heic', transferName: 'a.heic' },
    { filename: at('b.png'), mimeType: 'image/png', transferName: 'b.png' },
  ], { directory, sips });
  assert.deepEqual(unread, [{ name: 'a.heic', reason: 'unreadable' }]);
  assert.equal(images.length, 1);
});

test('~ in chat.db\'s path is the home folder', async () => {
  // Messages records ~/Library/Messages/Attachments/...; it resolves under
  // the real home, which in this test holds no such file, so it is missing,
  // not refused as outside the folder.
  const { unread } = await readAttachments([{ filename: '~/Library/Messages/Attachments/zz/none.png', mimeType: 'image/png', transferName: 'none.png' }], { timeoutMs: 30, pollMs: 10 });
  assert.deepEqual(unread, [{ name: 'none.png', reason: 'missing' }]);
});
