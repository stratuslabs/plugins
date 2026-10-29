import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMENT_TYPE, REVIEW_TYPE, createPoller, memoryStore } from '../lib/poller.js';
import { createFakeGithub } from './fake-github.js';

const REPO = 'stratuslabs/agent';
const RECEIPT = '<!-- codex-review-receipt:v1 -->';

const setup = ({ repos = [REPO], token = 'ghs_test', store = memoryStore(), github = createFakeGithub(), ingest } = {}) => {
  const ingested = [];
  const warnings = [];
  const logs = [];
  const poller = createPoller({
    repos,
    apiUrl: github.apiUrl,
    fetch: github.fetch,
    token: async () => token,
    ingest: ingest ?? (async (event) => {
      ingested.push(event);
      return { status: 'matched' };
    }),
    store,
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    now: () => new Date(github.now()),
  });
  return { poller, github, ingested, warnings, logs, store };
};

test('the first poll only sets a baseline, and an unchanged list costs one conditional request', async () => {
  const { poller, github, ingested } = setup();
  github.openPull(REPO, { number: 7 });
  github.review(REPO, 7, { body: `${RECEIPT}\nold review` });
  github.tick();

  const first = await poller.poll();
  assert.equal(first.repos[REPO].status, 'baseline');
  assert.equal(ingested.length, 0);

  github.tick(120);
  const requestsBefore = github.requests.length;
  const second = await poller.poll();
  assert.equal(second.repos[REPO].status, 'unchanged');
  assert.equal(ingested.length, 0);
  const sent = github.requests.slice(requestsBefore);
  assert.equal(sent.length, 1, 'one request for an unchanged repository');
  assert.match(sent[0].headers['if-none-match'], /^W\/"/);
  assert.equal(sent[0].headers.authorization, 'Bearer ghs_test');
  assert.equal(sent[0].query.sort, 'updated');
  assert.equal(sent[0].query.state, 'open');
});

test('a review after the baseline becomes one event in the webhook mapping\'s shape', async () => {
  const { poller, github, ingested } = setup();
  github.openPull(REPO, { number: 490, author: 'atlasatstratuslabs[bot]', title: 'Plugins feed events' });
  await poller.poll();

  github.tick(60);
  const review = github.review(REPO, 490, { body: `${RECEIPT}\nLooks good.` });
  github.tick(60);
  const summary = await poller.poll();

  assert.equal(summary.repos[REPO].status, 'checked');
  assert.equal(summary.repos[REPO].events, 1);
  assert.equal(ingested.length, 1);
  const [event] = ingested;
  assert.equal(event.specversion, '1.0');
  assert.equal(event.id, `github-review-${review.id}`);
  assert.equal(event.source, `https://github.com/${REPO}`);
  assert.equal(event.type, REVIEW_TYPE);
  assert.equal(event.type, 'com.github.pull_request_review.submitted');
  assert.equal(event.subject, 'pull/490');
  assert.equal(event.time, review.submitted_at);
  assert.equal(event.actor, 'chatgpt-codex-connector[bot]');
  assert.equal(event.author, 'atlasatstratuslabs[bot]');
  assert.equal(event.data.action, 'submitted');
  assert.equal(event.data.review.id, review.id);
  assert.ok(event.data.review.body.startsWith(RECEIPT));
  assert.equal(event.data.pull_request.number, 490);
  assert.equal(event.data.pull_request.user.login, 'atlasatstratuslabs[bot]');
  assert.equal(event.data.repository.full_name, REPO);
  assert.equal(event.data.sender.login, 'chatgpt-codex-connector[bot]');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(event)));
  assert.ok(!JSON.stringify(event).includes('undefined'));
});

test('a comment on a pull request becomes an issue_comment event on the pull request\'s subject', async () => {
  const { poller, github, ingested } = setup();
  github.openPull(REPO, { number: 12, author: 'blair' });
  await poller.poll();

  github.tick(30);
  const comment = github.comment(REPO, 12, { body: `${RECEIPT}\nDidn't find any major issues.` });
  github.tick(30);
  await poller.poll();

  assert.equal(ingested.length, 1);
  const [event] = ingested;
  assert.equal(event.id, `github-issue-comment-${comment.id}`);
  assert.equal(event.type, COMMENT_TYPE);
  assert.equal(event.type, 'com.github.issue_comment.created');
  assert.equal(event.subject, 'pull/12');
  assert.equal(event.time, comment.created_at);
  assert.equal(event.actor, 'chatgpt-codex-connector[bot]');
  assert.equal(event.author, 'blair');
  assert.equal(event.data.action, 'created');
  assert.equal(event.data.comment.body, comment.body);
  assert.equal(event.data.issue.number, 12);
  assert.equal(event.data.issue.user.login, 'blair');
  assert.ok(event.data.issue.pull_request, 'issue.pull_request marks it as a pull request, as in a webhook');
});

