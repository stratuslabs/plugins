import { isTimeZone, parseWindow } from './window.js';

/**
 * The plugin's config, per agent. Only agents listed under `agents` are
 * enrolled. Settings at the top level are defaults for every listed agent,
 * and an agent's own block overrides them key by key, inside `save` and
 * `tidy` too. The loader has already checked types against the manifest's
 * schema; this checks what that schema cannot say.
 */

export const DEFAULT_QUIET_MINUTES = 30;
export const DEFAULT_MAX_GROUPS_PER_NIGHT = 10;
/** Shadow until someone has read what a pass would write. */
export const DEFAULT_MODE = 'shadow';

const MODES = ['shadow', 'write'];
const KINDS = ['public', 'private', 'group', 'direct'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const section = (shared, own, key, where) => {
  for (const [value, path] of [[shared[key], key], [own[key], `${where}.${key}`]]) {
    if (value !== undefined && !isObject(value)) {
      throw new Error(`memory-upkeep: ${path} must be an object.`);
    }
  }
  return { ...(shared[key] ?? {}), ...(own[key] ?? {}) };
};

const readAgent = (agentId, shared, own, defaultTimeZone) => {
  const where = `agents.${agentId}`;
  if (!isObject(own)) {
    throw new Error(`memory-upkeep: ${where} must be an object of settings ({} takes the defaults).`);
  }
  const pick = (key) => (own[key] !== undefined ? own[key] : shared[key]);
  const settings = {};

  const model = pick('model');
  if (model !== undefined) {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error(`memory-upkeep: ${where}.model must name a model, e.g. "claude-haiku-4-5". Leave it out to use the agent's own.`);
    }
    settings.model = model.trim();
  }

  const mode = pick('mode') ?? DEFAULT_MODE;
  if (!MODES.includes(mode)) {
    throw new Error(`memory-upkeep: ${where}.mode must be "shadow" or "write" (got ${JSON.stringify(mode)}).`);
  }
  settings.mode = mode;

  const save = section(shared, own, 'save', where);
  const quietMinutes = save.quietMinutes ?? DEFAULT_QUIET_MINUTES;
  if (typeof quietMinutes !== 'number' || !Number.isFinite(quietMinutes) || quietMinutes <= 0) {
    throw new Error(`memory-upkeep: ${where}.save.quietMinutes must be a number of minutes above 0 (got ${JSON.stringify(quietMinutes)}).`);
  }
  settings.save = { quietMinutes };
  if (save.from !== undefined) {
    if (!Array.isArray(save.from) || save.from.some((kind) => !KINDS.includes(kind))) {
      throw new Error(`memory-upkeep: ${where}.save.from may list only ${KINDS.join(', ')} (got ${JSON.stringify(save.from)}).`);
    }
    settings.save.from = [...new Set(save.from)];
  }
  const scheduled = save.scheduled ?? false;
  if (typeof scheduled !== 'boolean') {
    throw new Error(`memory-upkeep: ${where}.save.scheduled must be true or false (got ${JSON.stringify(scheduled)}).`);
  }
  settings.save.scheduled = scheduled;

  const tidy = section(shared, own, 'tidy', where);
  if (Object.keys(tidy).length > 0) {
    const window = parseWindow(tidy.window);
    if (window === undefined) {
      throw new Error(`memory-upkeep: ${where}.tidy.window must be "HH:MM-HH:MM" on a 24-hour clock, start and end different, e.g. "03:00-05:00" (got ${JSON.stringify(tidy.window)}).`);
    }
    const timeZone = tidy.timeZone ?? defaultTimeZone;
    if (!isTimeZone(timeZone)) {
      throw new Error(`memory-upkeep: ${where}.tidy.timeZone must be an IANA time zone, e.g. "America/New_York" (got ${JSON.stringify(timeZone)}).`);
    }
    const maxGroupsPerNight = tidy.maxGroupsPerNight ?? DEFAULT_MAX_GROUPS_PER_NIGHT;
    if (!Number.isInteger(maxGroupsPerNight) || maxGroupsPerNight < 0) {
      throw new Error(`memory-upkeep: ${where}.tidy.maxGroupsPerNight must be a whole number, 0 or more (got ${JSON.stringify(maxGroupsPerNight)}).`);
    }
    // 0 turns tidy off for this agent while the default keeps it on for others.
    if (maxGroupsPerNight > 0) {
      settings.tidy = { window, timeZone, maxGroupsPerNight };
    }
  }
  return settings;
};

/** Agent id -> its settings, in the order the config lists them. */
export const readUpkeepConfig = (config = {}, { defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) => {
  const { agents, ...shared } = isObject(config) ? config : {};
  const enrolled = new Map();
  if (agents === undefined) {
    return enrolled;
  }
  if (!isObject(agents)) {
    throw new Error('memory-upkeep: "agents" must be an object keyed by agent id, e.g. { "atlas": {} }.');
  }
  for (const [agentId, own] of Object.entries(agents)) {
    enrolled.set(agentId, readAgent(agentId, shared, own, defaultTimeZone));
  }
  return enrolled;
};
