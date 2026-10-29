import { createHash } from 'node:crypto';

/**
 * An in-memory GitHub REST API, enough of it for the poller: the open pull
 * requests of a repository (sorted by update, with an ETag), a pull
 * request's reviews and an issue's comments, both paged. Answers through a
 * `fetch` the poller is handed, and records every request it got.
 */
export const createFakeGithub = ({ apiUrl = 'https://api.github.test', pageSize = 100 } = {}) => {
  const repos = new Map();
  const requests = [];
  let clock = Date.parse('2026-10-29T12:00:00Z');
  let nextId = 1000;
  let failNext;

  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const repoOf = (name) => {
    let repo = repos.get(name.toLowerCase());
    if (!repo) {
      repo = { name, pulls: new Map(), reviews: new Map(), comments: new Map() };
      repos.set(name.toLowerCase(), repo);
    }
    return repo;
  };
  const touch = (repo, number) => {
    repo.pulls.get(number).updated_at = iso(clock);
  };

  const fake = {
    apiUrl,
    requests,
    /** Move GitHub's clock on, in seconds. */
    tick(seconds = 60) {
      clock += seconds * 1000;
      return iso(clock);
    },
    now: () => iso(clock),
    openPull(repoName, { number, author = 'atlasatstratuslabs[bot]', title = `PR ${number}` }) {
      const repo = repoOf(repoName);
      repo.pulls.set(number, {
        url: `${apiUrl}/repos/${repoName}/pulls/${number}`,
        html_url: `https://github.com/${repoName}/pull/${number}`,
        number,
        state: 'open',
        title,
        draft: false,
        user: { login: author, id: 1, type: 'Bot' },
        head: { ref: `branch-${number}`, sha: `sha${number}` },
        base: { ref: 'main', repo: { full_name: repoName, html_url: `https://github.com/${repoName}`, private: false } },
        created_at: iso(clock),
        updated_at: iso(clock),
      });
      repo.reviews.set(number, []);
      repo.comments.set(number, []);
    },
    closePull(repoName, number) {
      repoOf(repoName).pulls.delete(number);
    },
    /** A submitted review. An `id` from reserveId() is a review started earlier (a lower id) and submitted now. */
    review(repoName, number, { user = 'chatgpt-codex-connector[bot]', body = '', state = 'COMMENTED', id } = {}) {
      const repo = repoOf(repoName);
      const reviewId = id ?? nextId++;
      const review = {
        id: reviewId,
        user: { login: user },
        body,
        state,
        html_url: `https://github.com/${repoName}/pull/${number}#pullrequestreview-${reviewId}`,
        submitted_at: iso(clock),
        commit_id: `sha${number}`,
        author_association: 'NONE',
      };
      repo.reviews.get(number).push(review);
      repo.reviews.get(number).sort((a, b) => a.id - b.id);
      touch(repo, number);
      return review;
    },
    /** An id taken now, as a review started now and left pending would take it. */
    reserveId: () => nextId++,
    comment(repoName, number, { user = 'chatgpt-codex-connector[bot]', body = '' } = {}) {
      const repo = repoOf(repoName);
      const commentId = nextId++;
      const comment = {
        id: commentId,
        user: { login: user },
        body,
        html_url: `https://github.com/${repoName}/pull/${number}#issuecomment-${commentId}`,
        created_at: iso(clock),
        updated_at: iso(clock),
        author_association: 'NONE',
      };
      repo.comments.get(number).push(comment);
      touch(repo, number);
      return comment;
    },
    editComment(repoName, number, commentId, body) {
      const repo = repoOf(repoName);
      const comment = repo.comments.get(number).find((entry) => entry.id === commentId);
      comment.body = body;
      comment.updated_at = iso(clock);
      touch(repo, number);
    },
    /** The next request gets this answer instead: `{ status, headers?, body? }`. */
    failNext(answer) {
      failNext = answer;
    },
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
      requests.push({ url: url.toString(), path: url.pathname, query: Object.fromEntries(url.searchParams), headers });
      if (init.signal?.aborted) {
        throw init.signal.reason ?? new Error('aborted');
      }
      const date = new Date(clock).toUTCString();
      if (failNext) {
        const answer = failNext;
        failNext = undefined;
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status,
          headers: { date, 'content-type': 'application/json', ...(answer.headers ?? {}) },
        });
      }
      if (url.origin !== new URL(apiUrl).origin) {
        throw new Error(`fake GitHub got a request for another origin: ${url.origin}`);
      }
      const json = (body, extra = {}) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { date, 'content-type': 'application/json', ...extra },
      });
      const paged = (items, path) => {
        const page = Number(url.searchParams.get('page') ?? '1');
        const perPage = Math.min(Number(url.searchParams.get('per_page') ?? '30'), pageSize);
        const slice = items.slice((page - 1) * perPage, page * perPage);
        const extra = {};
        if (page * perPage < items.length) {
          const next = new URL(url);
          next.searchParams.set('page', String(page + 1));
          extra.link = `<${next.toString()}>; rel="next", <${apiUrl}${path}?page=99>; rel="last"`;
        }
        return json(slice, extra);
      };
      let match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
      if (match) {
        const repo = repos.get(match[1].toLowerCase());
        if (!repo) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { date } });
        }
        const list = [...repo.pulls.values()].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.number - a.number)
          .slice(0, Number(url.searchParams.get('per_page') ?? '30'));
        const body = JSON.stringify(list);
        const etag = `W/"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
        if (headers['if-none-match'] === etag) {
          return new Response(null, { status: 304, headers: { date, etag } });
        }
        return json(list, { etag });
      }
      match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/);
      if (match) {
        const reviews = repos.get(match[1].toLowerCase())?.reviews.get(Number(match[2])) ?? [];
        return paged(reviews, url.pathname);
      }
      match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
      if (match) {
        const since = url.searchParams.get('since');
        const comments = (repos.get(match[1].toLowerCase())?.comments.get(Number(match[2])) ?? [])
          .filter((comment) => since === null || Date.parse(comment.updated_at) >= Date.parse(since));
        return paged(comments, url.pathname);
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { date } });
    },
  };
  return fake;
};
