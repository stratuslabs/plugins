// A2UI v1.0 validation for ui.render: the schema (ajv, JSON Schema 2020-12)
// and the component tree (one root, every child exists, no cycles).
//
// One ajv instance per catalog. A2UI's envelope schema points at
// `catalog.json`, and a catalog points at `common_types.json`, both relative
// to the spec's own base. A2UI's own test runner validates by giving the
// catalog the `$id` the envelope expects, and so does this.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SPEC_BASE = 'https://a2ui.org/specification/v1_0/';
const CATALOG_ALIAS = `${SPEC_BASE}catalog.json`;

const readSpec = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/v1_0/${name}`, import.meta.url)), 'utf8'));
const COMMON_TYPES = readSpec('common_types.json');
const AGENT_TO_RENDERER = readSpec('agent_to_renderer.json');

/** The message kinds ui.render takes, and the envelope definition each validates against. */
export const MESSAGE_KINDS = {
  createSurface: 'CreateSurfaceMessage',
  updateComponents: 'UpdateComponentsMessage',
  updateDataModel: 'UpdateDataModelMessage',
  deleteSurface: 'DeleteSurfaceMessage',
};

/** Kinds that are valid A2UI but need a renderer round trip ui.render does not carry. */
const UNSUPPORTED_KINDS = ['callRendererFunction', 'agentFunctionResponse'];

/** The function every renderer provides inside list templates (common_types IndexSystemFunction). */
const SYSTEM_INDEX_FUNCTION = '@index';

/** The failure the model is handed, in A2UI's standard validation error shape. */
export class A2uiValidationError extends Error {
  constructor({ surfaceId = '', path = '', message }) {
    const detail = { code: 'VALIDATION_FAILED', surfaceId, path, message };
    super(JSON.stringify(detail));
    this.name = 'A2uiValidationError';
    this.detail = detail;
  }
}

const pointerEscape = (segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
const pointer = (...segments) => segments.map((segment) => `/${pointerEscape(segment)}`).join('');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Where a component's child references live, read from its catalog schema:
 * every property whose schema is common_types `Child` (one id) or
 * `ChildList` (ids, or a template naming one). `*` stands for each item of
 * an array. Local `$ref`s are followed; a cycle in the schema stops.
 */
const childSlotsOf = (schema, catalog, path = [], seen = new Set()) => {
  if (!isObject(schema)) {
    return [];
  }
  const slots = [];
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    if (/common_types\.json#\/\$defs\/Child$/.test(ref)) {
      slots.push({ path, kind: 'child' });
    } else if (/common_types\.json#\/\$defs\/ChildList$/.test(ref)) {
      slots.push({ path, kind: 'list' });
    } else if (ref.startsWith('#/') && !seen.has(ref)) {
      const target = ref
        .slice(2)
        .split('/')
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
        .reduce((node, key) => (isObject(node) ? node[key] : undefined), catalog);
      slots.push(...childSlotsOf(target, catalog, path, new Set([...seen, ref])));
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) {
        slots.push(...childSlotsOf(branch, catalog, path, seen));
      }
    }
  }
  if (isObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      slots.push(...childSlotsOf(property, catalog, [...path, name], seen));
    }
  }
  if (isObject(schema.items)) {
    slots.push(...childSlotsOf(schema.items, catalog, [...path, '*'], seen));
  }
  return slots;
};

/** The ids a component instance refers to, each with the pointer (relative to the component) it sits at. */
const childReferences = (component, slots) => {
  const found = [];
  const walk = (value, path, at, kind) => {
    if (path.length === 0) {
      if (kind === 'child' && typeof value === 'string') {
        found.push({ id: value, at });
      } else if (kind === 'list' && Array.isArray(value)) {
        value.forEach((id, index) => typeof id === 'string' && found.push({ id, at: `${at}/${index}` }));
      } else if (kind === 'list' && isObject(value) && typeof value.componentId === 'string') {
        found.push({ id: value.componentId, at: `${at}/componentId` });
      }
      return;
    }
    const [head, ...rest] = path;
    if (head === '*') {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, rest, `${at}/${index}`, kind));
      }
    } else if (isObject(value) && head in value) {
      walk(value[head], rest, `${at}${pointer(head)}`, kind);
    }
  };
  for (const slot of slots) {
    walk(component, slot.path, '', slot.kind);
  }
  return found;
};

const describeAjvError = (error) => {
  const { keyword, params } = error;
  switch (keyword) {
    case 'required':
      return { at: `${error.instancePath}${pointer(params.missingProperty)}`, message: `Missing required property "${params.missingProperty}".` };
    case 'additionalProperties':
      return { at: error.instancePath, message: `Unknown property "${params.additionalProperty}".` };
    case 'unevaluatedProperties':
      return { at: error.instancePath, message: `Unknown property "${params.unevaluatedProperty}".` };
    case 'enum':
      return { at: error.instancePath, message: `Must be one of: ${params.allowedValues.map((value) => JSON.stringify(value)).join(', ')}.` };
    case 'const':
      return { at: error.instancePath, message: `Must be ${JSON.stringify(params.allowedValue)}.` };
    default:
      return { at: error.instancePath, message: `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.` };
  }
};

/**
 * The one ajv error most worth telling the model. A failed `oneOf` reports
 * every branch it tried; the deepest concrete error is usually the real one.
 */
const bestError = (errors) => {
  const combinators = new Set(['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else']);
  const concrete = errors.filter((error) => !combinators.has(error.keyword));
  const pool = concrete.length > 0 ? concrete : errors;
  // Deepest first. At equal depth, an error inside the right shape (a
  // missing "@path") beats a bare type mismatch, which usually means the
  // validator was trying a branch the model never meant.
  const rank = (error) => error.instancePath.split('/').length * 2 + (error.keyword === 'type' ? 0 : 1);
  return pool.reduce((best, error) => (rank(error) > rank(best) ? error : best), pool[0]);
};

/** Every `$ref` string anywhere under `node`. */
const refsIn = (node, found = []) => {
  if (Array.isArray(node)) {
    node.forEach((item) => refsIn(item, found));
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        found.push(value);
      } else {
        refsIn(value, found);
      }
    }
  }
  return found;
};

/**
 * The definitions a catalog's component and function schemas point at, so
 * ui.catalog can hand the model self-contained shapes: the common_types
 * `$defs` they reach (followed through common_types' own local refs), and
 * the catalog's own `$defs` they name with `#/$defs/...`.
 */
