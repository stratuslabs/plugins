/**
 * The poll itself, with no timer and no host: ask GitHub what changed on
 * each watched repository's open pull requests, and feed every review and
 * comment that is new since the last poll as one CloudEvent.
 *
 * Per repository, a poll is one conditional request for the open pull
 * requests, newest update first. GitHub answers 304 when nothing changed,
 * and a 304 to an authorized request does not count against the rate
 * limit. When the list did change, only the pull requests whose
 * `updated_at` moved get their reviews and comments read (a review or a
 * comment bumps it).
 *
 * What is new is decided by time, not by id: a review started early and
 * submitted late has a low id and a late `submitted_at`. Each pull request
 * keeps `from`, the earliest time still worth looking at, and the keys of
 * what it already fed at or after it. `from` trails the newest item seen by
 * {@link LOOKBACK_MS}, so an item GitHub lists a little late is still caught.
 *
 * A cursor moves only after the host stored the event (`ingest` resolved).
 * When `ingest` refuses, the poll stops there and the next one feeds the
 * same events again, which is safe: event ids are GitHub's own ids, and the
 * host drops an id it already took.
 */

/** How far behind the newest item seen a pull request still looks. */
export const LOOKBACK_MS = 10 * 60 * 1000;
/** Pages of reviews or comments read per pull request per poll, at 100 each. */
export const MAX_PAGES = 10;
export const REVIEW_TYPE = 'com.github.pull_request_review.submitted';
export const COMMENT_TYPE = 'com.github.issue_comment.created';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'stratus-plugin-github-poller';
const STATE_VERSION = 1;

class RateLimited extends Error {
  constructor(retryAt, message) {
    super(message);
    this.retryAt = retryAt;
  }
}

class IngestRefused extends Error {}

/** A store that keeps the state in memory only: what a host with no state directory gets. */
export const memoryStore = () => {
  let saved;
  return {
    load: () => (saved === undefined ? undefined : JSON.parse(saved)),
    save: (state) => {
      saved = JSON.stringify(state);
    },
  };
};

const emptyState = () => ({ version: STATE_VERSION, repos: {} });

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** The stored state, or undefined when it isn't one this version wrote. */
export const readState = (value) => {
  if (!isObject(value) || value.version !== STATE_VERSION || !isObject(value.repos)) {
    return undefined;
  }
  for (const repo of Object.values(value.repos)) {
    if (!isObject(repo) || !validTime(repo.checkedAt) || !isObject(repo.pulls)) {
      return undefined;
    }
    for (const pull of Object.values(repo.pulls)) {
      if (!isObject(pull) || !validTime(pull.updatedAt) || !validTime(pull.from) || !Array.isArray(pull.seen)) {
        return undefined;
      }
    }
  }
  return value;
};

/** Drop undefined members, so the event is plain JSON all the way down. */
const compact = (value) => {
  if (Array.isArray(value)) {
    return value.map(compact);
  }
  if (!isObject(value)) {
    return value;
  }
  const out = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) {
      out[key] = compact(member);
    }
  }
  return out;
};

const loginOf = (user) => (isObject(user) && typeof user.login === 'string' && user.login.length > 0 ? user.login : undefined);

const repositoryOf = (repo, pull) => {
  const base = isObject(pull.base) && isObject(pull.base.repo) ? pull.base.repo : {};
  return {
    full_name: typeof base.full_name === 'string' ? base.full_name : repo,
    html_url: typeof base.html_url === 'string' ? base.html_url : `https://github.com/${repo}`,
    private: typeof base.private === 'boolean' ? base.private : undefined,
  };
};

const pullRequestOf = (pull) => ({
  number: pull.number,
  title: pull.title,
  state: pull.state,
  draft: pull.draft,
  html_url: pull.html_url,
  url: pull.url,
  user: { login: loginOf(pull.user) },
  head: isObject(pull.head) ? { ref: pull.head.ref, sha: pull.head.sha } : undefined,
  base: isObject(pull.base) ? { ref: pull.base.ref } : undefined,
  updated_at: pull.updated_at,
});

/**
 * A review as the webhook mapping would have it: the same type, subject,
 * `actor` (who reviewed) and `author` (whose pull request), and data in the
 * webhook payload's shape, cut down to what a trigger or an agent uses.
 */
