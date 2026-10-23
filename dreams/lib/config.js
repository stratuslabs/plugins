import path from 'node:path';

/**
 * The plugin's config block, checked once at load. Everything here is
 * operator config: the `plugins` block is read only from a trusted config,
 * so an agent cannot name an experiment for itself.
 */

const PREFIX = '@stratusagent/plugin-dreams';
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

const fail = (message) => {
  throw new Error(`${PREFIX}: ${message}`);
};

/** `8h`, `30m`, `2h30m`, `90s`: the experimenter's own duration format, in seconds. */
export const parseDuration = (value, where) => {
  if (typeof value !== 'string' || !/^(\d+h)?(\d+m)?(\d+s)?$/.test(value.trim()) || value.trim() === '') {
    fail(`${where} is a duration such as "6h", "45m" or "2h30m".`);
  }
  const [, h = '0', m = '0', s = '0'] = value.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  if (seconds <= 0) {
    fail(`${where} must be longer than zero.`);
  }
  return seconds;
};

const parseClock = (value, where) => {
  const match = typeof value === 'string' ? value.trim().match(CLOCK) : null;
  if (!match) {
    fail(`${where} is two local times, "HH:MM-HH:MM", e.g. "23:00-07:00".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

export const parseWindow = (value, where) => {
  if (typeof value !== 'string' || !value.includes('-')) {
    fail(`${where} is two local times, "HH:MM-HH:MM", e.g. "23:00-07:00".`);
  }
  const [start, end, ...rest] = value.split('-');
  if (rest.length > 0) {
    fail(`${where} is two local times, "HH:MM-HH:MM", e.g. "23:00-07:00".`);
  }
  const window = { start: parseClock(start, where), end: parseClock(end, where) };
  if (window.start === window.end) {
    fail(`${where} starts and ends at the same time.`);
  }
  return window;
};

const absolute = (value, where) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail(`${where} is an absolute path.`);
  }
  return path.resolve(value);
};

const parseExperiment = (raw, where) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where} is an object with at least a "path".`);
  }
  if (raw.agent !== undefined && raw.agent !== 'claude') {
    // The experimenter hands codex no tool restrictions at all.
    fail(`${where}.agent can only be "claude": the experimenter runs codex with no tool restrictions.`);
  }
  const direction = raw.direction ?? 'maximize';
  if (direction !== 'maximize' && direction !== 'minimize') {
    fail(`${where}.direction is "maximize" or "minimize".`);
  }
  if (raw.maxExperiments !== undefined && (!Number.isInteger(raw.maxExperiments) || raw.maxExperiments < 1)) {
    fail(`${where}.maxExperiments is a whole number of 1 or more.`);
  }
  return {
    path: absolute(raw.path, `${where}.path`),
    budgetSeconds: parseDuration(raw.budget ?? '8h', `${where}.budget`),
    direction,
    ...(raw.maxExperiments !== undefined ? { maxExperiments: raw.maxExperiments } : {}),
  };
};

/**
 * ```json
 * { "agents": { "atlas": { "window": "23:00-07:00", "maxPerNight": 1,
 *   "experiments": [{ "path": "/Users/me/experiments/judge", "budget": "6h", "direction": "maximize" }] } },
 *   "readPaths": ["~/.pyenv"], "overnightPath": "/opt/homebrew/bin/overnight", "claudePath": "/opt/homebrew/bin/claude" }
 * ```
 */
export const parseDreamsConfig = (config, { home } = {}) => {
  const raw = config ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('its config is an object.');
  }
  const agentsRaw = raw.agents ?? {};
  if (typeof agentsRaw !== 'object' || Array.isArray(agentsRaw)) {
    fail('"agents" maps an agent id to its dream window and experiments.');
  }
  const agents = new Map();
  for (const [agentId, block] of Object.entries(agentsRaw)) {
    const where = `agents.${agentId}`;
    if (!AGENT_ID.test(agentId)) {
      fail(`${JSON.stringify(agentId)} is not an agent id.`);
    }
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      fail(`${where} is an object with "window" and "experiments".`);
    }
    const maxPerNight = block.maxPerNight ?? 1;
    if (!Number.isInteger(maxPerNight) || maxPerNight < 1) {
      fail(`${where}.maxPerNight is a whole number of 1 or more.`);
    }
    if (!Array.isArray(block.experiments) || block.experiments.length === 0) {
      fail(`${where}.experiments lists at least one experiment.`);
    }
    if (block.prompts !== undefined || block.dreams !== undefined) {
      fail(`${where}: prompt dreams are not in this version; only "experiments" run.`);
    }
    agents.set(agentId, {
      window: parseWindow(block.window, `${where}.window`),
      maxPerNight,
      experiments: block.experiments.map((experiment, index) => parseExperiment(experiment, `${where}.experiments[${index}]`)),
    });
  }
  const expand = (value) => (home && (value === '~' || value.startsWith('~/')) ? path.join(home, value.slice(1)) : value);
  const readPaths = (Array.isArray(raw.readPaths) ? raw.readPaths : raw.readPaths === undefined ? [] : fail('"readPaths" is a list of paths.'))
    .map((entry, index) => absolute(typeof entry === 'string' ? expand(entry) : entry, `readPaths[${index}]`));
  return {
    agents,
    readPaths,
    ...(raw.overnightPath !== undefined ? { overnightPath: absolute(expand(raw.overnightPath), 'overnightPath') } : {}),
    ...(raw.claudePath !== undefined ? { claudePath: absolute(expand(raw.claudePath), 'claudePath') } : {}),
  };
};