const referencedDefinitions = (catalog) => {
  const commonTypes = {};
  const catalogDefs = {};
  const commonDefs = isObject(COMMON_TYPES.$defs) ? COMMON_TYPES.$defs : {};
  const ownDefs = isObject(catalog.$defs) ? catalog.$defs : {};
  const pending = [...refsIn(catalog.components), ...refsIn(catalog.functions ?? {})].map((ref) => ({ ref, inCommon: false }));
  while (pending.length > 0) {
    const { ref, inCommon } = pending.pop();
    const common = /(?:^|\/)common_types\.json#\/\$defs\/([^/]+)$/.exec(ref) ?? (inCommon ? /^#\/\$defs\/([^/]+)$/.exec(ref) : null);
    if (common) {
      const name = common[1].replaceAll('~1', '/').replaceAll('~0', '~');
      if (!(name in commonTypes) && name in commonDefs) {
        commonTypes[name] = commonDefs[name];
        pending.push(...refsIn(commonDefs[name]).map((next) => ({ ref: next, inCommon: true })));
      }
      continue;
    }
    const own = inCommon ? null : /^#\/\$defs\/([^/]+)$/.exec(ref);
    if (own) {
      const name = own[1].replaceAll('~1', '/').replaceAll('~0', '~');
      if (!(name in catalogDefs) && name in ownDefs) {
        catalogDefs[name] = ownDefs[name];
        pending.push(...refsIn(ownDefs[name]).map((next) => ({ ref: next, inCommon: false })));
      }
    }
  }
  return { commonTypes, catalogDefs };
};

const catalogError = (source, message) => new Error(`@stratusagent/plugin-a2ui: catalog ${source}: ${message}`);

/**
 * Compile one catalog. Throws, naming the catalog, when it is not a usable
 * A2UI v1.0 catalog, so a bad catalog refuses the plugin at setup rather
 * than failing the first screen.
 */