const reviewEvent = (repo, pull, review) => {
  const repository = repositoryOf(repo, pull);
  const actor = loginOf(review.user);
  const author = loginOf(pull.user);
  return compact({
    specversion: '1.0',
    id: `github-review-${review.id}`,
    source: `https://github.com/${repository.full_name}`,
    type: REVIEW_TYPE,
    subject: `pull/${pull.number}`,
    time: review.submitted_at,
    actor,
    author,
    datacontenttype: 'application/json',
    data: {
      action: 'submitted',
      review: {
        id: review.id,
        user: { login: actor },
        body: typeof review.body === 'string' ? review.body : '',
        state: typeof review.state === 'string' ? review.state.toLowerCase() : undefined,
        html_url: review.html_url,
        submitted_at: review.submitted_at,
        commit_id: review.commit_id,
        author_association: review.author_association,
      },
      pull_request: pullRequestOf(pull),
      repository,
      sender: { login: actor },
    },
  });
};

/** A comment on a pull request: GitHub's `issue_comment`, whose payload names the pull request as an issue. */
const commentEvent = (repo, pull, comment) => {
  const repository = repositoryOf(repo, pull);
  const actor = loginOf(comment.user);
  const author = loginOf(pull.user);
  return compact({
    specversion: '1.0',
    id: `github-issue-comment-${comment.id}`,
    source: `https://github.com/${repository.full_name}`,
    type: COMMENT_TYPE,
    subject: `pull/${pull.number}`,
    time: comment.created_at,
    actor,
    author,
    datacontenttype: 'application/json',
    data: {
      action: 'created',
      comment: {
        id: comment.id,
        user: { login: actor },
        body: typeof comment.body === 'string' ? comment.body : '',
        html_url: comment.html_url,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        author_association: comment.author_association,
      },
      issue: {
        number: pull.number,
        title: pull.title,
        state: pull.state,
        html_url: pull.html_url,
        user: { login: author },
        pull_request: { url: pull.url, html_url: pull.html_url },
      },
      repository,
      sender: { login: actor },
    },
  });
};

const nextLink = (header) => {
  if (typeof header !== 'string') {
    return undefined;
  }
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
};

const serverTime = (response, now) => {
  const date = Date.parse(response.headers.get('date') ?? '');
  return new Date(Number.isFinite(date) ? date : now().getTime()).toISOString();
};

const describe = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {object} options
 * @param {string[]} options.repos `owner/name` of each repository to watch.
 * @param {string} [options.apiUrl] GitHub's REST API, or a GitHub Enterprise one's.
 * @param {() => Promise<string | undefined>} options.token The token, asked before each poll.
 * @param {(event: object) => Promise<{ status: string }>} options.ingest Where each event goes.
 * @param {{ load(): object | undefined, save(state: object): void }} options.store Where the cursors live.
 */
