// Two layers stand between a home and a git history that is forever:
//
// 1. Replacement. Every value the home knows to be secret (each string in
//    credentials.json, and the control API token) is replaced wherever it
//    appears, in the encodings a copy commonly takes: raw, JSON-escaped
//    (once or twice), base64, hex and URL-encoded.
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

/** Keys in credentials.json that hold a label, not a secret. */
const NON_SECRET_KEYS = new Set(['type', 'baseUrl', 'provider', 'kind', 'createdAt', 'updatedAt', 'source']);

const readIfPresent = async (file) => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const collectStrings = (value, out, key) => {
  if (typeof value === 'string') {
    if (!NON_SECRET_KEYS.has(key) && value.trim().length >= MIN_SECRET_LENGTH) out.add(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, key);
  } else if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) collectStrings(child, out, childKey);
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
    collectStrings(parsed, secrets, undefined);
  }
  const token = await readIfPresent(path.join(home, 'gateway-token'));
  if (token !== undefined && token.trim().length >= MIN_SECRET_LENGTH) secrets.add(token.trim());
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
    Buffer.from(secret).toString('hex'),
    Buffer.from(secret).toString('hex').toUpperCase(),
    encodeURIComponent(secret),
  ]);
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH);
};

const hexDigit = (digit) => (/[A-F]/.test(digit) ? `[${digit}${digit.toLowerCase()}]` : digit);

/**
 * A pattern for the secret percent-encoded the way any encoder may write it:
 * each byte either as it is or as %XX with either case of hex digits, since
 * encoders differ in which characters they escape. The secret's own letters
 * still match only as written. Run over the buffer read as latin1, byte for
 * byte.
 */
export const percentPatternOf = (secret) => {
  const parts = [...Buffer.from(secret)].map((byte) => {
    const hex = byte.toString(16).toUpperCase().padStart(2, '0');
    return `(?:\\x${hex}|%${hexDigit(hex[0])}${hexDigit(hex[1])})`;
  });
  return new RegExp(parts.join(''), 'g');
};

/** Builds the replacement list once per run, longest first so no form is left half-replaced, then the percent patterns. */
export const needlesFor = (secrets) => [
  ...[...new Set([...secrets].flatMap(encodingsOf))]
    .sort((a, b) => b.length - a.length)
    .map((form) => Buffer.from(form)),
  ...[...secrets].filter((secret) => secret.length >= MIN_SECRET_LENGTH).map(percentPatternOf),
];

const replacement = Buffer.from(REDACTED);

/** Replaces every needle in a buffer. Works on bytes, so binary files are covered too. */
export const redactBuffer = (buffer, needles) => {
  let current = buffer;
  let count = 0;
  for (const needle of needles) {
    if (needle instanceof RegExp) {
      const text = current.toString('latin1');
      let found = 0;
      const replaced = text.replace(needle, () => { found += 1; return REDACTED; });
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
 * string values under a key named like one, and every value of an `env`
 * block (tool-shell's, for one, is where operators put keys). Returns the
 * redacted object and the paths that were replaced, so restore can say what
 * to fill back in.
 */
export const redactConfig = (config) => {
  const replaced = [];
  const walk = (value, trail, inEnv) => {
    if (Array.isArray(value)) return value.map((item, index) => walk(item, [...trail, index], inEnv));
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const here = [...trail, key];
      if (typeof child === 'string' && (inEnv || SENSITIVE_KEY.test(key))) {
        out[key] = REDACTED;
        replaced.push(here.join('.'));
      } else {
        out[key] = walk(child, here, key === 'env' || inEnv);
      }
    }
    return out;
  };
  return { config: walk(config, [], false), replaced };
};