export const compileCatalog = (catalog, source) => {
  if (!isObject(catalog)) {
    throw catalogError(source, 'is not a JSON object.');
  }
  if (typeof catalog.catalogId !== 'string' || catalog.catalogId.length === 0) {
    throw catalogError(source, 'has no "catalogId".');
  }
  if (!isObject(catalog.components) || Object.keys(catalog.components).length === 0) {
    throw catalogError(source, 'defines no components.');
  }
  if (!isObject(catalog.$defs) || !isObject(catalog.$defs.anyComponent)) {
    throw catalogError(source, 'has no "$defs.anyComponent", which A2UI v1.0 requires.');
  }

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  let messageValidators;
  let componentValidators;
  let functionValidators;
  try {
    ajv.addSchema(COMMON_TYPES);
    ajv.addSchema({ ...catalog, $id: CATALOG_ALIAS });
    ajv.addSchema(AGENT_TO_RENDERER);
    messageValidators = Object.fromEntries(
      Object.entries(MESSAGE_KINDS).map(([kind, definition]) => [
        kind,
        ajv.compile({ $id: `${SPEC_BASE}stratus/message/${kind}.json`, $ref: `${SPEC_BASE}agent_to_renderer.json#/$defs/${definition}` }),
      ]),
    );
    componentValidators = new Map(
      Object.keys(catalog.components).map((name, index) => [
        name,
        ajv.compile({
          $id: `${SPEC_BASE}stratus/component/${index}.json`,
          allOf: [
            { $ref: `${SPEC_BASE}common_types.json#/$defs/ComponentCommon` },
            { $ref: `${CATALOG_ALIAS}#/components/${pointerEscape(name)}` },
          ],
          unevaluatedProperties: false,
        }),
      ]),
    );
    // Each catalog function, and the one system function, checked the way
    // common_types' FunctionCall combines them, but by name: a catalog's
    // `$defs.anyFunction` can be looser than its functions.
    const functionSchema = (index, target) => ({
      $id: `${SPEC_BASE}stratus/function/${index}.json`,
      allOf: [{ $ref: `${SPEC_BASE}common_types.json#/$defs/FunctionCommon` }, { $ref: target }],
      unevaluatedProperties: false,
    });
    const functions = isObject(catalog.functions) ? catalog.functions : {};
    functionValidators = new Map([
      ...Object.keys(functions).map((name, index) => [
        name,
        ajv.compile(functionSchema(index, `${CATALOG_ALIAS}#/functions/${pointerEscape(name)}`)),
      ]),
      [SYSTEM_INDEX_FUNCTION, ajv.compile(functionSchema('index', `${SPEC_BASE}common_types.json#/$defs/IndexSystemFunction`))],
    ]);
  } catch (error) {
    throw catalogError(source, `does not compile as JSON Schema 2020-12: ${error.message}`);
  }

  const { commonTypes, catalogDefs } = referencedDefinitions(catalog);
  const childSlots = new Map(Object.entries(catalog.components).map(([name, schema]) => [name, childSlotsOf(schema, catalog)]));

  return {
    catalogId: catalog.catalogId,
    title: typeof catalog.title === 'string' ? catalog.title : undefined,
    description: typeof catalog.description === 'string' ? catalog.description : undefined,
    instructions: typeof catalog.instructions === 'string' ? catalog.instructions : undefined,
    components: catalog.components,
    functions: isObject(catalog.functions) ? catalog.functions : {},
    commonTypes,
    catalogDefs,
    messageValidators,
    componentValidators,
    functionValidators,
    childSlots,
  };
};

/**
 * The first function call anywhere inside `value` that this catalog cannot
 * run: one that names another catalog, names no function the catalog
 * defines, or does not match that function's own schema. Calls nested in a
 * call's args are checked too.
 */
