// Two layers stand between a home and a git history that is forever:
//
// 1. Replacement. Every value the home knows to be secret (each string in
//    credentials.json, and the control API token) is replaced wherever it
//    appears, in the encodings a copy commonly takes: raw, JSON-escaped (in
//    any valid escape spelling, at any depth), percent-encoded, base64 and
//    hex (either case of digit).
// 2. A scan. Anything still shaped like a well-known key stops the run
//    before anything is committed. A finding names the file, the line and
//    the kind of key, never the text.
//
// Neither layer can find a secret an agent rewrote into a form nothing
// recognizes. That limit is stated in the README rather than papered over.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const REDACTED = '[redacted by stratus-backup]';

/** Shorter strings are too likely to be ordinary words to replace everywhere. */
const MIN_SECRET_LENGTH = 8;

/**
 * Fields that hold a label, not a secret, in a credential record: an object
 * whose `value` is the secret ({ type, value, baseUrl }). Anywhere else (a
 * named credential called `source`, say) the same key names a secret.
 */
const NON_SECRET_KEYS = new Set(['type', 'baseUrl', 'provider', 'kind', 'createdAt', 'updatedAt', 'source']);

const readIfPresent = async (file) => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};

/**
 * Codex's "sign-in" is a marker that the machine uses its own `codex login`;
 * the stored value is the fixed word "chatgpt", never a secret.
 */
const isCodexMarker = (key, value) =>
  key === 'codex' && value !== null && typeof value === 'object' && value.type === 'oauth_token' && value.value === 'chatgpt';

const isCredentialRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.value === 'string';

const collectStrings = (value, out, key, at, short, inRecord = false) => {
  if (typeof value === 'string') {
    if (inRecord && key !== 'value' && NON_SECRET_KEYS.has(key)) return;
    // The exact value is the secret: its encodings include any surrounding
    // whitespace. The trimmed form is kept too, for copies pasted without it.
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) {
      out.add(value);
      out.add(trimmed);
    } else if (value.length > 0) short.push(at); // whitespace-only counts as short too
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, out, key, `${at}[${index}]`, short));
  } else if (value !== null && typeof value === 'object') {
    const record = isCredentialRecord(value);
    for (const [childKey, child] of Object.entries(value)) {
      if (isCodexMarker(childKey, child)) continue;
      collectStrings(child, out, childKey, at ? `${at}.${childKey}` : childKey, short, record);
    }
  }
};

/**
 * Every value this home stores as a secret. A credentials file that will not
 * parse fails the run: backing up while blind to the secrets is the one
 * outcome that cannot be undone.
 */
