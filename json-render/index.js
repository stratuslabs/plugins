// chat.card: the agent posts a native Slack card from a json-render spec.
//
// The plugin checks the spec and builds the card; it sends nothing itself.
// The tool's result carries the card as a post (`{ post: { text, slack:
// { blocks } } }`, the convention core reads with `postOf`), and the channel
// the conversation is on posts it in the thread, in order with the reply:
// Slack shows the blocks, a channel without blocks shows the text. The
// model is shown only the text, so a card's blocks are not replayed to it on
// every later turn; the spec it wrote stays in the call's input.

import { buildCard } from './lib/card.js';
import { componentNames } from './lib/catalog.js';

export { buildCard, CardError, CARD_LIMITS, MAX_ACTIONS, MAX_BLOCKS, MAX_TABLE_CHARS } from './lib/card.js';
export { catalog, componentLines, componentNames, components } from './lib/catalog.js';

export const CARD_TOOL_NAME = 'chat.card';
export const SKILL_ID = 'json-render-cards';

export const createCardTool = () => ({
  name: CARD_TOOL_NAME,
  description:
    'Post a card in this conversation: a native Slack message with a header, fields, a table, up to 2 charts, '
    + 'text and link buttons, built from a json-render spec { root, elements, state? }. The root element is a Card. '
    + `Components: ${componentNames.join(', ')}. Read the ${SKILL_ID} skill for their props and the limits. `
    + 'The spec is checked before anything is posted: a problem comes back as an error listing each one, so fix '
    + 'them and call again. The card goes in the thread with your reply, so do not repeat its contents there. '
    + 'Where blocks cannot be shown, the card is posted as its text.',
  // Safe: it builds a message for the conversation the reply already goes
  // to, the same reach as the reply's own words. Its link buttons are links
  // the model could already write, and the channel checks the blocks again.
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'The key of the Card element in elements.' },
      elements: {
        type: 'object',
        description: 'Element key to { "type": <component>, "props": { ... }, "children": [<element keys>] }. Optional "repeat" and "visible" sit beside props.',
        additionalProperties: { type: 'object' },
      },
      state: { type: 'object', description: 'Data that props read with { "$state": "/path" } and that repeat iterates.' },
    },
    required: ['root', 'elements'],
  },
  async execute(input) {
    return { post: buildCard(input) };
  },
});

export const createPlugin = () => ({
  name: 'json-render',
  setup(context) {
    context.tools.register(createCardTool());
  },
});