test('reviews and comments on one pull request go out oldest first, each once', async () => {
  const { poller, github, ingested } = setup();
  github.openPull(REPO, { number: 3 });
  await poller.poll();

  github.tick(10);
  const first = github.comment(REPO, 3, { body: 'summary' });
  github.tick(10);
  const second = github.review(REPO, 3, { body: `${RECEIPT}\nP2` });
  github.tick(10);
  await poller.poll();
  github.tick(120);
  await poller.poll();

  assert.deepEqual(ingested.map((event) => event.id), [`github-issue-comment-${first.id}`, `github-review-${second.id}`]);
});

test('a pull request opened after the baseline has its first review picked up', async () => {
  const { poller, github, ingested } = setup();
  github.openPull(REPO, { number: 1 });
  await poller.poll();

  github.tick(30);
  github.openPull(REPO, { number: 2 });
  github.tick(30);
  const review = github.review(REPO, 2, { body: `${RECEIPT}\nfound one` });
  github.tick(30);
  await poller.poll();

  assert.deepEqual(ingested.map((event) => event.id), [`github-review-${review.id}`]);
});

test('a review started before the last poll and submitted after it is still picked up', async () => {
  const { poller, github, ingested } = setup();
  github.openPull(REPO, { number: 5 });
  await poller.poll();

  github.tick(30);
  const startedEarlier = github.reserveId();
  const later = github.review(REPO, 5, { body: 'a quick one' });
  github.tick(30);
  await poller.poll();
  github.tick(30);
  const pending = github.review(REPO, 5, { id: startedEarlier, body: 'the long one, submitted last' });
  github.tick(30);
  await poller.poll();

  assert.deepEqual(ingested.map((event) => event.id), [`github-review-${later.id}`, `github-review-${pending.id}`]);
});

test('editing an old comment wakes nothing', async () => {
  const { poller, github, ingested } = setup();
  github.openPull(REPO, { number: 8 });
  const old = github.comment(REPO, 8, { body: 'before the baseline' });
  github.tick(3600);
  await poller.poll();

  github.tick(60);
  github.editComment(REPO, 8, old.id, 'edited now');
  github.tick(60);
  const summary = await poller.poll();

  assert.equal(summary.repos[REPO].status, 'checked');
  assert.equal(ingested.length, 0);
});

test('a refused ingest leaves the cursor where it was, and the next poll feeds the event again', async () => {
  let refuse = true;
  const ingested = [];
  const { poller, github, warnings } = setup({
    ingest: async (event) => {
      if (refuse) {
        throw new Error('Event source github is over its rate.');
      }
      ingested.push(event);
      return { status: 'unmatched' };
    },
  });
  github.openPull(REPO, { number: 9 });
  await poller.poll();
  github.tick(30);
  const review = github.review(REPO, 9, { body: 'x' });
  github.tick(30);

  const refused = await poller.poll();
  assert.equal(refused.repos[REPO].status, 'error');
  assert.match(warnings.join('\n'), /over its rate/);
  assert.equal(ingested.length, 0);

  refuse = false;
  github.tick(120);
  const retried = await poller.poll();
  assert.equal(retried.repos[REPO].status, 'checked');
  assert.deepEqual(ingested.map((event) => event.id), [`github-review-${review.id}`]);
});

test('a restarted poller resumes from its stored cursor and feeds what came in while it was down', async () => {
  const github = createFakeGithub();
  const store = memoryStore();
  github.openPull(REPO, { number: 4 });
  await setup({ github, store }).poller.poll();

  github.tick(600);
  const whileDown = github.review(REPO, 4, { body: `${RECEIPT}\nwhile down` });
  github.tick(600);
  const restarted = setup({ github, store });
  const summary = await restarted.poller.poll();

  assert.equal(summary.repos[REPO].status, 'checked');
  assert.deepEqual(restarted.ingested.map((event) => event.id), [`github-review-${whileDown.id}`]);
});

test('a closed pull request leaves the stored state', async () => {
  const { poller, github, store } = setup();
  github.openPull(REPO, { number: 20 });
  github.openPull(REPO, { number: 21 });
  await poller.poll();
  assert.deepEqual(Object.keys(store.load().repos[REPO].pulls).sort(), ['20', '21']);

  github.tick(60);
  github.closePull(REPO, 20);
  github.tick(60);
  await poller.poll();
  assert.deepEqual(Object.keys(store.load().repos[REPO].pulls), ['21']);
});

