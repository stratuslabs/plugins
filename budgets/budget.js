import { HostRefusalError } from '@stratusagent/core';

/**
 * The plugin's config: how many weighted tokens the install may spend on
 * models per UTC day and month (`home`), and how many each agent may
 * (`daily`, `monthly`, overridden per agent under `agents.<id>`, the way
 * every plugin's agents block overrides its defaults).
 *
 * Weighted tokens, not money. A price table isn't ours to own: the operator
 * turns a plan into a number once, here. The weights make that number mean
 * something, because the four buckets aren't priced alike. Under prompt
 * caching most of a long conversation's input is cache reads at about a
 * tenth of the input rate, and a cap that counted them one for one would
 * stop an agent at a tenth of what the operator meant to allow.
 */

export const PACKAGE_NAME = '@stratusagent/plugin-budgets';

/** What one call in flight is charged until its usage arrives; see the README. */
export const DEFAULT_RESERVE_PER_CALL = 50_000;

const PERIODS = ['daily', 'monthly'];
const BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const TOP_KEYS = ['home', 'daily', 'monthly', 'weights', 'reservePerCall', 'agents'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The fold agent ids are matched by everywhere in Stratus: `scout` governs the soul `Scout`. */
export const foldAgentId = (agentId) => agentId.normalize('NFC').toLowerCase().normalize('NFC');

const where = (path) => `plugins["${PACKAGE_NAME}"]${path}`;

// Refused, never skipped: a misspelled limit (`montly`) read as absent would
// leave an install that looks capped running uncapped, silently.
const refuseUnknown = (raw, known, path) => {
  const unknown = Object.keys(raw).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${where(path)} has no setting ${unknown.map((key) => JSON.stringify(key)).join(', ')}. It takes ${known.join(', ')}.`);
  }
};

// Refused rather than clamped: a zero or a fraction is an install where no
// model can answer, and the only clue would be every turn failing with a
// budget message that looks deliberate.
const readLimits = (raw, path) => {
  const limits = {};
  for (const period of PERIODS) {
    const value = raw[period];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`${where(`${path}.${period}`)} is ${JSON.stringify(value)}. Use a whole number of weighted tokens, 1 or more, or leave it out for no limit.`);
    }
    limits[period] = value;
  }
  return limits;
};

const hasLimit = (limits) => PERIODS.some((period) => limits[period] !== undefined);

/**
 * Validate the config and answer the questions the guard asks of it. Thrown
 * from `createPlugin`, so a bad block refuses the plugin at load.
 */
export const parseBudgetConfig = (config = {}) => {
  if (!isObject(config)) throw new Error(`${where('')} must be an object.`);
  refuseUnknown(config, TOP_KEYS, '');

  let home = {};
  if (config.home !== undefined) {
    if (!isObject(config.home)) throw new Error(`${where('.home')} must be an object like { "daily": 2000000 }.`);
    refuseUnknown(config.home, PERIODS, '.home');
    home = readLimits(config.home, '.home');
  }
  const perAgent = readLimits(config, '');

  const weights = {};
  if (config.weights !== undefined) {
    if (!isObject(config.weights)) throw new Error(`${where('.weights')} must be an object keyed by usage bucket.`);
    refuseUnknown(config.weights, BUCKETS, '.weights');
    for (const [bucket, value] of Object.entries(config.weights)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`${where(`.weights.${bucket}`)} is ${JSON.stringify(value)}. Use a number, 0 or more.`);
      }
      weights[bucket] = value;
    }
  }

  let reservePerCall = DEFAULT_RESERVE_PER_CALL;
  if (config.reservePerCall !== undefined) {
    if (typeof config.reservePerCall !== 'number' || !Number.isInteger(config.reservePerCall) || config.reservePerCall < 0) {
      throw new Error(`${where('.reservePerCall')} is ${JSON.stringify(config.reservePerCall)}. Use a whole number of weighted tokens, 0 or more.`);
    }
    reservePerCall = config.reservePerCall;
  }

  // An agent's entry holds only its own limits: the install's total, the
  // weights and the reserve are one number for the whole ledger.
  const agents = new Map();
  if (config.agents !== undefined) {
    if (!isObject(config.agents)) throw new Error(`${where('.agents')} must be an object keyed by agent id.`);
    for (const [key, entry] of Object.entries(config.agents)) {
      if (!isObject(entry)) throw new Error(`${where(`.agents.${key}`)} must be an object like { "daily": 500000 }.`);
      refuseUnknown(entry, PERIODS, `.agents.${key}`);
      const folded = foldAgentId(key);
      const earlier = agents.get(folded);
      // Two spellings of one id are one agent, and only one limit could apply.
      if (earlier) throw new Error(`${where('.agents')} names ${JSON.stringify(earlier.key)} and ${JSON.stringify(key)}, which are the same agent. Keep one.`);
      agents.set(folded, { key, ...readLimits(entry, `.agents.${key}`) });
    }
  }

  /** An agent's own limits: its entry over the default, key by key. `key` is set when it has an entry. */
  const limitsFor = (agentId) => {
    const own = agents.get(foldAgentId(agentId));
    return own ? { ...perAgent, ...own } : { ...perAgent };
  };

  return {
    home,
    weights,
    reservePerCall,
    limitsFor,
    /** Whether any limit covers this agent's calls: the install's, or its own. */
    limited: (agentId) => hasLimit(home) || hasLimit(limitsFor(agentId)),
  };
};

/**
 * One usage record's weight. A bucket the provider didn't report adds
 * nothing: absent means not measured, and counting it would bill for a
 * measurement nobody made.
 */
export const weightedTokens = (usage, weights = {}) => {
  let total = 0;
  for (const bucket of BUCKETS) {
    const count = usage[bucket];
    if (typeof count === 'number') total += count * (weights[bucket] ?? 1);
  }
  return total;
};

/**
 * The window a period covers at `now`, in UTC: a daemon's local zone is the
 * machine's, not the operator's, and a budget that reset at a different
 * instant depending on where it ran would be one nobody could state.
 */
export const budgetWindow = (period, now) => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === 'daily') {
    const day = now.getUTCDate();
    return { start: new Date(Date.UTC(year, month, day)).toISOString(), resetsAt: new Date(Date.UTC(year, month, day + 1)).toISOString() };
  }
  return { start: new Date(Date.UTC(year, month, 1)).toISOString(), resetsAt: new Date(Date.UTC(year, month + 1, 1)).toISOString() };
};

/**
 * The first limit this agent's next call would break, or undefined.
 * `spend(since, agentId?)` is weighted spend since `since`, for one agent or
 * (no agent) the install.
 *
 * Judged as "already at or past it", before the call: a call's cost isn't
 * known until it returns, so a budget refuses the call after the one that
 * reached it. One call's overshoot is the price (for a harness provider, one
 * turn's). The install's limits are checked first, so the message names the
 * wider one when both are spent.
 */
export const findBreach = (budget, agentId, spend, now) => {
  const own = budget.limitsFor(agentId);
  for (const [scope, limits] of [['home', budget.home], ['agent', own]]) {
    for (const period of PERIODS) {
      const limit = limits[period];
      if (limit === undefined) continue;
      const window = budgetWindow(period, now);
      const spent = spend(window.start, scope === 'agent' ? agentId : undefined);
      if (spent >= limit) {
        return { scope, agentId, configKey: scope === 'agent' ? own.key : undefined, period, limit, spent, resetsAt: window.resetsAt };
      }
    }
  }
  return undefined;
};

const count = (value) => Math.round(value).toLocaleString('en-US');
const reset = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const settingFor = (breach) => {
  if (breach.scope === 'home') return where(`.home.${breach.period}`);
  // The agent's own entry if it set this period, else the shared default.
  return breach.configKey !== undefined ? where(`.agents.${breach.configKey}.${breach.period}`) : where(`.${breach.period}`);
};

/**
 * Thrown before a provider call when a limit is spent. A `HostRefusalError`,
 * so the turn fails as refused, no fallback model answers instead, and Slack
 * posts the message as written: for whoever is in the conversation, who may
 * not be the operator.
 */
export class BudgetExceededError extends HostRefusalError {
  constructor(breach) {
    const whose = breach.scope === 'home' ? 'This Stratus install has' : `Agent ${breach.agentId} has`;
    super(
      `${whose} used its ${breach.period} model budget (${count(breach.spent)} of ${count(breach.limit)} weighted tokens), `
        + `so its model is not being called again until the budget resets at ${reset(breach.resetsAt)}. `
        + `To continue sooner, the operator can raise ${settingFor(breach)} in the trusted config.`,
    );
    this.name = 'BudgetExceededError';
    this.breach = breach;
  }
}
