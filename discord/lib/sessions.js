/**
 * Where a Discord message's conversation lives, and its session id.
 *
 * - A DM is one conversation per DM channel (one per user).
 * - A message in a thread belongs to that thread; the conversation is the
 *   parent channel.
 * - A top-level message in a guild channel starts a thread on itself and is
 *   answered there. Discord gives a thread started from a message that
 *   message's id, so the thread's later messages map to the same session.
 *
 * The id has the same shape as `channelSessionKey` in @stratusagent/channels
 * (`channel:agent:team:conversation[:thread]`), so Slack and Discord sessions
 * for one agent never collide.
 */
export const DM_TEAM = '@dm';

export const routeFor = (message) => {
  if (message.guildId === undefined) {
    return { team: DM_TEAM, conversation: message.channelId, thread: undefined, startThread: false };
  }
  if (message.parentId !== undefined) {
    return { team: message.guildId, conversation: message.parentId, thread: message.channelId, startThread: false };
  }
  return { team: message.guildId, conversation: message.channelId, thread: message.id, startThread: true };
};

export const sessionIdFor = (agentId, route) =>
  ['discord', agentId, route.team, route.conversation, ...(route.thread ? [route.thread] : [])].join(':');