test('reviews past the first page are read', async () => {
  const github = createFakeGithub({ pageSize: 2 });
  const { poller, ingested } = setup({ github });
  github.openPull(REPO, { number: 6 });
  await poller.poll();
  github.tick(10);
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push(github.review(REPO, 6, { body: `review ${index}` }).id);
  }
  github.tick(10);
  await poller.poll();

  assert.deepEqual(ingested.map((event) => event.id), ids.map((id) => `github-review-${id}`));
});

test('a next-page link to another host is refused, and the token never goes there', async () => {
  const github = createFakeGithub();
  const requests = [];
  const fetch = async (input, init) => {
    requests.push(String(input));
    if (String(input).includes('/reviews')) {
      return new Response('[]', {
        status: 200,
        headers: { link: '<https://evil.example/next?page=2>; rel="next"', date: new Date(github.now()).toUTCString() },
      });
    }
    return github.fetch(input, init);
  };
  const { poller, warnings, ingested } = setup({ github: { ...github, fetch } });
  github.openPull(REPO, { number: 30 });
  await poller.poll();
  github.tick(10);
  github.review(REPO, 30, { body: 'x' });
  github.tick(10);

  const summary = await poller.poll();
  assert.equal(summary.repos[REPO].status, 'error');
  assert.equal(ingested.length, 0);
  assert.ok(requests.every((url) => !url.startsWith('https://evil.example')));
  assert.match(warnings.join('\n'), /another host/);
  assert.ok(warnings.every((line) => !line.includes('ghs_test')));
});

test('no token: no request, one warning, and polling starts once a token is there', async () => {
  let token;
  const github = createFakeGithub();
  github.openPull(REPO, { number: 1 });
  const warnings = [];
  const logs = [];
  const poller = createPoller({
    repos: [REPO],
    apiUrl: github.apiUrl,
    fetch: github.fetch,
    token: async () => token,
    ingest: async () => ({ status: 'matched' }),
    store: memoryStore(),
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
  });

  assert.equal((await poller.poll()).skipped, 'no-token');
  assert.equal((await poller.poll()).skipped, 'no-token');
  assert.equal(github.requests.length, 0);
  assert.equal(warnings.length, 1);

  token = 'ghs_later';
  assert.equal((await poller.poll()).repos[REPO].status, 'baseline');
  assert.equal(github.requests[0].headers.authorization, 'Bearer ghs_later');
});

test('a rejected token is one warning, not one a poll, and the message never carries it', async () => {
  const { poller, github, warnings, logs } = setup();
  github.openPull(REPO, { number: 1 });
  github.failNext({ status: 401, body: { message: 'Bad credentials' } });
  assert.equal((await poller.poll()).repos[REPO].status, 'error');
  github.failNext({ status: 401, body: { message: 'Bad credentials' } });
  await poller.poll();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /401/);
  assert.ok(!warnings[0].includes('ghs_test'));

  assert.equal((await poller.poll()).repos[REPO].status, 'baseline');
  assert.ok(logs.some((line) => /polls again/.test(line)));
});

test('GitHub\'s rate limit pauses polling until its reset time', async () => {
  const { poller, github, warnings } = setup();
  github.openPull(REPO, { number: 1 });
  const reset = Math.floor(Date.parse(github.now()) / 1000) + 600;
  github.failNext({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: { message: 'API rate limit exceeded' } });

  assert.equal((await poller.poll()).repos[REPO].status, 'rate-limited');
  assert.equal(poller.pausedUntil(), reset * 1000);
  assert.match(warnings.join('\n'), /rate limit/i);

  github.tick(60);
  const before = github.requests.length;
  assert.equal((await poller.poll()).skipped, 'rate-limited');
  assert.equal(github.requests.length, before);

  github.tick(600);
  assert.equal((await poller.poll()).repos[REPO].status, 'baseline');
});

test('a repository the token cannot see is named, and the others still poll', async () => {
  const github = createFakeGithub();
  github.openPull(REPO, { number: 1 });
  const { poller, warnings } = setup({ github, repos: ['stratuslabs/missing', REPO] });
  const summary = await poller.poll();
  assert.equal(summary.repos['stratuslabs/missing'].status, 'error');
  assert.match(warnings.join('\n'), /stratuslabs\/missing.*404/);
  assert.equal(summary.repos[REPO].status, 'baseline');
});