export const collectKnownSecrets = async (home) => {
  const secrets = new Set();
  const credentialsFile = path.join(home, 'credentials.json');
  const raw = await readIfPresent(credentialsFile);
  if (raw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${credentialsFile} is not valid JSON, so the secrets it holds cannot be kept out of the backup. Fix the file first.`);
    }
    // A secret too short to replace safely (it could be an ordinary word in
    // any file) is not silently treated as non-secret: the run stops, naming
    // where it is stored, never its value.
    const short = [];
    collectStrings(parsed, secrets, undefined, '', short);
    if (short.length > 0) {
      throw new Error(
        `${credentialsFile} stores ${short.length === 1 ? 'a value' : 'values'} shorter than ${MIN_SECRET_LENGTH} characters `
        + `(${short.join(', ')}), too short to redact safely, so the backup stops rather than commit it unredacted. `
        + 'Replace it with a longer secret, or remove it.',
      );
    }
  }
  const token = await readIfPresent(path.join(home, 'gateway-token'));
  if (token !== undefined && token.trim().length > 0) {
    if (token.trim().length < MIN_SECRET_LENGTH) {
      throw new Error(`The control API token in gateway-token is shorter than ${MIN_SECRET_LENGTH} characters, too short to redact safely, so the backup stops. Rotate it to a longer token.`);
    }
    secrets.add(token.trim());
  }
  return secrets;
};

/** The byte sequences one secret is replaced in. */
export const encodingsOf = (secret) => {
  const forms = new Set([
    secret,
    JSON.stringify(secret).slice(1, -1),
    // JSON stored inside a JSON string, as a schedule body is in schedules.jsonl.
    JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1),
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64').replace(/=+$/, ''),
    Buffer.from(secret).toString('base64url'),
    encodeURIComponent(secret),
  ]);
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH);
};

const hexDigit = (digit) => (/[A-Fa-f]/.test(digit) ? `[${digit.toUpperCase()}${digit.toLowerCase()}]` : digit);
const hexOf = (number, width) => number.toString(16).toUpperCase().padStart(width, '0');

/** JSON's short escapes, the character after the backslash. */
const SHORT_ESCAPES = new Map([['"', '"'], ['\\', '\\'], ['/', '/'], ['\b', 'b'], ['\f', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't']]);

/**
 * One character of a secret, in every spelling a copy can take: its own
 * bytes, each byte percent-encoded (either case of hex digit), a JSON
 * \uXXXX escape (either case) or JSON short escape, and a space as the
 * + of form encoding. An escape may sit under
 * any depth of further JSON escaping, so its backslash is "one or more".
 * Matched over the buffer read as latin1, byte for byte.
 */
const characterPattern = (char) => {
  const bytes = [...Buffer.from(char)].map((byte) => `(?:\\x${hexOf(byte, 2)}|%${hexDigit(hexOf(byte, 2)[0])}${hexDigit(hexOf(byte, 2)[1])})`).join('');
  const units = [];
  for (let index = 0; index < char.length; index += 1) {
    const hex = hexOf(char.charCodeAt(index), 4);
    units.push(`\\\\+u${[...hex].map(hexDigit).join('')}`);
  }
  const alternatives = [bytes, units.join('')];
  // Form encoding (application/x-www-form-urlencoded) writes a space as +.
  if (char === ' ') alternatives.push('\\x2B');
  const short = SHORT_ESCAPES.get(char);
  if (short === '\\') alternatives.push('\\\\+');
  else if (short !== undefined) alternatives.push(`\\\\+\\x${hexOf(short.charCodeAt(0), 2)}`);
  return `(?:${alternatives.join('|')})`;
};

/**
 * A pattern for the secret in any mix of those spellings. The secret's own
 * letters still match only as written. This one pattern stands in for the
 * raw, JSON-escaped (at any depth) and percent-encoded needles: an encoder's
 * choice of which characters to escape cannot slip past it.
 */
export const escapePatternOf = (secret) => new RegExp([...secret].map(characterPattern).join(''), 'g');

/**
 * The secret as hex, each digit in either case, since encoders differ and
 * some mix them. Spaces, tabs and one line break are allowed between bytes:
 * `od -An -tx1` spaces bytes and wraps every 16, `xxd -p` wraps every 30.
 */
export const hexPatternOf = (secret) => {
  const between = '[ \\t]*(?:\\r?\\n)?[ \\t]*';
  const bytes = Buffer.from(secret).toString('hex').match(/../g).map((pair) => [...pair].map(hexDigit).join(''));
  return new RegExp(bytes.join(between), 'g');
};

/**
 * The secret's base64 (standard and URL-safe) with a line break allowed
 * between any two characters: GNU `base64` wraps at 76 columns by default,
 * openssl and PEM at 64, so a long secret's encoding spans lines. Padding
 * is optional, as it is in the contiguous forms.
 */
export const wrappedBase64PatternOf = (secret) => {
  const forms = new Set([
    Buffer.from(secret).toString('base64').replace(/=+$/, ''),
    Buffer.from(secret).toString('base64url'),
  ]);
  const wrap = '(?:\\r?\\n)?';
  const body = [...forms].map((form) => [...form].map((char) => char.replace(/[+/\\-]/g, '\\$&')).join(wrap));
  return new RegExp(`(?:${body.join('|')})(?:${wrap}=){0,2}`, 'g');
};

/** Builds the replacement list once per run, longest first so no form is left half-replaced, then the escape patterns. */
export const needlesFor = (secrets) => [
  ...[...new Set([...secrets].flatMap(encodingsOf))]
    .sort((a, b) => b.length - a.length)
    .map((form) => Buffer.from(form)),
  ...[...secrets].filter((secret) => secret.length >= MIN_SECRET_LENGTH).flatMap((secret) => [escapePatternOf(secret), hexPatternOf(secret), wrappedBase64PatternOf(secret)]),
];

/**
 * Markers in order of preference. The empty one contains no secret by
 * construction, so one of them always qualifies.
 */
const MARKERS = [REDACTED, '[redacted]', '[removed]', '***', ''];

const matches = (needle, text) => {
  if (needle instanceof RegExp) {
    needle.lastIndex = 0;
    const found = needle.test(text);
    needle.lastIndex = 0;
    return found;
  }
  return Buffer.from(text).includes(needle);
};

/**
 * Codex P1 4310180286: the marker must not itself contain a secret, or
 * replacing `stratus-backup` with `[redacted by stratus-backup]` writes the
 * secret straight back. The first marker no needle matches is used.
 */
const markerFor = (needles) => MARKERS.find((marker) => !needles.some((needle) => matches(needle, marker)));

const redactPass = (buffer, needles, marker) => {
  const replacement = Buffer.from(marker);
  let current = buffer;
  let count = 0;
  for (const needle of needles) {
    if (needle instanceof RegExp) {
      const text = current.toString('latin1');
      let found = 0;
      const replaced = text.replace(needle, () => { found += 1; return marker; });
      if (found > 0) {
        count += found;
        current = Buffer.from(replaced, 'latin1');
      }
      continue;
    }
    let index = current.indexOf(needle);
    if (index === -1) continue;
    const parts = [];
    let start = 0;
    while (index !== -1) {
      parts.push(current.subarray(start, index), replacement);
      count += 1;
      start = index + needle.length;
      index = current.indexOf(needle, start);
    }
    parts.push(current.subarray(start));
    current = Buffer.concat(parts);
  }
  return { buffer: current, count };
};

/**
 * Replaces every needle in a buffer. Works on bytes, so binary files are
 * covered too. Passes repeat until one finds nothing, since a replacement
 * can join the text around it into a new occurrence; a buffer that will
 * not come clean is refused rather than written with a secret in it.
 */
export const redactBuffer = (buffer, needles) => {
  const marker = markerFor(needles);
  let current = buffer;
  let count = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const result = redactPass(current, needles, marker);
    if (result.count === 0) return { buffer: current, count };
    current = result.buffer;
    count += result.count;
  }
  throw new Error('A known secret kept reappearing while it was being redacted; not writing this file.');
};

/** Shapes of well-known keys. Names only: a finding never carries the match. */
export const KEY_PATTERNS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ['Slack token', /\bxox[abposre]-[A-Za-z0-9-]{10,}/g],
  ['Slack app token', /\bxapp-\d-[A-Za-z0-9-]{10,}/g],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['Stripe secret key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ['Fly.io token', /\bFlyV1 [A-Za-z0-9+/=_,-]{20,}/g],
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
];

/**
 * A stable id for one finding: the file and the matched text, hashed. It is
 * what an operator passes to `stratus-backup allow` for a false positive,
 * and it cannot be turned back into the text.
 */
export const findingId = (file, match) =>
  createHash('sha256').update(file).update('\0').update(match).digest('hex').slice(0, 16);

export const scanBuffer = (file, buffer) => {
  const text = buffer.toString('latin1');
  const findings = [];
  for (const [kind, pattern] of KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ file, line, kind, id: findingId(file, match[0]) });
    }
  }
  return findings;
};

const SENSITIVE_KEY = /(token|secret|password|passwd|passphrase|api[-_]?key|private[-_]?key|credential)s?$/i;

/**
 * The trusted config with every value that looks like a credential replaced:
 * every string under a key named like one, and every string in an `env`
 * block (tool-shell's, for one, is where operators put keys), however deep
 * in arrays or objects it sits. Returns the redacted object and the paths
 * that were replaced, so restore can say what to fill back in.
 */
export const redactConfig = (config) => {
  const replaced = [];
  const walk = (value, trail, sensitive) => {
    if (typeof value === 'string' && sensitive) {
      replaced.push(trail.join('.'));
      return REDACTED;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, [...trail, index], sensitive));
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = walk(child, [...trail, key], sensitive || key === 'env' || SENSITIVE_KEY.test(key));
    }
    return out;
  };
  return { config: walk(config, [], false), replaced };
};
