/**
 * The plugin's config, checked once at load. Everything that grants access
 * is a list of Discord ids (snowflakes), never names: a name can be taken by
 * someone else, an id can't.
 *
 * The host's plugin-block shape: settings at the top are every agent's
 * defaults, and `agents.<id>` says what differs for one agent. A key in an
 * agent's entry replaces the default whole (lists aren't merged), so an
 * agent's `allowFrom` never quietly includes someone the defaults named.
 *
 * {
 *   allowFrom: [userId],        // who may DM the agent
 *   approvers: [userId],        // who may press approval buttons
 *   principals?: [userId],      // trusted senders; defaults to allowFrom + approvers
 *   guilds?: { <guildId>: { requireMention?: true, channels?: { <channelId>: { requireMention? } } } },
 *   allowBots?: [userId],       // other bots it answers; none by default
 *   agents?: { <agentId>: { ...any of the above } }
 * }
 *
 * The agents it covers are those under `agents` plus `withTokens`, the
 * agents with a stored bot token: storing one is how an agent is put on
 * Discord, and the defaults then say whom it answers.
 *
 * A guild with no `channels` lets the agent work in every channel of it the
 * bot can see. A guild with `channels` is an allowlist of them.
 */

const SNOWFLAKE = /^[0-9]{17,20}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

const ids = (value, where) => {
  if (value === undefined) {
    return new Set();
  }
  if (!Array.isArray(value)) {
    throw new Error(`plugin-discord: ${where} must be a list of Discord ids.`);
  }
  for (const id of value) {
    if (typeof id !== 'string' || !SNOWFLAKE.test(id)) {
      throw new Error(`plugin-discord: ${where} has ${JSON.stringify(id)}, which is not a Discord id (a snowflake, 17-20 digits). Names aren't accepted: copy the id with Developer Mode on.`);
    }
  }
  return new Set(value);
};

const mention = (value, fallback, where) => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`plugin-discord: ${where}.requireMention must be true or false.`);
  }
  return value;
};

const guildsOf = (value, agentId) => {
  const guilds = new Map();
  for (const [guildId, guild] of Object.entries(value ?? {})) {
    const where = `agents.${agentId}.guilds`;
    if (!SNOWFLAKE.test(guildId)) {
      throw new Error(`plugin-discord: ${where} has ${JSON.stringify(guildId)}, which is not a guild snowflake.`);
    }
    const requireMention = mention(guild?.requireMention, true, `${where}.${guildId}`);
    let channels;
    if (guild?.channels !== undefined) {
      channels = new Map();
      for (const [channelId, channel] of Object.entries(guild.channels)) {
        if (!SNOWFLAKE.test(channelId)) {
          throw new Error(`plugin-discord: ${where}.${guildId}.channels has ${JSON.stringify(channelId)}, which is not a channel snowflake.`);
        }
        channels.set(channelId, { requireMention: mention(channel?.requireMention, requireMention, `${where}.${guildId}.channels.${channelId}`) });
      }
    }
    guilds.set(guildId, { requireMention, channels });
  }
  return guilds;
};

export const parseDiscordConfig = (config = {}, { withTokens = [] } = {}) => {
  const { agents: overrides = {}, ...defaults } = config;
  const agents = new Map();
  const agentIds = new Set([...Object.keys(overrides), ...withTokens]);
  for (const agentId of agentIds) {
    const agent = { ...defaults, ...(overrides[agentId] ?? {}) };
    if (!AGENT_ID.test(agentId)) {
      throw new Error(`plugin-discord: ${JSON.stringify(agentId)} is not an agent id.`);
    }
    const allowFrom = ids(agent?.allowFrom, `agents.${agentId}.allowFrom`);
    const approvers = ids(agent?.approvers, `agents.${agentId}.approvers`);
    if (approvers.size === 0) {
      throw new Error(`plugin-discord: ${agentId} has no approvers, so nobody could answer its approvals in Discord. List at least one user id in approvers, at the top of the plugin block or under agents.${agentId}.`);
    }
    const principals = agent?.principals === undefined
      ? new Set([...allowFrom, ...approvers])
      : ids(agent.principals, `agents.${agentId}.principals`);
    agents.set(agentId, {
      allowFrom,
      approvers,
      principals,
      guilds: guildsOf(agent?.guilds, agentId),
      allowBots: ids(agent?.allowBots, `agents.${agentId}.allowBots`),
    });
  }
  return { agents };
};