export const createPoller = ({
  repos,
  apiUrl = 'https://api.github.com',
  fetch: fetchImpl = globalThis.fetch,
  token,
  ingest,
  store,
  log = () => {},
  warn = () => {},
  now = () => new Date(),
  requestTimeoutMs = 30_000,
}) => {
  const base = apiUrl.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const loaded = store.load();
  let state = loaded === undefined ? emptyState() : readState(loaded);
  if (state === undefined) {
    warn('github-poller: the stored poll state is not one this version wrote, so every repository starts from a new baseline.');
    state = emptyState();
  }
  let pausedUntil = 0;
  const warned = new Map();

  // One warning per problem, not one per poll; a line in the log when it clears.
  const problem = (key, message) => {
    if (warned.get(key) !== message) {
      warned.set(key, message);
      warn(message);
    }
  };
  const recovered = (key, message) => {
    if (warned.delete(key)) {
      log(message);
    }
  };

  const save = () => {
    try {
      store.save(state);
    } catch (error) {
      problem('store', `github-poller: could not store the poll state (${describe(error)}). Events since the last stored poll may be fed again after a restart; the host drops the ones it already took.`);
      return;
    }
    recovered('store', 'github-poller: storing the poll state works again.');
  };

  const request = async (url, { tokenValue, etag, signal }) => {
    if (new URL(url).origin !== origin) {
      throw new Error(`GitHub pointed the next page at another host (${new URL(url).host}), which the token is not sent to.`);
    }
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT,
      authorization: `Bearer ${tokenValue}`,
    };
    if (etag !== undefined) {
      headers['if-none-match'] = etag;
    }
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new Error(`could not reach ${new URL(url).host}: ${describe(error)}`);
    }
    if (response.status === 304 || response.ok) {
      return response;
    }
    let message = '';
    try {
      const body = await response.json();
      message = isObject(body) && typeof body.message === 'string' ? body.message.slice(0, 200) : '';
    } catch {
      // No JSON body: the status says enough.
    }
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const retryAfter = Number(response.headers.get('retry-after'));
    if ((response.status === 403 || response.status === 429) && (remaining === '0' || Number.isFinite(retryAfter) && retryAfter > 0)) {
      const retryAt = remaining === '0' && Number.isFinite(reset) && reset > 0
        ? reset * 1000
        : now().getTime() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
      throw new RateLimited(retryAt, `GitHub's rate limit is reached (${response.status}${message ? `: ${message}` : ''}); polling waits until ${new Date(retryAt).toISOString()}.`);
    }
    if (response.status === 401) {
      throw new Error(`GitHub refused the token (401${message ? `: ${message}` : ''}). Store a current one.`);
    }
    if (response.status === 404) {
      throw new Error('not found (404): the repository does not exist, or the token cannot read it.');
    }
    throw new Error(`GitHub answered ${response.status}${message ? `: ${message}` : ''}.`);
  };

  const readAll = async (path, context) => {
    const items = [];
    let url = `${base}${path}`;
    for (let page = 0; url !== undefined; page += 1) {
      if (page === MAX_PAGES) {
        throw new Error(`${path} has more than ${MAX_PAGES} pages; the rest were not read.`);
      }
      const response = await request(url, context);
      const body = await response.json();
      if (!Array.isArray(body)) {
        throw new Error(`${path} did not answer with a list.`);
      }
      items.push(...body);
      url = nextLink(response.headers.get('link'));
    }
    return items;
  };

  const feed = async (event) => {
    try {
      await ingest(event);
    } catch (error) {
      throw new IngestRefused(`the daemon did not take ${event.id}: ${describe(error)} It is fed again at the next poll.`);
    }
  };

  /** Feed what is new on one pull request, and return its next cursor. */
  const pollPull = async (repo, pull, cursor, context) => {
    const fromMs = Date.parse(cursor.from);
    const since = new Date(fromMs).toISOString();
    const reviews = await readAll(`/repos/${repo}/pulls/${pull.number}/reviews?per_page=100`, context);
    const comments = await readAll(`/repos/${repo}/issues/${pull.number}/comments?per_page=100&since=${encodeURIComponent(since)}`, context);
    const items = [
      // A pending review has no submitted_at, and nobody but its author sees it listed.
      ...reviews.filter((review) => isObject(review) && Number.isSafeInteger(review.id) && validTime(review.submitted_at))
        .map((review) => ({ key: `r${review.id}`, at: Date.parse(review.submitted_at), id: review.id, event: () => reviewEvent(repo, pull, review) })),
      ...comments.filter((comment) => isObject(comment) && Number.isSafeInteger(comment.id) && validTime(comment.created_at))
        .map((comment) => ({ key: `c${comment.id}`, at: Date.parse(comment.created_at), id: comment.id, event: () => commentEvent(repo, pull, comment) })),
    ];
    const seen = new Set(cursor.seen);
    const fresh = items.filter((item) => item.at >= fromMs && !seen.has(item.key))
      .sort((a, b) => a.at - b.at || a.id - b.id);
    for (const item of fresh) {
      await feed(item.event());
      seen.add(item.key);
    }
    const newest = Math.max(fromMs, ...items.map((item) => item.at));
    const nextFrom = Math.max(fromMs, newest - LOOKBACK_MS);
    return {
      next: {
        updatedAt: pull.updated_at,
        from: new Date(nextFrom).toISOString(),
        seen: items.filter((item) => item.at >= nextFrom && seen.has(item.key)).map((item) => item.key),
      },
      fed: fresh.length,
    };
  };

  const pollRepo = async (repo, context) => {
    const known = state.repos[repo];
    const response = await request(`${base}/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`, {
      ...context,
      etag: known?.etag,
    });
    const respondedAt = serverTime(response, now);
    if (response.status === 304 && known !== undefined) {
      known.checkedAt = respondedAt;
      return { status: 'unchanged', events: 0 };
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new Error('the pull request list was not a list.');
    }
    const pulls = body.filter((pull) => isObject(pull) && Number.isSafeInteger(pull.number) && validTime(pull.updated_at));
    const etag = response.headers.get('etag') ?? undefined;
    if (known === undefined) {
      // The first poll of a repository feeds nothing: what is already there
      // is history, and waking agents on it would replay every review.
      state.repos[repo] = {
        ...(etag !== undefined ? { etag } : {}),
        checkedAt: respondedAt,
        pulls: Object.fromEntries(pulls.map((pull) => [String(pull.number), { updatedAt: pull.updated_at, from: respondedAt, seen: [] }])),
      };
      save();
      log(`github-poller: ${repo}: baseline set with ${pulls.length} open pull request${pulls.length === 1 ? '' : 's'}; events start from now.`);
      return { status: 'baseline', events: 0 };
    }
    let events = 0;
    // Oldest change first, so a refusal part-way leaves the older ones done.
    for (const pull of [...pulls].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))) {
      const cursor = known.pulls[String(pull.number)];
      if (cursor !== undefined && Date.parse(pull.updated_at) <= Date.parse(cursor.updatedAt)) {
        continue;
      }
      // A pull request first seen now opened (or came back into the list)
      // since the last poll, so everything on it after that poll is new.
      const start = cursor ?? { updatedAt: pull.updated_at, from: new Date(Date.parse(known.checkedAt) - LOOKBACK_MS).toISOString(), seen: [] };
      const { next, fed } = await pollPull(repo, pull, start, context);
      known.pulls[String(pull.number)] = next;
      events += fed;
      save();
    }
    const open = new Set(pulls.map((pull) => String(pull.number)));
    for (const number of Object.keys(known.pulls)) {
      if (!open.has(number)) {
        delete known.pulls[number];
      }
    }
    if (etag !== undefined) {
      known.etag = etag;
    } else {
      delete known.etag;
    }
    known.checkedAt = respondedAt;
    save();
    return { status: 'checked', events };
  };

  return {
    /** When polling may start again after GitHub's rate limit, in epoch ms (0 when it isn't paused). */
    pausedUntil: () => pausedUntil,
    /** One pass over every repository. Never throws; each repository's outcome is in the summary. */
    async poll({ signal } = {}) {
      if (now().getTime() < pausedUntil) {
        return { skipped: 'rate-limited', until: new Date(pausedUntil).toISOString() };
      }
      let tokenValue;
      try {
        tokenValue = await token();
      } catch (error) {
        problem('token', `github-poller: could not read the GitHub token: ${describe(error)}`);
        return { skipped: 'no-token' };
      }
      if (typeof tokenValue !== 'string' || tokenValue.length === 0) {
        problem('token', 'github-poller: no GitHub token is stored, so nothing is polled. See the plugin README for the one to store.');
        return { skipped: 'no-token' };
      }
      recovered('token', 'github-poller: a GitHub token is there now; polling starts.');
      const summary = { repos: {} };
      for (const repo of repos) {
        if (signal?.aborted) {
          break;
        }
        try {
          summary.repos[repo] = await pollRepo(repo, { tokenValue, signal });
          recovered(`repo:${repo}`, `github-poller: ${repo} polls again.`);
        } catch (error) {
          if (signal?.aborted) {
            break;
          }
          if (error instanceof RateLimited) {
            pausedUntil = error.retryAt;
            problem('rate', `github-poller: ${error.message}`);
            summary.repos[repo] = { status: 'rate-limited' };
            break;
          }
          problem(`repo:${repo}`, `github-poller: ${repo}: ${describe(error)}`);
          summary.repos[repo] = { status: 'error', error: describe(error) };
          if (error instanceof IngestRefused) {
            // The daemon isn't taking events; the other repositories would be refused too.
            break;
          }
        }
      }
      if (pausedUntil !== 0 && now().getTime() >= pausedUntil) {
        pausedUntil = 0;
      }
      if (!Object.values(summary.repos).some((entry) => entry.status === 'rate-limited')) {
        recovered('rate', 'github-poller: GitHub\'s rate limit has reset; polling resumed.');
      }
      return summary;
    },
  };
};
