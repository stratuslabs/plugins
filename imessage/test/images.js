import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

/** Test images, written for real, so the channel reads actual files. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

/** A complete RGB PNG of `width`×`height`, a gradient. */
export const png = (width, height) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = x & 255;
      raw[at + 1] = y & 255;
      raw[at + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** Writes a HEIC of `width`×`height` to `file` with the Mac's own sips, as an iPhone photo arrives. */
export const writeHeic = (file, width, height) => {
  const source = `${file}.source.png`;
  writeFileSync(source, png(width, height));
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', source, '--out', file], { stdio: 'ignore' });
};

/** The size a JPEG's SOF header gives. */
export const jpegSize = (bytes) => {
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) {
      return undefined;
    }
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
};

let tiny;
/** A real 16×8 JPEG, written by sips once. */
export const tinyJpeg = () => {
  if (!tiny) {
    const directory = mkdtempSync(path.join(tmpdir(), 'imessage-jpeg-'));
    try {
      writeFileSync(path.join(directory, 'a.png'), png(16, 8));
      execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', path.join(directory, 'a.png'), '--out', path.join(directory, 'a.jpg')], { stdio: 'ignore' });
      tiny = readFileSync(path.join(directory, 'a.jpg'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return tiny;
};
