import { normalizeHandle } from './handles.js';

/**
 * The plugin's config, checked once at load, in the host's plugin-block
 * shape: settings at the top are every agent's defaults, and
 * `agents.<id>` says what differs for one agent. A key in an agent's entry
 * replaces the default whole; lists are not merged.
 *
 * {
 *   approvers: [handle],         // who may answer its approvals, by text
 *   principals?: [handle],       // trusted senders; defaults to the approvers
 *   admit?: 'principals' | 'anyone',  // default 'principals': anyone can text a number
 *   replayCapHours?: 24,         // a message caught up later than this after it was sent is not answered
 *   agents?: { <agentId>: { ...any of the above } }
 * }
 *
 * A handle is an Apple ID email or a phone number in E.164 form.
 *
 * What binds an agent to the channel is its Photon project, stored as the
 * channel's transport secrets (`stratus channel set imessage-photon
 * --agent <id> projectId projectSecret`). An agent with secrets but no
 * approvers is refused, with the reason: nobody could answer its approvals.
 */

const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const KNOWN = new Set(['approvers', 'principals', 'admit', 'replayCapHours']);

const handles = (value, where) => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`plugin-imessage-photon: ${where} must be a list of Apple IDs (emails) or phone numbers.`);
  }
  const out = new Set();
  for (const raw of value) {
    const handle = normalizeHandle(raw);
    if (handle === null) {
      throw new Error(`plugin-imessage-photon: ${where} has ${JSON.stringify(raw)}, which is not an email or a phone number in E.164 form (like +15551234567).`);
    }
    out.add(handle);
  }
  return out;
};

/** One agent's settings, every one checked; `refused` says why the agent can't be carried. */
const settingsFor = (agentId, where, values) => {
  for (const key of Object.keys(values)) {
    if (!KNOWN.has(key)) {
      throw new Error(`plugin-imessage-photon: ${where} has an unknown setting ${JSON.stringify(key)}.`);
    }
  }
  const approvers = handles(values.approvers, `${where}.approvers`) ?? new Set();
  const principals = handles(values.principals, `${where}.principals`) ?? new Set(approvers);
  const admit = values.admit ?? 'principals';
  if (admit !== 'principals' && admit !== 'anyone') {
    throw new Error(`plugin-imessage-photon: ${where}.admit must be "principals" or "anyone".`);
  }
  const replayCapHours = values.replayCapHours ?? 24;
  if (typeof replayCapHours !== 'number' || !Number.isFinite(replayCapHours) || replayCapHours <= 0) {
    throw new Error(`plugin-imessage-photon: ${where}.replayCapHours must be a number of hours above 0.`);
  }
  if (approvers.size === 0) {
    return { refused: `no approvers, so nobody could answer its approvals by text. List at least one Apple ID or phone number in approvers, at the top of the plugin block or under agents.${agentId}` };
  }
  return { agent: { approvers, principals, admit, replayCapMs: replayCapHours * 3_600_000 } };
};

/**
 * `withSecrets` names the agents that have a Photon project stored. The
 * result carries each of them that the config lets onto the channel, the
 * ones refused with why, and the configured agents that have no project
 * stored yet.
 */
export const parsePhotonConfig = (config = {}, { withSecrets = [] } = {}) => {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('plugin-imessage-photon: the plugin config must be an object.');
  }
  const { agents: overrides = {}, ...defaults } = config;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('plugin-imessage-photon: agents must map agent ids to their settings.');
  }
  for (const agentId of Object.keys(overrides)) {
    if (!AGENT_ID.test(agentId)) {
      throw new Error(`plugin-imessage-photon: ${JSON.stringify(agentId)} is not an agent id.`);
    }
    const entry = overrides[agentId] ?? {};
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`plugin-imessage-photon: agents.${agentId} must be an object.`);
    }
  }
  // Every setting is checked, even for an agent with no project yet, so a
  // typo fails the load instead of the day a project is stored.
  settingsFor('', 'the plugin block', defaults);
  const agents = new Map();
  const refused = new Map();
  for (const agentId of new Set([...withSecrets, ...Object.keys(overrides)])) {
    const where = Object.hasOwn(overrides, agentId) ? `agents.${agentId}` : 'the plugin block';
    const result = settingsFor(agentId, where, { ...defaults, ...(overrides[agentId] ?? {}) });
    if (!withSecrets.includes(agentId)) {
      continue;
    }
    if (result.refused) {
      refused.set(agentId, result.refused);
    } else {
      agents.set(agentId, result.agent);
    }
  }
  const unbound = Object.keys(overrides).filter((agentId) => !withSecrets.includes(agentId));
  return { agents, refused, unbound };
};
