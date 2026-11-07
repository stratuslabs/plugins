import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCard, CardError, CARD_LIMITS, MAX_ACTIONS, MAX_BLOCKS, MAX_TABLE_CHARS } from '../lib/card.js';
import { componentNames } from '../lib/catalog.js';

/** A spec from `elements` (key -> [type, props, children?]) rooted at `root`. */
const spec = (elements, root = 'card', extra = {}) => ({
  root,
  elements: Object.fromEntries(Object.entries(elements).map(([key, [type, props = {}, children = []]]) => [key, { type, props, children }])),
  ...extra,
});

const card = (children, props = { title: 'Open PRs' }) => ['Card', props, children];

/** The issues a failing build reports, one per line after the first. */
const issues = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CardError, `expected a CardError, got ${error}`);
    assert.match(error.message, /call chat\.card again/);
    return error.issues;
  }
  assert.fail('expected the spec to be refused');
};

// What channel-slack lets a post carry (packages/channel-slack/src/posts.ts,
// AGT-324). A card this plugin builds must stay inside it, or the thread gets
// the card's text alone.
const SLACK_BLOCK_TYPES = new Set(['header', 'section', 'context', 'divider', 'image', 'table', 'data_table', 'data_visualization', 'actions']);
const SLACK_INNER_TYPES = new Set(['plain_text', 'mrkdwn', 'raw_text', 'image', 'button', 'pie', 'bar', 'line', 'area']);
const WEB_URL = /^https?:\/\/\S+$/i;

/** Every reason channel-slack would refuse these blocks, mirroring sanitizePostBlocks. */
const slackRefusals = (blocks) => {
  const found = [];
  const walk = (value, allowed) => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, SLACK_INNER_TYPES));
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    if (value.type !== undefined && !allowed.has(value.type)) found.push(`type ${value.type}`);
    if ('slack_file' in value) found.push('slack_file');
    if (value.type === 'image' && !WEB_URL.test(value.image_url ?? '')) found.push('image without web URL');
    if (value.type === 'button' && !WEB_URL.test(value.url ?? '')) found.push('button without a link');
    if (value.type !== 'button' && 'action_id' in value) found.push('action_id outside a button');
    for (const item of Object.values(value)) walk(item, SLACK_INNER_TYPES);
  };
  if (blocks.length === 0 || blocks.length > 50) found.push(`${blocks.length} blocks`);
  blocks.forEach((block) => walk(block, SLACK_BLOCK_TYPES));
  return found;
};

const EVERYTHING = spec({
  card: card(['fields', 'table', 'pie', 'bars', 'section', 'divider', 'image', 'actions'], { title: 'Stratus repos', subtitle: 'Last 7 days', imageUrl: 'https://example.com/banner.png' }),
  fields: ['Fields', {}, ['f1', 'f2']],
  f1: ['Field', { label: 'Open', value: 13 }],
  f2: ['Field', { label: 'Merged', value: 109 }],
  table: ['Table', { headers: ['Repo', 'Open'], rows: [['agent', 4], ['plugins', 6]], align: ['left', 'right'], caption: 'By repo' }],
  pie: ['Chart', { title: 'Merged by repo', chart: { type: 'pie', segments: [{ label: 'agent', value: 101 }, { label: 'plugins', value: 8 }] } }],
  bars: ['Chart', { title: 'Opened per day', chart: { type: 'bar', categories: ['Mon', 'Tue'], series: [{ name: 'agent', values: [3, 5] }] } }],
  section: ['Section', {}, ['plain', 'bold', 'muted']],
  plain: ['Text', { content: 'Most of it is **core** work.' }],
  bold: ['Text', { content: 'Release Monday', style: 'bold' }],
  muted: ['Text', { content: 'From GitHub at 01:10Z', style: 'muted' }],
  divider: ['Divider'],
  image: ['Image', { url: 'https://example.com/chart.png', alt: 'A chart' }],
  actions: ['Actions', {}, ['open']],
  open: ['LinkButton', { label: 'Open PRs', url: 'https://github.com/stratuslabs/agent/pulls' }],
});

