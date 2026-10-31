/**
 * Whether a message asks the agent to stop: the word "stop" and nothing
 * else but mentions of this bot and closing punctuation, in any case. A
 * message that mentions anyone else (a user or a role) is for them. Who
 * may stop is the caller's check: an approver, since a stop throws away
 * work someone asked for.
 */
export const isStopRequest = (content, botId) => {
  const mentioned = [...content.matchAll(/<@[!&]?(\d+)>/g)].map((match) => (match[0].startsWith('<@&') ? 'role' : match[1]));
  if (mentioned.some((id) => id !== botId)) {
    return false;
  }
  const words = content.replace(/<@[!&]?\d+>/g, ' ').trim().replace(/[.!]+$/, '').trim();
  return words.toLowerCase() === 'stop';
};
