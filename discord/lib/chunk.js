/**
 * Splits a reply into messages Discord accepts (2000 characters each). Cuts
 * at line breaks where it can and only mid-line for a line that is longer
 * than a message. A cut inside a ``` block closes the fence at the end of
 * one piece and reopens it, with its language, at the start of the next, so
 * every piece renders on its own.
 */
export const DISCORD_LIMIT = 2000;

const FENCE = /^\s*```(\S*)/;

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
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    pieces.push(current.join('\n') + closing());
    current = open !== undefined ? [openedWith = '```' + open] : [];
    size = current.length > 0 ? current[0].length : 0;
  };

  // Long lines are cut first, keeping room for a fence on either side.
  const room = limit - 8;
  const lines = text.split('\n').flatMap((line) => {
    if (line.length <= room) {
      return [line];
    }
    const parts = [];
    for (let at = 0; at < line.length; at += room) {
      parts.push(line.slice(at, at + room));
    }
    return parts;
  });

  for (const line of lines) {
    const added = (current.length > 0 ? 1 : 0) + line.length;
    if (size + added + closing().length > limit) {
      flush();
    }
    size += (current.length > 0 ? 1 : 0) + line.length;
    current.push(line);
    const fence = FENCE.exec(line);
    if (fence) {
      open = open === undefined ? fence[1] : undefined;
    }
  }
  if (current.length > 0 && !(current.length === 1 && current[0] === openedWith && open !== undefined)) {
    pieces.push(current.join('\n') + closing());
  }
  return pieces;
};