test('a card with every component becomes a post: text plus Slack blocks the channel will send', () => {
  const post = buildCard(EVERYTHING);
  assert.deepEqual(Object.keys(post), ['text', 'slack']);
  assert.deepEqual(Object.keys(post.slack), ['blocks']);
  assert.ok(post.text.includes('Stratus repos'), post.text);
  assert.ok(post.text.trim().length > 0);
  const types = post.slack.blocks.map((block) => block.type);
  assert.deepEqual(types, ['header', 'context', 'image', 'section', 'data_table', 'data_visualization', 'data_visualization', 'section', 'section', 'context', 'divider', 'image', 'actions']);
  assert.deepEqual(slackRefusals(post.slack.blocks), []);
});

test('the post is plain JSON, so it survives being stored in the session and replayed', () => {
  const post = buildCard(EVERYTHING);
  assert.deepEqual(JSON.parse(JSON.stringify(post)), post);
});

test('state, repeat and templates are resolved when the card is built', () => {
  const repeated = spec({
    card: card(['fields']),
    fields: ['Fields', {}, ['item']],
    item: ['Field', { label: { $item: 'repo' }, value: { $template: '${open} open' } }],
  }, 'card', { state: { repos: [{ repo: 'agent', open: 4 }, { repo: 'infra', open: 3 }] } });
  repeated.elements.fields.repeat = { statePath: '/repos' };
  const fields = buildCard(repeated).slack.blocks.find((block) => block.type === 'section' && block.fields);
  assert.deepEqual(fields.fields.map((field) => field.text), ['*agent*\n4 open', '*infra*\n3 open']);
});

test('the catalog offers link buttons only: a plain Button is refused by name', () => {
  assert.ok(!componentNames.includes('Button'));
  assert.ok(componentNames.includes('LinkButton'));
  const found = issues(() => buildCard(spec({
    card: card(['actions']),
    actions: ['Actions', {}, ['ack']],
    ack: ['Button', { id: 'ack', label: 'Acknowledge' }],
  })));
  assert.ok(found.some((issue) => issue.includes('Button')), found.join('\n'));
});

test('every problem in a bad spec comes back, one issue each', () => {
  const found = issues(() => buildCard(spec({
    card: card(['fields', 'table']),
    fields: ['Fields', {}, ['f1']],
    f1: ['Field', { value: 3 }],
    table: ['Table', { headers: 'Repo', rows: [] }],
  })));
  assert.ok(found.length >= 2, found.join('\n'));
  assert.ok(found.some((issue) => issue.includes('f1')), found.join('\n'));
  assert.ok(found.some((issue) => issue.includes('table')), found.join('\n'));
});

test('a root that is not a Card, or names no element, is refused', () => {
  assert.ok(issues(() => buildCard(spec({ text: ['Text', { content: 'hi' }] }, 'text'))).length > 0);
  assert.ok(issues(() => buildCard(spec({ card: card([]) }, 'nope'))).length > 0);
});

test('input that is not a spec at all is refused as one issue, not a crash', () => {
  for (const input of [undefined, null, 'card', [], { root: 'card' }, { root: 3, elements: {} }, { root: 'card', elements: [] }]) {
    const found = issues(() => buildCard(input));
    assert.equal(found.length, 1, `${JSON.stringify(input)}: ${found.join('\n')}`);
  }
});

test('an empty card is refused: it would post nothing at all', () => {
  const found = issues(() => buildCard(spec({ card: ['Card', {}, []] })));
  assert.match(found.join('\n'), /title|empty/);
  // A Section with nothing in it counts for nothing either.
  assert.match(issues(() => buildCard(spec({ card: ['Card', {}, ['s']], s: ['Section', {}, []] }))).join('\n'), /title|empty/);
});

test('limits are refused rather than sent as a code block: 3 charts, 2 tables', () => {
  const chart = (title) => ['Chart', { title, chart: { type: 'pie', segments: [{ label: 'a', value: 1 }] } }];
  const charts = issues(() => buildCard(spec({ card: card(['c1', 'c2', 'c3']), c1: chart('One'), c2: chart('Two'), c3: chart('Three') })));
  assert.match(charts.join('\n'), /at most 2 Chart/);
  const table = ['Table', { headers: ['A'], rows: [['1']] }];
  const tables = issues(() => buildCard(spec({ card: card(['t1', 't2']), t1: table, t2: table })));
  assert.match(tables.join('\n'), /at most 1 Table/);
  assert.equal(CARD_LIMITS.charts, 2);
  assert.equal(CARD_LIMITS.tables, 1);
});

