import assert from 'node:assert/strict';
import test from 'node:test';
import { readAttachments, textBlocks, unreadNote } from '../lib/attachments.js';
import { png } from './png.js';

const CDN = 'https://cdn.discordapp.com/attachments/1/2';

/** A fetch that serves `files` (url -> Buffer or { status }) and records what it was asked. */
const fakeFetch = (files, { delayMs = 0 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal.reason);
        }, { once: true });
      });
    }
    const file = files[url];
    if (!Buffer.isBuffer(file)) {
      return new Response(null, { status: file?.status ?? 404 });
    }
    return new Response(file, { status: 200 });
  };
  return { fetchImpl, calls };
};

const attachment = (fields) => ({ id: '1', filename: 'a.png', content_type: 'image/png', size: 10, url: `${CDN}/a.png`, ...fields });

test('an image goes as an image, with its name, fetched without any token', async () => {
  const bytes = png(2, 3);
  const { fetchImpl, calls } = fakeFetch({ [`${CDN}/a.png`]: bytes });
  const result = await readAttachments([attachment({ size: bytes.length, width: 2, height: 3 })], { fetch: fetchImpl });
  assert.deepEqual(result.images, [{ mediaType: 'image/png', data: bytes.toString('base64'), name: 'a.png' }]);
  assert.deepEqual(result.unread, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers, undefined, 'no Authorization: the CDN link is signed');
  assert.equal(calls[0].init.redirect, 'error');
});

test('a small UTF-8 text file is read into the message; HTML and non-UTF-8 are not', async () => {
  const { fetchImpl } = fakeFetch({
    [`${CDN}/notes.md`]: Buffer.from('# Plan\nship it\n\n'),
    [`${CDN}/bin.log`]: Buffer.from([0xff, 0xfe, 0x00]),
  });
  const result = await readAttachments([
    attachment({ filename: 'notes.md', content_type: 'text/markdown; charset=utf-8', url: `${CDN}/notes.md` }),
    attachment({ filename: 'bin.log', content_type: undefined, url: `${CDN}/bin.log` }),
    attachment({ filename: 'page.html', content_type: 'text/html', url: `${CDN}/page.html` }),
    attachment({ filename: 'report.pdf', content_type: 'application/pdf', url: `${CDN}/report.pdf` }),
  ], { fetch: fetchImpl });
  assert.deepEqual(result.texts, [{ name: 'notes.md', text: '# Plan\nship it\n\n' }]);
  assert.deepEqual(result.unread, [
    { name: 'bin.log', reason: 'unreadable' },
    { name: 'page.html', reason: 'unsupported' },
    { name: 'report.pdf', reason: 'unsupported' },
  ]);
  assert.equal(textBlocks(result.texts), '\n[Attached: notes.md. Its contents follow.]\n# Plan\nship it\n[End of notes.md]');
});

test('only Discord\'s CDN is fetched, over https', async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const warns = [];
  const result = await readAttachments([
    attachment({ url: 'https://evil.example/a.png' }),
    attachment({ url: 'http://cdn.discordapp.com/a.png' }),
    attachment({ url: 'https://cdn.discordapp.com.evil.example/a.png' }),
    attachment({ url: 'not a url' }),
  ], { fetch: fetchImpl, warn: (line) => warns.push(line) });
  assert.equal(calls.length, 0);
  assert.deepEqual(result.unread.map((entry) => entry.reason), ['failed', 'failed', 'failed', 'failed']);
  assert.match(warns[0], /not on Discord's CDN/);
});

test('an image that would fail the turn is a name: wrong bytes, too many pixels, too heavy, past the count', async () => {
  const big = png(9000, 1);
  const real = png(1, 1);
  const files = { [`${CDN}/fake.png`]: Buffer.from('GIF89a not a png'), [`${CDN}/wide.png`]: big };
  for (let i = 0; i < 21; i += 1) files[`${CDN}/n${i}.png`] = real;
  const { fetchImpl } = fakeFetch(files);
  const result = await readAttachments([
    attachment({ filename: 'fake.png', url: `${CDN}/fake.png` }),
    attachment({ filename: 'wide.png', url: `${CDN}/wide.png` }), // Discord didn't say its size
    attachment({ filename: 'said-wide.png', url: `${CDN}/wide.png`, width: 8001, height: 2 }),
    attachment({ filename: 'heavy.png', size: 5 * 1024 * 1024 + 1 }),
    ...Array.from({ length: 21 }, (_, i) => attachment({ filename: `n${i}.png`, url: `${CDN}/n${i}.png` })),
  ], { fetch: fetchImpl });
  assert.equal(result.images.length, 20);
  assert.deepEqual(result.unread, [
    { name: 'fake.png', reason: 'unreadable' },
    { name: 'wide.png', reason: 'too-large' },
    { name: 'said-wide.png', reason: 'too-large' },
    { name: 'heavy.png', reason: 'too-large' },
    { name: 'n20.png', reason: 'too-large' },
  ]);
});

