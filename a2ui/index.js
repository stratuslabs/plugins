// ui.render: the agent shows a native screen as A2UI v1.0 JSON.
//
// The plugin validates and nothing else. A client renders from the call's
// input, which it already receives on `tool.called`; the result tells the
// model only that the screen was accepted, so a large screen is not replayed
// to the model on every later turn. Nothing here can approve anything:
// approvals belong to whatever backend the screen is about.

import { loadCatalogs } from './lib/catalogs.js';
import { validateRender } from './lib/validate.js';

export { A2uiValidationError, compileCatalog, validateRender } from './lib/validate.js';
export { loadCatalogs } from './lib/catalogs.js';

export const RENDER_TOOL_NAME = 'ui.render';
export const CATALOG_TOOL_NAME = 'ui.catalog';
export const DEFAULT_MAX_MESSAGES_BYTES = 64 * 1024;

const readMaxBytes = (config) => {
  const value = config?.maxMessagesBytes;
  if (value === undefined) {
    return DEFAULT_MAX_MESSAGES_BYTES;
  }
  if (!Number.isInteger(value) || value < 1024 || value > 1024 * 1024) {
    throw new Error('@stratusagent/plugin-a2ui: maxMessagesBytes must be a whole number of bytes from 1024 to 1048576.');
  }
  return value;
};

const catalogLine = (catalog) => `- ${catalog.catalogId}${catalog.title ? ` (${catalog.title})` : ''}`;

export const createRenderTool = (catalogs, { maxMessagesBytes = DEFAULT_MAX_MESSAGES_BYTES } = {}) => ({
  name: RENDER_TOOL_NAME,
  description:
    'Show the person a native screen, written as A2UI v1.0 messages (createSurface, updateComponents, '
    + 'updateDataModel, deleteSurface) for one surface. Read the catalog with ui.catalog first. The screen is '
    + 'checked before it is sent: a problem comes back as VALIDATION_FAILED with a JSON Pointer into your input, '
    + 'so fix that spot and call again. Accepted means it was valid and handed to the client, not that the '
    + 'person has seen it. Catalogs:\n'
    + [...catalogs.values()].map(catalogLine).join('\n'),
  // Safe: it acts on nothing. It checks JSON and hands it to the person's
  // own screen, which is the same reach as a text reply.
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      catalogId: { type: 'string', enum: [...catalogs.keys()], description: 'The catalog the screen is built from.' },
      messages: {
        type: 'array',
        minItems: 1,
        description: 'A2UI v1.0 messages for one surface, in order. Each is { "version": "v1.0", "<kind>": { ... } }.',
        items: { type: 'object' },
      },
    },
    required: ['catalogId', 'messages'],
  },
  async execute(input) {
    const surfaceId = validateRender(input, catalogs, { maxMessagesBytes });
    return { surfaceId, accepted: true };
  },
});

export const createCatalogTool = (catalogs) => ({
  name: CATALOG_TOOL_NAME,
  description:
    'Read an A2UI catalog: its design instructions and the schema of every component and function it offers. '
    + 'Without catalogId, lists the catalogs you can build screens from.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      catalogId: { type: 'string', enum: [...catalogs.keys()] },
    },
  },
  async execute(input) {
    const catalogId = input?.catalogId;
    if (catalogId === undefined) {
      return {
        catalogs: [...catalogs.values()].map((catalog) => ({
          catalogId: catalog.catalogId,
          title: catalog.title ?? null,
          description: catalog.description ?? null,
          components: Object.keys(catalog.components),
        })),
      };
    }
    const catalog = catalogs.get(catalogId);
    if (!catalog) {
      throw new Error(`Unknown catalogId "${catalogId}". Use one of: ${[...catalogs.keys()].join(', ')}.`);
    }
    return {
      catalogId: catalog.catalogId,
      title: catalog.title ?? null,
      instructions: catalog.instructions ?? null,
      components: catalog.components,
      functions: catalog.functions,
    };
  },
});

export const createPlugin = (config = {}, { fetchImpl } = {}) => {
  const maxMessagesBytes = readMaxBytes(config);
  return {
    name: 'a2ui',
    async setup(context) {
      // Every catalog loads and compiles before a tool exists, so a bad one
      // refuses the plugin here instead of failing a screen mid-turn.
      const catalogs = await loadCatalogs(config.catalogs, fetchImpl ? { fetchImpl } : {});
      context.tools.register(createCatalogTool(catalogs));
      context.tools.register(createRenderTool(catalogs, { maxMessagesBytes }));
    },
  };
};