test('a table of 99 rows and a header is native; one more row is refused', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => [`r${i}`]);
  const ok = buildCard(spec({ card: card(['t']), t: ['Table', { headers: ['Row'], rows: rows(99) }] }));
  assert.equal(ok.slack.blocks.find((block) => block.type === 'data_table').rows.length, 100);
  assert.match(issues(() => buildCard(spec({ card: card(['t']), t: ['Table', { headers: ['Row'], rows: rows(100) }] }))).join('\n'), /rows/);
});

test('a table with more text than Slack shows is refused, not turned into a code block', () => {
  const cell = 'x'.repeat(100);
  const ok = buildCard(spec({ card: card(['t']), t: ['Table', { headers: ['A'], rows: Array.from({ length: 99 }, () => [cell]) }] }));
  assert.ok(ok.slack.blocks.some((block) => block.type === 'data_table'));
  const found = issues(() => buildCard(spec({ card: card(['t']), t: ['Table', { headers: ['A', 'B'], rows: Array.from({ length: 51 }, () => [cell, cell]) }] })));
  assert.match(found.join('\n'), new RegExp(`at most ${MAX_TABLE_CHARS}`));
});

test('more link buttons than one row holds is refused, not cut short', () => {
  const keys = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => `b${i}`);
  const elements = { card: card(['s']), s: ['Section', {}, ['a']], a: ['Actions', {}, keys] };
  for (const key of keys) elements[key] = ['LinkButton', { label: key, url: `https://example.com/${key}` }];
  assert.match(issues(() => buildCard(spec(elements))).join('\n'), new RegExp(`at most ${MAX_ACTIONS}`));
  elements.a[2] = keys.slice(0, MAX_ACTIONS);
  assert.equal(buildCard(spec(elements)).slack.blocks.find((block) => block.type === 'actions').elements.length, MAX_ACTIONS);
});

test('more blocks than Slack takes in one message is refused with the count', () => {
  const keys = Array.from({ length: MAX_BLOCKS }, (_, i) => `d${i}`);
  const elements = { card: card(keys) };
  for (const key of keys) elements[key] = ['Divider'];
  // the header plus 50 dividers is 51 blocks
  const found = issues(() => buildCard(spec(elements)));
  assert.match(found.join('\n'), new RegExp(`more than ${MAX_BLOCKS} blocks`));
  // and 49 dividers fit
  const fits = { card: card(keys.slice(0, MAX_BLOCKS - 1)) };
  for (const key of keys.slice(0, MAX_BLOCKS - 1)) fits[key] = ['Divider'];
  assert.equal(buildCard(spec(fits)).slack.blocks.length, MAX_BLOCKS);
});

test('links must be web addresses and images https, so the channel never drops the card for them', () => {
  for (const url of ['javascript:alert(1)', 'mailto:a@b.co', 'slack://open', 'ftp://example.com/x', 'https://exa mple.com']) {
    const found = issues(() => buildCard(spec({ card: card(['a']), a: ['Actions', {}, ['l']], l: ['LinkButton', { label: 'Go', url }] })));
    assert.ok(found.some((issue) => issue.includes('l')), `${url}: ${found.join('\n')}`);
  }
  assert.ok(buildCard(spec({ card: card(['a']), a: ['Actions', {}, ['l']], l: ['LinkButton', { label: 'Go', url: 'http://example.com' }] })));
  for (const url of ['http://example.com/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd']) {
    assert.ok(issues(() => buildCard(spec({ card: card(['i']), i: ['Image', { url, alt: 'x' }] }))).length > 0, url);
    assert.ok(issues(() => buildCard(spec({ card: card([], { title: 'T', imageUrl: url }) }))).length > 0, url);
  }
});
