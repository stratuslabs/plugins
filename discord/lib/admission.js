/**
 * Whether one agent's bot takes a Discord message, decided before anything
 * else sees it. `message` is the adapter's normalized form:
 *
 *   { id, guildId?, channelId, parentId?, authorId, authorIsBot,
 *     mentions: [userId], mentionsRoleOrEveryone, replyToAuthorId?, content }
 *
 * `parentId` is set for a thread: a thread is judged by its parent channel's
 * entry. The result says why a message was refused, for the debug log; it
 * never carries the text.
 */
export const admit = (message, agent, botId) => {
  if (message.authorId === botId) {
    return { admit: false, reason: 'own message' };
  }
  if (message.authorIsBot && !agent.allowBots.has(message.authorId)) {
    return { admit: false, reason: 'bot not allowed' };
  }
  const principal = agent.principals.has(message.authorId);

  if (message.guildId === undefined) {
    // A DM. Only people named for it; a DM is always addressed.
    if (!agent.allowFrom.has(message.authorId) && !agent.allowBots.has(message.authorId)) {
      return { admit: false, reason: 'dm not allowed' };
    }
    return { admit: true, addressed: true, kind: 'direct', principal };
  }

  const guild = agent.guilds.get(message.guildId);
  if (!guild) {
    return { admit: false, reason: 'guild not allowed' };
  }
  const channelId = message.parentId ?? message.channelId;
  let requireMention = guild.requireMention;
  if (guild.channels) {
    const channel = guild.channels.get(channelId);
    if (!channel) {
      return { admit: false, reason: 'channel not allowed' };
    }
    requireMention = channel.requireMention;
  }

  const mentioned = message.mentions.includes(botId) || message.replyToAuthorId === botId;
  if (!mentioned) {
    // Aimed at a person or a role, not at this agent: stay out of it, even
    // where no mention is needed.
    const elsewhere = message.mentions.length > 0 || message.mentionsRoleOrEveryone
      || (message.replyToAuthorId !== undefined && message.replyToAuthorId !== botId);
    if (elsewhere) {
      return { admit: false, reason: 'addressed to someone else' };
    }
    if (requireMention) {
      return { admit: false, reason: 'not addressed' };
    }
  }
  return { admit: true, addressed: mentioned, kind: 'channel', principal };
};
