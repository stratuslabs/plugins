// Loading the catalogs named in the plugin's config, once, at setup.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { compileCatalog } from './validate.js';

export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const expandHome = (path) => (path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path);

const isLoopback = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

const MAX_REDIRECTS = 5;

/** Plain http only for this machine: a catalog decides what the agent is told and what a screen may contain. */
const checkTransport = (url) => {
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`must be https (plain http only for localhost)${url.href ? `; got ${url.href}` : ''}.`);
  }
};

/** The body as text, refusing as soon as it passes the cap instead of buffering all of it first. */
const readCapped = async (response) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`is larger than ${MAX_CATALOG_BYTES} bytes.`);
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`is larger than ${MAX_CATALOG_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
};

const readUrl = async (raw, fetchImpl) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL.`);
  }
  checkTransport(url);
  // Redirects are followed here, not by fetch, so every hop meets the same
  // transport rule as the configured URL.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hops = 0; ; hops += 1) {
    const response = await fetchImpl(url, { signal, redirect: 'manual', headers: { accept: 'application/json' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => {});
      if (hops >= MAX_REDIRECTS) {
        throw new Error(`redirected more than ${MAX_REDIRECTS} times.`);
      }
      url = new URL(response.headers.get('location'), url);
      checkTransport(url);
      continue;
    }
    if (!response.ok) {
      throw new Error(`answered HTTP ${response.status}.`);
    }
    return readCapped(response);
  }
};

const readEntry = async (entry, fetchImpl) => {
  const hasPath = typeof entry?.path === 'string' && entry.path.length > 0;
  const hasUrl = typeof entry?.url === 'string' && entry.url.length > 0;
  if (hasPath === hasUrl) {
    throw new Error('@stratusagent/plugin-a2ui: each entry in "catalogs" needs exactly one of "path" or "url".');
  }
  const source = hasPath ? entry.path : entry.url;
  let text;
  try {
    text = hasPath ? await readFile(expandHome(entry.path), 'utf8') : await readUrl(entry.url, fetchImpl);
  } catch (error) {
    throw new Error(`@stratusagent/plugin-a2ui: catalog ${source} could not be loaded: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`@stratusagent/plugin-a2ui: catalog ${source} is not valid JSON: ${error.message}`);
  }
  const compiled = compileCatalog(parsed, source);
  if (entry.id !== undefined && entry.id !== compiled.catalogId) {
    throw new Error(`@stratusagent/plugin-a2ui: catalog ${source} has catalogId "${compiled.catalogId}", not the configured id "${entry.id}".`);
  }
  return compiled;
};

/** Every configured catalog, compiled and keyed by catalogId. Throws at the first that cannot be used. */
export const loadCatalogs = async (entries, { fetchImpl = globalThis.fetch } = {}) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('@stratusagent/plugin-a2ui: "catalogs" must list at least one catalog ({ path } or { url }).');
  }
  const catalogs = new Map();
  for (const entry of entries) {
    const compiled = await readEntry(entry, fetchImpl);
    if (catalogs.has(compiled.catalogId)) {
      throw new Error(`@stratusagent/plugin-a2ui: two configured catalogs have catalogId "${compiled.catalogId}".`);
    }
    catalogs.set(compiled.catalogId, compiled);
  }
  return catalogs;
};