const functionProblem = (compiled, value, at) => {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = functionProblem(compiled, item, `${at}/${index}`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isObject(value)) {
    return undefined;
  }
  if (Object.hasOwn(value, '@call')) {
    const name = value['@call'];
    if (Object.hasOwn(value, 'catalogId') && value.catalogId !== compiled.catalogId) {
      return { at: `${at}/catalogId`, message: `ui.render checks one catalog per call; this function call names "${value.catalogId}".` };
    }
    const validate = typeof name === 'string' ? compiled.functionValidators.get(name) : undefined;
    if (!validate) {
      const known = [...compiled.functionValidators.keys()].join(', ');
      return { at: `${at}/@call`, message: `Unknown function ${JSON.stringify(name)}. This catalog has: ${known}.` };
    }
    if (!validate(value)) {
      const { at: inner, message } = describeAjvError(bestError(validate.errors));
      return { at: `${at}${inner}`, message: `${name}: ${message}` };
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const found = functionProblem(compiled, child, `${at}${pointer(key)}`);
    if (found) {
      return found;
    }
  }
  return undefined;
};

/** Find the component that made a message invalid, and say what is wrong with it. */
const componentProblem = (compiled, components, at) => {
  if (!Array.isArray(components)) {
    return undefined;
  }
  for (const [index, component] of components.entries()) {
    const here = `${at}/${index}`;
    if (!isObject(component)) {
      return { at: here, message: 'A component must be an object.' };
    }
    if (typeof component.component !== 'string') {
      return { at: `${here}/component`, message: 'Missing the component type ("component").' };
    }
    const validate = compiled.componentValidators.get(component.component);
    if (!validate) {
      const known = [...compiled.componentValidators.keys()].join(', ');
      return { at: `${here}/component`, message: `Unknown component "${component.component}". This catalog has: ${known}.` };
    }
    // Function calls first: a bad call also fails the component's schema,
    // and the function's own error says more.
    const call = functionProblem(compiled, component, here);
    if (call) {
      return { at: call.at, message: `${component.component} "${component.id ?? '?'}": ${call.message}` };
    }
    if (!validate(component)) {
      const { at: inner, message } = describeAjvError(bestError(validate.errors));
      return { at: `${here}${inner}`, message: `${component.component} "${component.id ?? '?'}": ${message}` };
    }
  }
  return undefined;
};

/**
 * Validate one ui.render call. Returns the surface id it renders; throws an
 * `A2uiValidationError` at the first problem. Pointers are relative to the
 * tool input, so `/messages/1/updateComponents/components/0/text` names the
 * `text` of the first component in the second message.
 *
 * One call carries one surface. Tree completeness can only be judged for a
 * surface this call creates: an update to a surface made by an earlier call
 * may refer to components that call defined, which this plugin does not
 * keep.
 */
export const validateRender = (input, catalogs, { maxMessagesBytes }) => {
  if (!isObject(input)) {
    throw new A2uiValidationError({ message: 'Input must be an object: { catalogId, messages }.' });
  }
  const { catalogId, messages } = input;
  if (typeof catalogId !== 'string' || !catalogs.has(catalogId)) {
    throw new A2uiValidationError({
      path: '/catalogId',
      message: `Unknown catalogId ${JSON.stringify(catalogId ?? null)}. Use one of: ${[...catalogs.keys()].join(', ')}.`,
    });
  }
  const compiled = catalogs.get(catalogId);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new A2uiValidationError({ path: '/messages', message: '"messages" must be a non-empty array of A2UI messages.' });
  }
  const size = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (size > maxMessagesBytes) {
    throw new A2uiValidationError({
      path: '/messages',
      message: `The messages are ${size} bytes; the limit is ${maxMessagesBytes}. Send a smaller screen, or bind long content through the data model.`,
    });
  }

  let surfaceId;
  let created = false;
  let deleted = false;
  const tree = new Map();

  for (const [index, message] of messages.entries()) {
    const at = `/messages/${index}`;
    if (!isObject(message)) {
      throw new A2uiValidationError({ surfaceId, path: at, message: 'Each message must be an object.' });
    }
    const kinds = Object.keys(message).filter((key) => Object.hasOwn(MESSAGE_KINDS, key) || UNSUPPORTED_KINDS.includes(key));
    if (kinds.length !== 1) {
      throw new A2uiValidationError({
        surfaceId,
        path: at,
        message: `Each message needs exactly one of ${Object.keys(MESSAGE_KINDS).join(', ')}, plus "version": "v1.0".`,
      });
    }
    const [kind] = kinds;
    if (UNSUPPORTED_KINDS.includes(kind)) {
      throw new A2uiValidationError({ surfaceId, path: `${at}/${kind}`, message: `ui.render does not send ${kind}.` });
    }
    const body = message[kind];
    const messageSurface = isObject(body) && typeof body.surfaceId === 'string' ? body.surfaceId : undefined;
    const reportedSurface = surfaceId ?? messageSurface ?? '';

    // Each component is checked against its own catalog schema whether or
    // not the envelope passed: a catalog's `$defs.anyComponent` can be looser
    // than its components, and the renderer needs the component to be right.
    const validate = compiled.messageValidators[kind];
    const envelopeOk = validate(message);
    const found = isObject(body) ? componentProblem(compiled, body.components, `${at}/${kind}/components`) : undefined;
    if (!envelopeOk || found) {
      const { at: where, message: what } = found ?? (() => {
        const described = describeAjvError(bestError(validate.errors));
        return { at: `${at}${described.at}`, message: described.message };
      })();
      throw new A2uiValidationError({ surfaceId: reportedSurface, path: where, message: what });
    }

    if (surfaceId === undefined) {
      surfaceId = messageSurface;
    } else if (messageSurface !== surfaceId) {
      throw new A2uiValidationError({
        surfaceId,
        path: `${at}/${kind}/surfaceId`,
        message: `One ui.render call carries one surface; this message is for "${messageSurface}", not "${surfaceId}".`,
      });
    }
    if (deleted) {
      throw new A2uiValidationError({ surfaceId, path: at, message: 'Nothing may follow deleteSurface in the same call.' });
    }

    if (kind === 'createSurface') {
      if (index !== 0) {
        throw new A2uiValidationError({ surfaceId, path: at, message: 'createSurface must be the first message.' });
      }
      if (body.catalogId !== catalogId) {
        throw new A2uiValidationError({
          surfaceId,
          path: `${at}/createSurface/catalogId`,
          message: `createSurface.catalogId must be "${catalogId}", the catalog this call is checked against.`,
        });
      }
      created = true;
    } else if (kind === 'deleteSurface') {
      deleted = true;
    }

    const components = kind === 'createSurface' || kind === 'updateComponents' ? body.components ?? [] : [];
    for (const [position, component] of components.entries()) {
      const componentAt = `${at}/${kind}/components/${position}`;
      if (component.catalogId !== undefined && component.catalogId !== catalogId) {
        throw new A2uiValidationError({
          surfaceId,
          path: `${componentAt}/catalogId`,
          message: `ui.render checks one catalog per call; this component names "${component.catalogId}".`,
        });
      }
      tree.set(component.id, { component, at: componentAt });
    }
  }

  checkTree(compiled, tree, { surfaceId, complete: created && !deleted });
  return surfaceId;
};