test('a download that turns out bigger than it said is abandoned at the limit', async () => {
  const { fetchImpl } = fakeFetch({ [`${CDN}/big.txt`]: Buffer.alloc(150 * 1024, 'a') });
  const result = await readAttachments([attachment({ filename: 'big.txt', content_type: 'text/plain', size: 10, url: `${CDN}/big.txt` })], { fetch: fetchImpl });
  assert.deepEqual(result.texts, []);
  assert.deepEqual(result.unread, [{ name: 'big.txt', reason: 'too-large' }]);
});

test('text past what the message can still take is a name', async () => {
  const files = { [`${CDN}/one.txt`]: Buffer.alloc(90 * 1024, 'a'), [`${CDN}/two.txt`]: Buffer.alloc(90 * 1024, 'b'), [`${CDN}/three.txt`]: Buffer.alloc(90 * 1024, 'c') };
  const { fetchImpl } = fakeFetch(files);
  const result = await readAttachments(['one', 'two', 'three'].map((n) => attachment({ filename: `${n}.txt`, content_type: 'text/plain', size: 90 * 1024, url: `${CDN}/${n}.txt` })), { fetch: fetchImpl });
  assert.deepEqual(result.texts.map((entry) => entry.name), ['one.txt', 'two.txt']);
  assert.deepEqual(result.unread, [{ name: 'three.txt', reason: 'too-large' }]);
});

test('a failed download and a slow one are named with why; one deadline covers the message', async () => {
  const { fetchImpl } = fakeFetch({ [`${CDN}/gone.png`]: { status: 404 } });
  const failed = await readAttachments([attachment({ filename: 'gone.png', url: `${CDN}/gone.png` })], { fetch: fetchImpl });
  assert.deepEqual(failed.unread, [{ name: 'gone.png', reason: 'failed' }]);

  const slow = fakeFetch({ [`${CDN}/a.png`]: png(1, 1), [`${CDN}/b.png`]: png(1, 1) }, { delayMs: 200 });
  const started = Date.now();
  const timed = await readAttachments([attachment({ filename: 'a.png' }), attachment({ filename: 'b.png', url: `${CDN}/b.png` })], { fetch: slow.fetchImpl, timeoutMs: 50 });
  assert.ok(Date.now() - started < 180, 'the second file is not waited on after the deadline');
  assert.deepEqual(timed.unread, [{ name: 'a.png', reason: 'timed-out' }, { name: 'b.png', reason: 'timed-out' }]);
  assert.equal(slow.calls.length, 1);
});

test('the channel stopping ends the downloads', async () => {
  const slow = fakeFetch({ [`${CDN}/a.png`]: png(1, 1) }, { delayMs: 5000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stopping')), 20);
  const started = Date.now();
  const result = await readAttachments([attachment({})], { fetch: slow.fetchImpl, signal: controller.signal });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(result.unread, [{ name: 'a.png', reason: 'timed-out' }]);
});

test('the note names what was not read and why, five at most', () => {
  assert.equal(unreadNote([]), '');
  assert.equal(
    unreadNote([{ name: 'r.pdf', reason: 'unsupported' }, { name: 'x.zip', reason: 'unsupported' }, { name: 'big.png', reason: 'too-large' }]),
    '\n[Attached, name only: r.pdf, x.zip (not a kind of file that can be read here); big.png (too large to read here). You have only the names, so say so rather than guessing at what is in them.]',
  );
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, reason: 'failed' }));
  assert.match(unreadNote(many), /f0, f1, f2, f3, f4 \(could not be downloaded\); and 2 more\./);
});
