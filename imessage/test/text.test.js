import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitMessages, toPlainText } from '../lib/text.js';

test('markdown becomes text a phone shows as meant', () => {
  assert.equal(toPlainText('# Plan\n\n**Bold**, *italic*, _under_, ~~gone~~ and `code`.'), 'Plan\n\nBold, italic, under, gone and code.');
  assert.equal(toPlainText('See [the docs](https://example.com/a_b) or <https://x.dev>.'), 'See the docs (https://example.com/a_b) or https://x.dev.');
  assert.equal(toPlainText('[https://x.dev](https://x.dev)'), 'https://x.dev');
  assert.equal(toPlainText('* one\n+ two\n- three'), '- one\n- two\n- three');
  assert.equal(toPlainText('Run:\n```sh\nnpm test\n\nnpm run lint\n```\nDone.'), 'Run:\n    npm test\n\n    npm run lint\nDone.');
  assert.equal(toPlainText('a\n\n---\n\nb'), 'a\n\nb');
});

test('markdown conversion leaves words with underscores and math alone', () => {
  assert.equal(toPlainText('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4');
  assert.equal(toPlainText('file_name.txt'), 'file_name.txt');
});

test('splitMessages keeps short text whole and cuts long text at paragraphs, then lines, then words', () => {
  assert.deepEqual(splitMessages('hi'), ['hi']);
  assert.deepEqual(splitMessages(''), []);
  const paragraphs = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
  assert.deepEqual(splitMessages(paragraphs, 100), ['a'.repeat(60), 'b'.repeat(60)]);
  const lines = `${'a'.repeat(60)}\n${'b'.repeat(60)}`;
  assert.deepEqual(splitMessages(lines, 100), ['a'.repeat(60), 'b'.repeat(60)]);
  const words = `${'a'.repeat(60)} ${'b'.repeat(60)}`;
  assert.deepEqual(splitMessages(words, 100), ['a'.repeat(60), 'b'.repeat(60)]);
  assert.deepEqual(splitMessages('x'.repeat(250), 100).map((piece) => piece.length), [100, 100, 50]);
});

test('splitMessages never cuts an emoji in half', () => {
  const text = `${'x'.repeat(99)}👍🏽${'y'.repeat(10)}`;
  const pieces = splitMessages(text, 100);
  assert.ok(pieces.every((piece) => piece.length <= 100));
  assert.equal(pieces.join(''), text);
  assert.ok(!pieces.some((piece) => /[\ud800-\udbff]$/.test(piece)));
});
