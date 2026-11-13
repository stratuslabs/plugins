import { normalizeHandle } from './handles.js';

/**
 * Whether an agent takes a received message, decided before anything else
 * sees it, and how far its sender is trusted.
 *
 * A sender counts as a principal only when two things hold: their handle is
 * in `principals`, and Messages says iMessage carried the message. An SMS
 * sender id can be forged, so SMS, RCS and an unknown service never count,
 * whatever number they show. Under `admit: 'principals'` (the default)
 * anyone else is refused before a turn starts; under `'anyone'` they get a
 * turn labelled `unknown`.
 *
 * Group chats are refused for now. The result names why, for the log; it
 * never carries the text.
 */
export const admit = (message, agent) => {
  const from = normalizeHandle(message.from);
  if (from === null) {
    return { admit: false, reason: 'sender is not an email or E.164 number' };
  }
  if (message.chat?.group) {
    return { admit: false, reason: 'group chat' };
  }
  const listed = agent.principals.has(from);
  const principal = listed && message.service === 'iMessage';
  if (!principal && agent.admit === 'principals') {
    return { admit: false, reason: listed ? `principal over ${message.service}, not iMessage` : 'not a principal' };
  }
  return { admit: true, from, principal, senderTrust: principal ? 'user' : 'unknown' };
};

/**
 * The session for a direct conversation: `imessage:agent:handle:person`,
 * the shape of `channelSessionKey` in @stratusagent/channels. The agent's
 * own handle is the team, so a new Apple ID starts new sessions; the
 * person's normalized handle is the conversation, one ongoing session per
 * person, the way a Slack DM is.
 */
export const sessionIdFor = (agentId, agentHandle, from) => ['imessage', agentId, agentHandle, from].join(':');

/** The dispatch key for a row: unique per account, stable across restarts. */
export const idempotencyKeyFor = (agentHandle, guid) => `imessage:${agentHandle}:${guid}`;
