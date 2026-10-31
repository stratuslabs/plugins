import { normalizeHandle } from './handles.js';

/**
 * The plugin's config, checked once at load, in the host's plugin-block
 * shape: settings at the top are every agent's defaults, and
 * `agents.<id>` says what differs for one agent. A key in an agent's entry
 * replaces the default whole; lists are not merged.
 *
 * {
 *   delivery?: 'local',          // Messages.app on this Mac; the only one built so far
 *   handle: 'ava@icloud.com',    // the Apple ID (email or E.164) the agent sends as
 *   approvers: [handle],         // who may answer its approvals, by text
 *   principals?: [handle],       // trusted senders; defaults to the approvers
 *   admit?: 'principals' | 'anyone',  // default 'principals': anyone can text a number
 *   replayCapHours?: 24,         // messages first read later than this after sending are skipped
 *   agents?: { <agentId>: { ...any of the above } }
 * }
 *
 * The agents carried are those under `agents`: a local delivery has no
 * secret to store, so the trusted config is what binds an agent to it.
 *
 * One macOS login runs one Messages account, so only one agent can use
 * local delivery on it. Two or more and none is carried: both would read
 * the same chat.db and see each other's conversations. The reason names
 * them all, and no agent is picked by load order.
 */

const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const NOT_BUILT = new Set(['photon-local', 'photon', 'sendblue']);

const handles = (value, where) => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`plugin-imessage: ${where} must be a list of Apple IDs (emails) or phone numbers.`);
  }
  const out = new Set();
  for (const raw of value) {
    const handle = normalizeHandle(raw);
    if (handle === null) {
      throw new Error(`plugin-imessage: ${where} has ${JSON.stringify(raw)}, which is not an email or a phone number in E.164 form (like +15551234567).`);
    }
    out.add(handle);
  }
  return out;
};

export const parseImessageConfig = (config = {}, { platform = process.platform } = {}) => {
  const { agents: overrides = {}, ...defaults } = config;
  const agents = new Map();
  const refused = new Map();
  for (const agentId of Object.keys(overrides)) {
    if (!AGENT_ID.test(agentId)) {
      throw new Error(`plugin-imessage: ${JSON.stringify(agentId)} is not an agent id.`);
    }
    const agent = { ...defaults, ...(overrides[agentId] ?? {}) };
    const where = `agents.${agentId}`;
    const delivery = agent.delivery ?? 'local';
    if (NOT_BUILT.has(delivery)) {
      throw new Error(`plugin-imessage: ${where}.delivery is ${JSON.stringify(delivery)}, which this version doesn't have yet. Use "local".`);
    }
    if (delivery !== 'local') {
      throw new Error(`plugin-imessage: ${where}.delivery must be "local".`);
    }
    const handle = normalizeHandle(agent.handle);
    if (handle === null) {
      throw new Error(`plugin-imessage: ${agentId} needs a handle: the Apple ID it sends as, signed in to Messages on this Mac (an email, or a phone number like +15551234567).`);
    }
    const approvers = handles(agent.approvers, `${where}.approvers`) ?? new Set();
    if (approvers.size === 0) {
      throw new Error(`plugin-imessage: ${agentId} has no approvers, so nobody could answer its approvals by text. List at least one Apple ID or phone number in approvers, at the top of the plugin block or under ${where}.`);
    }
    const principals = handles(agent.principals, `${where}.principals`) ?? new Set(approvers);
    const admit = agent.admit ?? 'principals';
    if (admit !== 'principals' && admit !== 'anyone') {
      throw new Error(`plugin-imessage: ${where}.admit must be "principals" or "anyone".`);
    }
    const replayCapHours = agent.replayCapHours ?? 24;
    if (typeof replayCapHours !== 'number' || !Number.isFinite(replayCapHours) || replayCapHours <= 0) {
      throw new Error(`plugin-imessage: ${where}.replayCapHours must be a number of hours above 0.`);
    }
    if (agent.groups !== undefined && agent.groups !== false) {
      throw new Error(`plugin-imessage: ${where}.groups: group chats aren't supported yet; leave it out or set it to false.`);
    }
    agents.set(agentId, { delivery, handle, approvers, principals, admit, replayCapMs: replayCapHours * 3_600_000 });
  }

  const local = [...agents].filter(([, agent]) => agent.delivery === 'local').map(([agentId]) => agentId);
  if (local.length > 0 && platform !== 'darwin') {
    for (const agentId of local) {
      refused.set(agentId, '`local` delivery needs macOS: it reads Messages on this Mac.');
      agents.delete(agentId);
    }
  } else if (local.length > 1) {
    const names = local.join(' and ');
    for (const agentId of local) {
      refused.set(agentId, `${names} all use local delivery on this Mac user; only one agent per macOS login can, since they would read one Messages account. Keep it on one agent.`);
      agents.delete(agentId);
    }
  }
  return { agents, refused };
};