/**
 * One root, every child defined, no cycles. `complete` is false for an
 * update to a surface an earlier call created: its children may already be
 * on the device, so only cycles among the components sent here are checked.
 */
const checkTree = (compiled, tree, { surfaceId, complete }) => {
  if (complete && !tree.has('root')) {
    throw new A2uiValidationError({
      surfaceId,
      path: '/messages',
      message: 'No component has id "root". A new surface needs one; it is the top of the tree.',
    });
  }
  const edges = new Map();
  for (const [id, { component, at }] of tree) {
    const references = childReferences(component, compiled.childSlots.get(component.component) ?? []);
    for (const reference of references) {
      if (reference.id === 'root') {
        throw new A2uiValidationError({ surfaceId, path: `${at}${reference.at}`, message: `"${id}" lists "root" as a child; root can only be the top.` });
      }
      if (complete && !tree.has(reference.id)) {
        throw new A2uiValidationError({
          surfaceId,
          path: `${at}${reference.at}`,
          message: `"${id}" refers to "${reference.id}", which no component defines.`,
        });
      }
    }
    edges.set(id, references);
  }

  const DONE = 2;
  const ACTIVE = 1;
  const state = new Map();
  const visit = (id) => {
    state.set(id, ACTIVE);
    for (const reference of edges.get(id) ?? []) {
      if (!tree.has(reference.id)) {
        continue;
      }
      if (state.get(reference.id) === ACTIVE) {
        throw new A2uiValidationError({
          surfaceId,
          path: `${tree.get(id).at}${reference.at}`,
          message: `"${id}" refers to "${reference.id}", which contains "${id}": the tree has a cycle.`,
        });
      }
      if (state.get(reference.id) !== DONE) {
        visit(reference.id);
      }
    }
    state.set(id, DONE);
  };
  for (const id of tree.keys()) {
    if (!state.has(id)) {
      visit(id);
    }
  }
};
