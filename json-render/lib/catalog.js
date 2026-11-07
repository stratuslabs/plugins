// The components an agent may build a card from: json-render's standard chat
// components, narrowed to what a Stratus thread will show.
//
// - No Button. A Slack button without a link needs a handler for its click,
//   and a post has none: channel-slack sends a card holding one as its text
//   alone. LinkButton opens its URL and needs nothing back.
// - Links are web addresses and images are https, the same test channel-slack
//   applies before it sends a card, so a card is never dropped for them after
//   the model was told it was fine.

import { defineCatalog } from '@json-render/core';
import { schema, standardComponentDefinitions } from '@json-render/chat';
import { z } from 'zod';

const WEB_URL = /^https?:\/\/\S+$/i;
const HTTPS_URL = /^https:\/\/\S+$/i;

const webUrl = z.string().url().regex(WEB_URL, 'must be an http or https URL with no spaces');
const httpsUrl = z.string().url().regex(HTTPS_URL, 'must be an https URL with no spaces');

const { Button: _button, ...standard } = standardComponentDefinitions;

export const components = {
  ...standard,
  Card: {
    ...standard.Card,
    props: standard.Card.props.extend({ imageUrl: httpsUrl.nullish() }),
  },
  Image: {
    ...standard.Image,
    props: standard.Image.props.extend({ url: httpsUrl }),
  },
  Actions: {
    ...standard.Actions,
    description: 'Row of LinkButton elements.',
  },
  LinkButton: {
    ...standard.LinkButton,
    props: standard.LinkButton.props.extend({ url: webUrl }),
    description: 'Button that opens an http or https URL. The only kind of button a card can hold.',
  },
};

export const componentNames = Object.keys(components);

export const catalog = defineCatalog(schema, { components });

/**
 * The AVAILABLE COMPONENTS lines of json-render's own catalog prompt for this
 * catalog: one line per component with its props. The skill carries them
 * verbatim, and a test keeps the two the same.
 */
export const componentLines = () => {
  const prompt = catalog.prompt();
  const start = prompt.indexOf('AVAILABLE COMPONENTS');
  if (start === -1) {
    throw new Error('json-render catalog prompt has no AVAILABLE COMPONENTS section');
  }
  const lines = prompt.slice(start).split('\n').slice(1);
  const first = lines.findIndex((line) => line.startsWith('- '));
  const list = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith('- ')) {
      break;
    }
    list.push(line);
  }
  return list;
};
