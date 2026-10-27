/**
 * A Discord MESSAGE_CREATE payload in the adapter's own form (the one
 * `admit` and `routeFor` read). `threads` maps a thread's channel id to its
 * parent channel, filled from the gateway's thread events, since a message
 * in a thread doesn't say which channel the thread is in.
 */
export const normalizeMessage = (data, threads) => {
  const parentId = threads.get(data.channel_id);
  const reference = data.referenced_message;
  return {
    id: data.id,
    ...(data.guild_id ? { guildId: data.guild_id } : {}),
    channelId: data.channel_id,
    ...(parentId ? { parentId } : {}),
    authorId: data.author?.id,
    authorIsBot: data.author?.bot === true,
    mentions: (data.mentions ?? []).map((user) => user.id),
    mentionsRoleOrEveryone: data.mention_everyone === true || (data.mention_roles ?? []).length > 0,
    ...(reference?.author?.id ? { replyToAuthorId: reference.author.id } : {}),
    content: typeof data.content === 'string' ? data.content : '',
  };
};

/** Discord's thread channel types: announcement, public and private threads. */
const THREAD_TYPES = new Set([10, 11, 12]);

/**
 * Keep `threads` current from a dispatch. Returns true when the event was
 * one it reads.
 */
export const trackThreads = (threads, payload) => {
  const { t, d } = payload;
  const remember = (channel) => {
    if (channel && THREAD_TYPES.has(channel.type) && channel.parent_id) {
      threads.set(channel.id, channel.parent_id);
    }
  };
  switch (t) {
    case 'GUILD_CREATE':
      for (const thread of d.threads ?? []) remember(thread);
      return true;
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      remember(d);
      return true;
    case 'THREAD_LIST_SYNC':
      for (const thread of d.threads ?? []) remember(thread);
      return true;
    case 'THREAD_DELETE':
      threads.delete(d.id);
      return true;
    default:
      return false;
  }
};
