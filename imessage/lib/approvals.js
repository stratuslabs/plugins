import { randomInt } from 'node:crypto';

/**
 * Approvals by text. iMessage has no buttons, so a gated call is put to an
 * approver as a message carrying a challenge code, and they answer with
 * the code: `Y K7QM2X`, `N K7QM2X` or `ALWAYS K7QM2X`.
 *
 * The code is there because a sender id can be forged: it has to hold
 * against someone who sends guesses as an approver.
 *
 * - 6 characters from a 31-character alphabet with no lookalikes (no 0/O,
 *   1/I/L), drawn with crypto.randomInt: about 30 bits.
 * - Bound to one request and to the agent's approvers, never reused.
 * - Single use: the first valid answer spends it.
 * - It dies with the request (the gateway's timeout, or the turn ending).
 * - Three wrong answers deny every request the agent has pending, and the
 *   approvers are told someone guessed.
 * - An answer is taken only from an approver, over iMessage. SMS, RCS and
 *   unknown are refused, `ALWAYS` included.
 *
 * Codes are never logged.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const WRONG_ANSWER_LIMIT = 3;
const INPUT_LIMIT = 600;

export const newCode = (random = randomInt) => {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  }
  return code;
};

const WORDS = new Map([
  ['y', 'once'], ['yes', 'once'], ['allow', 'once'], ['once', 'once'],
  ['n', 'deny'], ['no', 'deny'], ['deny', 'deny'],
  ['always', 'always'],
]);

/**
 * What a text says as an approval answer: `{ answer, code }` with a code,
 * `{ answer }` for a bare yes or no, undefined for anything else. Only a
 * message that is nothing but the answer counts, so "no worries, thanks"
 * stays a message to the agent.
 */
export const parseAnswer = (text) => {
  const match = /^\s*([a-z]+)(?:\s+([a-z0-9]{6}))?[\s.!]*$/i.exec(String(text ?? ''));
  if (!match) {
    return undefined;
  }
  const answer = WORDS.get(match[1].toLowerCase());
  if (!answer) {
    return undefined;
  }
  return match[2] ? { answer, code: match[2].toUpperCase() } : { answer };
};

const alwaysOffer = (always) => {
  switch (always) {
    case 'tool':
      return 'ALWAYS grants this tool until an operator revokes it.';
    case 'destination':
      return 'ALWAYS lets it use this tool on this conversation without asking, until revoked.';
    case 'session':
      return 'ALWAYS stops this tool asking again for the rest of this session.';
    case 'scope':
      return "ALWAYS remembers this command's scope, until revoked.";
    case 'origin':
      return 'ALWAYS remembers this site, until revoked.';
    default:
      return undefined;
  }
};

/** The prompt an approver reads: who wants to run what, with what, and how to answer. */
export const promptText = ({ agentName, toolName, risk, input, origin, oneShot, always, code, about }) => {
  const lines = [`${agentName} wants to run ${toolName} (${risk})${origin ? ` on ${origin}` : ''}${about ? `, in a conversation with ${about}` : ''}.`];
  if (input && typeof input === 'object' && Object.keys(input).length > 0) {
    const rendered = JSON.stringify(input);
    lines.push(rendered.length > INPUT_LIMIT ? `${rendered.slice(0, INPUT_LIMIT)}… (cut short)` : rendered);
  }
  const offer = oneShot ? undefined : alwaysOffer(always);
  lines.push(offer
    ? `Reply Y ${code} to allow once, ALWAYS ${code} to always allow, or N ${code} to deny. ${offer}`
    : `Reply Y ${code} to allow or N ${code} to deny.`);
  return lines.join('\n');
};

const OUTCOME_TEXT = {
  'decided:once': 'allowed once',
  'decided:deny': 'denied',
  'timeout:deny': 'expired without an answer, denied',
  'cancelled:deny': 'cancelled before anyone answered, denied',
  'undeliverable:deny': 'denied',
};

/** What an approver is told once a request they were asked is settled, however it settled. */
export const outcomeText = (asked, event) => {
  const outcome = event.reason === 'decided' && event.answer === 'always'
    ? asked.oneShot ? 'allowed once (nothing about this call could be remembered)' : 'allowed, and remembered'
    : OUTCOME_TEXT[`${event.reason}:${event.answer}`] ?? 'settled';
  return `${asked.agentName}: ${asked.toolName} ${outcome}.`;
};
