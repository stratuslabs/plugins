import { normalizeHandle } from './handles.js';

/**
 * Whether an agent takes a received message, decided before anything else
 * sees it, and how far its sender is trusted.
 *
 * A sender counts as a principal only when two things hold: their handle is
 * in `principals`, and Photon says iMessage carried the message. An SMS
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
  if (message.group) {
    return { admit: false, reason: 'group chat' };
  }
  const listed = agent.principals.has(from);
  const principal = listed && message.service === 'iMessage';
  if (!principal && agent.admit === 'principals') {
    return { admit: false, reason: listed ? `principal over ${message.service}, not iMessage` : 'not a principal' };
  }
  return { admit: true, from, principal, senderTrust: principal ? 'user' : 'unknown' };
};

/** Photon's direct-chat guid shape, `any;-;<handle>`; a group's is `any;+;<id>`. */
export const isGroupChat = (chatGuid) => typeof chatGuid === 'string' && chatGuid.includes(';+;');

/**
 * The session for a direct conversation: `imessage-photon:agent:person`,
 * one ongoing session per person, the way a Slack DM is. The line is left
 * out: on a shared pool the number a person texts can change, and they
 * are still talking to the same agent.
 */
export const sessionIdFor = (agentId, from) => ['imessage-photon', agentId, from].join(':');

/** The dispatch key for a message: Photon's guid, stable across restarts and catch-up. */
export const idempotencyKeyFor = (agentId, guid) => `imessage-photon:${agentId}:${guid}`;
