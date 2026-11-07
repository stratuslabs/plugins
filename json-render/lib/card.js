// A json-render spec to a Stratus tool post: { text, slack: { blocks } }.
//
// json-render's toCard checks the spec against the catalog and resolves its
// state, repeat and templates; Chat SDK's Slack adapter turns the card into
// Block Kit and plain text. Only the adapter's `blocks` entry is imported:
// it is the converter alone, without the Slack client the package's main
// entry starts.

import { CardSpecError, toCard } from '@json-render/chat';
import { cardToBlockKit, cardToFallbackText } from '@chat-adapter/slack/blocks';

import { components } from './catalog.js';

/** Slack's limit on blocks in one message; channel-slack sends a post over it as text alone. */
export const MAX_BLOCKS = 50;

/**
 * What Slack shows natively, from the caps in @chat-adapter/slack's blocks
 * converter. Past them it quietly turns a table or chart into a code block,
 * or cuts the message short; refusing instead tells the model what to
 * change. `tableRows` counts the header row.
 */
export const CARD_LIMITS = Object.freeze({
  tables: 1,
  charts: 2,
  fields: 10,
  tableRows: 100,
  tableColumns: 20,
  chartTitle: 50,
  chartLabel: 20,
  chartSeries: 12,
  chartPoints: 20,
});

/** Characters in all of a table's cells, header included, before the converter gives up on it. */
export const MAX_TABLE_CHARS = 10_000;

/** Buttons in one Actions row; the converter drops any past it. */
export const MAX_ACTIONS = 25;

/** A spec that can't be posted, with one issue per problem for the model to fix. */
export class CardError extends Error {
  constructor(issues) {
    const count = issues.length === 1 ? 'a problem' : `${issues.length} problems`;
    super(`The card spec has ${count}. Fix ${issues.length === 1 ? 'it' : 'each'} and call chat.card again:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'CardError';
    this.issues = issues;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const shapeProblem = (spec) => {
  if (!isObject(spec)) {
    return 'the input must be a spec object: { "root": "<element key>", "elements": { ... }, "state": { ... } }';
  }
  if (typeof spec.root !== 'string' || spec.root.length === 0) {
    return 'root must be the key of the Card element in elements';
  }
  if (!isObject(spec.elements)) {
    return 'elements must be an object of element key to { "type", "props", "children" }';
  }
  if (spec.state !== undefined && !isObject(spec.state)) {
    return 'state, when given, must be an object';
  }
  return undefined;
};

/** What the converter would cut or turn to a code block without saying so, by element. */
const overLimits = (children, found = []) => {
  for (const child of children) {
    if (child.type === 'table') {
      const chars = [child.headers, ...child.rows].flat().reduce((total, cell) => total + String(cell).length, 0);
      if (chars > MAX_TABLE_CHARS) {
        found.push(`a Table has ${chars} characters in its cells and Slack shows at most ${MAX_TABLE_CHARS}: shorten cells or drop rows`);
      }
    } else if (child.type === 'actions' && child.children.length > MAX_ACTIONS) {
      found.push(`an Actions row has ${child.children.length} buttons and Slack shows at most ${MAX_ACTIONS}`);
    } else if (child.type === 'section') {
      overLimits(child.children, found);
    }
  }
  return found;
};

/**
 * The post a spec makes, or a CardError listing what to fix. Pure: the same
 * spec gives the same post, and nothing is sent from here.
 */
export const buildCard = (spec) => {
  const problem = shapeProblem(spec);
  if (problem !== undefined) {
    throw new CardError([problem]);
  }
  let card;
  try {
    card = toCard(spec, { components, limits: CARD_LIMITS });
  } catch (error) {
    if (error instanceof CardSpecError) {
      throw new CardError(error.issues.length > 0 ? error.issues : [error.message]);
    }
    throw new CardError([`the spec could not be read: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const over = overLimits(card.children);
  if (over.length > 0) {
    throw new CardError(over);
  }
  // One past Slack's limit, so a card that is too long shows as too long
  // instead of being cut at 50 by the converter.
  const blocks = cardToBlockKit(card, { maxBlocks: MAX_BLOCKS + 1 });
  const text = cardToFallbackText(card);
  if (blocks.length === 0 || text.trim().length === 0) {
    throw new CardError(['the card is empty: give the Card a title or at least one child with something to show']);
  }
  if (blocks.length > MAX_BLOCKS) {
    throw new CardError([`the card makes more than ${MAX_BLOCKS} blocks and Slack takes at most ${MAX_BLOCKS} in a message: drop elements, or put rows in a Table`]);
  }
  // JSON round trip: the post is stored with the session and replayed, so it
  // carries plain data only, never an undefined left by the converter.
  return JSON.parse(JSON.stringify({ text, slack: { blocks } }));
};
