// web.search through the Brave Search API.
//
// Only the backend lives here. The tool name, its options, the result
// envelope, the per-agent credential, the daily cap and the address policy
// all come from @stratusagent/search, which is what makes this swappable:
// another backend registers the same web.search, asks for the same
// search.apiKey, and returns the same shape, so replacing this plugin
// changes no soul and no skill.
//
// What this file owns is the Brave half of the contract: sending the query
// so Brave searches for the characters given, turning Brave's dates into
// instants, and saying plainly when Brave refused the key or the quota ran
// out.

import { requestThroughPolicy } from '@stratusagent/egress';
import {
  createWebSearchTool,
  defineSearchProvider,
  normalizePublishedAt,
  SEARCH_CREDENTIAL_NAME,
} from '@stratusagent/search';

export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/** Brave's page size. One web.search call is one Brave request, so this is also the most one call returns. */
export const BRAVE_MAX_COUNT = 20;

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;

// A per-second limit that resets this soon is worth one wait and one more
// try: two searches in the same step hit it on Brave's 1-per-second plans.
// A longer wait is the agent's decision, not something to sleep through.
const RETRY_WITHIN_SECONDS = 2;

const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason);
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Brave's freshness filter for a contract freshness: a date range from the
 * UTC day of `since` to the UTC day of "now". Brave's range is in whole
 * days, so it can only be wider than asked; the shared tool then drops
 * anything older than `since` exactly.
 */
export const braveFreshness = (freshness) => {
  const since = Date.parse(freshness.since);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return `${day(since)}to${day(since + freshness.ms)}`;
};

const buildUrl = (endpoint, query, options) => {
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  // The contract's query is literal text. Brave reads quotes, a leading
  // minus and site: as operators unless told not to, and its spellchecker
  // searches for a corrected query instead of the one given.
  url.searchParams.set('operators', 'false');
  url.searchParams.set('spellcheck', 'false');
  url.searchParams.set('result_filter', 'web');
  // Plain titles and snippets. The shared tool strips markup from snippets
  // but not from titles, and a title can legitimately contain "<T>".
  url.searchParams.set('text_decorations', 'false');
  // Brave has no site parameter, and site: in the query is an operator,
  // which the contract forbids. So site is filtered by the shared tool
  // afterwards, and so is freshness exactly; a full page gives those
  // filters the most to keep.
  const filtered = options.site !== undefined || options.freshness !== undefined;
  url.searchParams.set('count', String(filtered ? BRAVE_MAX_COUNT : Math.min(options.count, BRAVE_MAX_COUNT)));
  if (options.freshness !== undefined) {
    url.searchParams.set('freshness', braveFreshness(options.freshness));
  }
  return url.href;
};

// Brave documents page_age only as "the page's date". It sends a date-time
// with no zone; this reads that as UTC. Unconfirmed against the live API:
// the first live check has to compare a few against the pages themselves.
const ZONELESS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

// Anything else must already be an ISO instant or date; the contract's own
// check keeps those and turns the rest (a locale date, a day that doesn't
// exist) into no date rather than a guess.
const publishedAt = (pageAge) => {
  if (typeof pageAge !== 'string') return undefined;
  return normalizePublishedAt(ZONELESS.test(pageAge) ? `${pageAge}Z` : pageAge);
};

/** Brave's web results, reshaped to the contract. `body` is the response text. */
export const braveResults = (body) => {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Brave Search answered with a body that is not JSON.');
  }
  const rows = payload?.web?.results;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => typeof row?.url === 'string' && typeof row?.title === 'string')
    .map((row) => {
      const date = publishedAt(row.page_age);
      return {
        title: row.title,
        url: row.url,
        ...(typeof row.description === 'string' ? { snippet: row.description } : {}),
        ...(date !== undefined ? { publishedAt: date } : {}),
      };
    });
};

const header = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

// X-RateLimit-* headers carry one number per window: "per second, per month".
const windows = (headers, name) => {
  const value = header(headers, name);
  if (typeof value !== 'string') return [];
  return value.split(',').map((part) => Number(part.trim()));
};

const rateLimit = (headers) => {
  const [secondLeft, monthLeft] = windows(headers, 'x-ratelimit-remaining');
  const [secondReset, monthReset] = windows(headers, 'x-ratelimit-reset');
  const [, monthLimit] = windows(headers, 'x-ratelimit-limit');
  return { secondLeft, monthLeft, secondReset, monthReset, monthLimit };
};

const errorParts = (body) => {
  try {
    const error = JSON.parse(body)?.error;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const detail = typeof error?.detail === 'string' ? error.detail.slice(0, 300) : undefined;
    const component = typeof error?.meta?.component === 'string' ? error.meta.component : undefined;
    return { code, detail, component };
  } catch {
    return {};
  }
};

