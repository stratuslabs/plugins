/**
 * Approval prompts in Discord: a gated call parked on a human is posted in
 * the conversation it came from, with buttons only the agent's approvers
 * can use. The wording and the rules follow the Slack channel's, so an
 * approver reads the same question on either.
 */

/** The prefix on every button's custom_id; the request id rides after the answer. */
const CUSTOM_ID = 'stratus:approval';
const ANSWERS = new Set(['once', 'always', 'deny']);
/** How much of the call's input is shown, and the one-line form's length. */
export const APPROVAL_INPUT_LIMIT = 1400;

/** Button styles: primary, secondary, danger. */
const PRIMARY = 1;
const SECONDARY = 2;
const DANGER = 4;

/** Ephemeral: only the person who clicked sees the answer. */
export const EPHEMERAL = 1 << 6;

export const customIdFor = (answer, requestId) => `${CUSTOM_ID}:${answer}:${requestId}`;

/** `{ answer, requestId }` from a button's custom_id, or undefined if it isn't one of ours. */
export const parseCustomId = (customId) => {
  if (typeof customId !== 'string' || !customId.startsWith(`${CUSTOM_ID}:`)) {
    return undefined;
  }
  const rest = customId.slice(CUSTOM_ID.length + 1);
  const at = rest.indexOf(':');
  const answer = rest.slice(0, at);
  const requestId = rest.slice(at + 1);
  return at > 0 && ANSWERS.has(answer) && requestId.length > 0 ? { answer, requestId } : undefined;
};

/** Text a model wrote, made safe to sit inside a ``` block: it can't close the fence. */
const fenced = (text) => text.replaceAll('```', '`​``');

/** Inline code for a name: backticks in it can't end the span. */
const code = (text) => `\`${String(text).replaceAll('`', 'ˋ')}\``;

const alwaysOffer = (always, agentName) => {
  switch (always) {
    case 'tool':
      return `**Always allow** grants this tool to ${agentName} until an operator revokes it.`;
    case 'destination':
      return `**Always allow** lets ${agentName} use this tool on this conversation without asking, until revoked.`;
    case 'session':
      return '**Always allow** stops this tool asking again for the rest of this session.';
    case 'scope':
      return "**Always allow** remembers this command's scope for this agent, until revoked.";
    case 'origin':
      return '**Always allow** remembers this site for this agent, until revoked.';
    default:
      return undefined;
  }
};

/** The prompt: who wants to run what, with what, and what each button does. */
export const approvalMessage = ({ agentName, toolName, risk, input, origin, oneShot, always, requestId }) => {
  const lines = [`**${agentName}** wants to run ${code(toolName)} (${risk})${origin ? ` on ${code(origin)}` : ''}.`];
  const keys = input && typeof input === 'object' ? Object.keys(input) : [];
  if (keys.length > 0) {
    const rendered = JSON.stringify(input, null, 2);
    const truncated = rendered.length > APPROVAL_INPUT_LIMIT;
    lines.push('```json', fenced(truncated ? rendered.slice(0, APPROVAL_INPUT_LIMIT) : rendered), '```');
    if (truncated) {
      lines.push('-# ⚠ Arguments shown are truncated: the full call is longer than this.');
    }
  }
  const offer = oneShot ? undefined : alwaysOffer(always, agentName);
  if (oneShot) {
    lines.push('-# 🔒 An approval covers this call only. Nothing about it is remembered.');
  } else if (offer) {
    lines.push(`-# ${offer}`);
  }
  const buttons = [
    { type: 2, style: oneShot ? PRIMARY : SECONDARY, label: 'Allow once', custom_id: customIdFor('once', requestId) },
    ...(oneShot ? [] : [{ type: 2, style: PRIMARY, label: 'Always allow', custom_id: customIdFor('always', requestId) }]),
    { type: 2, style: DANGER, label: 'Deny', custom_id: customIdFor('deny', requestId) },
  ];
  return { content: lines.join('\n'), components: [{ type: 1, components: buttons }] };
};

const OUTCOME_TEXT = {
  'decided:once': 'Allowed once',
  'decided:deny': 'Denied',
  'timeout:deny': 'Expired without an answer, denied',
  'cancelled:deny': 'Cancelled before anyone answered, denied',
  'undeliverable:deny': 'Could not be put to an approver, denied',
};

const alwaysOutcome = (always, agentName, agentId) => {
  switch (always) {
    case 'scope':
      return "Allowed, and this command's scope now runs without asking, until revoked";
    case 'origin':
      return 'Allowed, and this site is now acted on without asking, until revoked';
    case 'tool':
      return `Allowed, and granted to ${agentName} until revoked (stratus grants ${agentId})`;
    case 'destination':
      return `Allowed, and granted to ${agentName} for this conversation until revoked (stratus grants ${agentId})`;
    case 'session':
      return 'Allowed for the rest of this session';
    default:
      return 'Allowed and remembered, for this session at least';
  }
};

/** What the prompt says once it is settled, however it settled. */
export const outcomeMessage = (post, event) => {
  const outcome = post.oneShot && event.reason === 'decided' && event.answer === 'always'
    ? post.risk === 'dangerous'
      ? 'Allowed once (a dangerous tool is never remembered)'
      : 'Allowed once (nothing about this call could be remembered)'
    : event.reason === 'decided' && event.answer === 'always'
      ? alwaysOutcome(post.always, post.agentName, post.agentId)
      : OUTCOME_TEXT[`${event.reason}:${event.answer}`] ?? 'Resolved';
  // A mention only for one of its approvers, the only people a click can
  // come from; an api: or dashboard actor is named as text. Nobody is
  // pinged either way: every post sets allowed_mentions to nothing.
  const by = event.actor ? ` by ${post.approvers.has(event.actor) ? `<@${event.actor}>` : code(event.actor)}` : '';
  return `**${post.agentName}**: ${code(post.toolName)} (${post.risk}): ${outcome}${by}.`;
};
