/**
 * Splits a reply into messages Discord accepts (2000 characters each). Cuts
 * at line breaks where it can and only mid-line for a line that is longer
 * than a message. A cut inside a ``` block closes the fence at the end of
 * one piece and reopens it, with its language, at the start of the next, so
 * every piece renders on its own.
 */
export const DISCORD_LIMIT = 2000;

const FENCE = /^\s*```(\S*)/;
// The most a piece spends on fences: a reopened ``` with a 32-character
// language, its newline, and the closing newline and ```.
const LONGEST_FENCES = 3 + 32 + 1 + 4;

export const chunk = (text, limit = DISCORD_LIMIT) => {
  if (text.length <= limit) {
    return [text];
  }
  const pieces = [];
  let current = [];
  let size = 0;
  let open; // the language of the fence open at the end of `current`, or undefined
  let openedWith; // the fence line the current piece reopened with

  const closing = () => (open !== undefined ? '\n```' : '');
  // A language tag too long to repeat on every piece reopens as a bare
  // fence, so a reopened piece always has room for text.
  const reopening = () => (open.length <= 32 ? '```' + open : '```');
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    // Blank lines alone are not a message Discord will post.
    const body = current.join('\n');
    if (body.trim().length > 0) {
      pieces.push(body + closing());
    }
    current = open !== undefined ? [openedWith = reopening()] : [];
    size = current.length > 0 ? current[0].length : 0;
  };
  // Nothing in the piece yet but the fence it reopened with, if any.
  const fresh = () => current.length === 0 || (current.length === 1 && current[0] === openedWith && open !== undefined);

  // A line goes in whole where it fits, else starts a new piece; a line
  // longer than a piece is cut to what the piece has room for, counted
  // with the fence that piece opens with and the one it closes with.
  for (const whole of text.split('\n')) {
    let line = whole;
    let first = true;
    // A fence line changes what the piece it lands in must close with.
    const fence = FENCE.exec(whole);
    const after = fence ? (open === undefined ? fence[1] : undefined) : open;
    for (;;) {
      const closes = (first ? after : open) !== undefined ? '\n```'.length : 0;
      const free = limit - size - (current.length > 0 ? 1 : 0) - closes;
      // A line no piece holds whole is cut anyway, so it fills this one first.
      const cut = fresh() || (line.length > limit - LONGEST_FENCES && free > 0);
      const part = line.length <= free ? line : cut ? line.slice(0, free) : undefined;
      if (part === undefined) {
        flush();
        continue;
      }
      size += (current.length > 0 ? 1 : 0) + part.length;
      current.push(part);
      line = line.slice(part.length);
      if (first) {
        first = false;
        open = after;
      }
      if (line.length === 0) {
        break;
      }
      flush();
    }
  }
  if (!fresh() && current.join('\n').trim().length > 0) {
    pieces.push(current.join('\n') + closing());
  }
  return pieces;
};