const inWords = (seconds) => {
  if (seconds >= 2 * 86_400) return `${Math.ceil(seconds / 86_400)} days`;
  if (seconds >= 2 * 3_600) return `${Math.ceil(seconds / 3_600)} hours`;
  if (seconds >= 120) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.max(1, Math.ceil(seconds))} seconds`;
};

const failure = (response, { retried }) => {
  const { code, detail, component } = errorParts(response.body);
  const status = `HTTP ${response.status}${code ? `, ${code}` : ''}`;
  const reason = detail ? `: ${detail}` : '.';

  // Brave answers a bad key with 422 and meta.component "authentication"
  // (seen live, Oct 27, 2026), so the status alone doesn't say it was the key.
  if (response.status === 401 || response.status === 403 || component === 'authentication') {
    return new Error(
      `Brave Search refused the key in ${SEARCH_CREDENTIAL_NAME} (${status})${reason} `
      + `Check the key in the Brave Search API dashboard, then store it again with \`stratus credential set ${SEARCH_CREDENTIAL_NAME}\`.`,
    );
  }
  if (response.status === 429) {
    const limit = rateLimit(response.headers);
    if (limit.monthLeft === 0) {
      const of = Number.isFinite(limit.monthLimit) && limit.monthLimit > 0 ? ` of ${limit.monthLimit} searches` : '';
      const resets = Number.isFinite(limit.monthReset) ? ` It resets in ${inWords(limit.monthReset)}` : ' It resets at the start of the next billing period';
      return new Error(
        `Brave Search's monthly quota${of} is used up.${resets} (${status}). `
        + 'Wait for the reset or move to a larger plan; searching again before then fails the same way.',
      );
    }
    if (retried) {
      return new Error(
        `Brave Search's per-second rate limit was hit again after one wait (${status}). `
        + 'Run fewer searches at once, or move to a plan with a higher rate.',
      );
    }
  }
  if (response.status === 400 || response.status === 422) {
    return new Error(`Brave Search refused the request (${status})${reason}`);
  }
  return new Error(`Brave Search answered ${status}${reason}`);
};

const shouldRetry = (response) => {
  if (response.status !== 429) return false;
  const limit = rateLimit(response.headers);
  return limit.monthLeft !== 0
    && limit.secondLeft === 0
    && Number.isFinite(limit.secondReset)
    && limit.secondReset >= 0
    && limit.secondReset <= RETRY_WITHIN_SECONDS;
};

/**
 * The Brave backend for the shared web.search tool.
 *
 * Options are for tests and for a host that wants different bounds:
 * `endpoint`, `timeoutMs`, `maxBytes`, `request` (defaults to
 * requestThroughPolicy) and `sleep`.
 */
export const createBraveSearchProvider = (options = {}) => {
  const endpoint = options.endpoint ?? BRAVE_ENDPOINT;
  const request = options.request ?? requestThroughPolicy;
  const sleep = options.sleep ?? sleepFor;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;

  return defineSearchProvider({
    name: 'brave',
    async search(query, searchOptions, context) {
      const key = await context.credentials.get(SEARCH_CREDENTIAL_NAME);
      if (typeof key !== 'string' || key.trim() === '') {
        throw new Error(
          `${SEARCH_CREDENTIAL_NAME} is empty. Store a Brave Search API key with \`stratus credential set ${SEARCH_CREDENTIAL_NAME}\`.`,
        );
      }
      const url = buildUrl(endpoint, query, searchOptions);
      const send = () => request(url, {
        policy: context.policy,
        headers: { accept: 'application/json', 'x-subscription-token': key.trim() },
        timeoutMs,
        maxBytes,
        ...(context.signal ? { signal: context.signal } : {}),
      });

      let response = await send();
      let retried = false;
      if (shouldRetry(response)) {
        await sleep(Math.max(1, rateLimit(response.headers).secondReset) * 1000, context.signal);
        response = await send();
        retried = true;
      }
      if (response.status !== 200) {
        throw failure(response, { retried });
      }
      if (response.truncated) {
        throw new Error(`Brave Search's answer was cut off at ${maxBytes} bytes, so it was not read.`);
      }
      return braveResults(response.body);
    },
  });
};

/**
 * The plugin. `config` is this plugin's block from a trusted config, with
 * its `agents` overrides; the shared tool resolves it per agent on every
 * call. `providerOptions` is for tests.
 */
export const createPlugin = (config = {}, providerOptions = {}) => ({
  name: 'brave-search',
  setup(context) {
    context.tools.register(createWebSearchTool({
      provider: createBraveSearchProvider(providerOptions),
      config,
      ...(context.credentials ? { credentials: context.credentials } : {}),
      // That a search ran, for whom and how many results. Never the query,
      // which is user content.
      onSearch: (record) => context.log?.(`web.search via ${record.provider} for ${record.agentId}: ${record.results} result(s)`),
    }));
  },
});
