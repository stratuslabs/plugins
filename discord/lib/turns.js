/**
 * Reading a turn's outcome from the session `dispatch` resolves with. The
 * same rules as `latestTurnReply`, `turnReplyFor`, `turnFailureFor`,
 * `latestTurnReaction` and `turnReactionFor` in
 * @stratusagent/core, kept here because a plugin depends on the host's
 * contract, not on core's code. If core changes what counts as a turn's
 * reply, these follow.
 */

const carriesKey = (message, key) =>
  message.role === 'user' && (message.idempotencyKey === key || (message.absorbedKeys ?? []).includes(key));

/** The newest turn's reply: the last assistant text after the last user message. */
export const latestTurnReply = (session) => {
  const messages = session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return undefined;
    }
    if (message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return undefined;
};

/** The reply of the turn the keyed message started, which may not be the newest. */
export const turnReplyFor = (session, key) => {
  const messages = session?.messages ?? [];
  const start = messages.findLastIndex((message) => carriesKey(message, key));
  if (start < 0) {
    return undefined;
  }
  const next = messages.findIndex((message, index) => index > start && message.role === 'user');
  return latestTurnReply({ messages: messages.slice(0, next < 0 ? undefined : next) });
};

/**
 * The failure of the turn the keyed message started, when it failed. A
 * repeated dispatch of a failed turn resolves (with the failed session)
 * rather than rejecting, so this is how its failure is found.
 */
export const turnFailureFor = (session, key) => {
  const messages = session?.messages ?? [];
  const keyed = messages.findLast((message) => carriesKey(message, key));
  if (keyed === undefined) {
    return undefined;
  }
  if (keyed.turnError !== undefined) {
    return keyed.turnError;
  }
  if (session.status !== 'failed' || messages.some((message) => message.role === 'user' && message.turnError !== undefined)) {
    return undefined;
  }
  const latest = messages.findLast((message) => message.role === 'user' && message.observed !== true);
  return latest !== undefined && carriesKey(latest, key) ? session.lastError ?? 'The turn failed.' : undefined;
};

/**
 * The reaction the newest turn named instead of a reply (`Message.reaction`,
 * Stratus 0.14.10 and later), read off its last reply and never past the
 * newest user message: an earlier turn's is not this one's.
 */
export const latestTurnReaction = (session) => {
  const messages = session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return undefined;
    }
    if (message?.role === 'assistant') {
      return message.reaction;
    }
  }
  return undefined;
};

/**
 * The reaction of the turn the keyed message started, for a repeat of a
 * finished turn. Its turn runs to the next message that starts one: a
 * message steered into a running turn doesn't.
 */
export const turnReactionFor = (session, key) => {
  const messages = session?.messages ?? [];
  const start = messages.findLastIndex((message) => carriesKey(message, key));
  if (start < 0) {
    return undefined;
  }
  const next = messages.findIndex((message, index) => index > start && message.role === 'user' && message.steered !== true);
  return latestTurnReaction({ messages: messages.slice(0, next < 0 ? undefined : next) });
};
