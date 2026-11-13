/**
 * Turning an agent's markdown into text messages. iMessage shows no
 * markdown, so emphasis markers are dropped, a link keeps its URL beside
 * its words, headings become plain lines, and a fenced code block is
 * indented instead of fenced.
 */

const FENCE = /^\s*(```|~~~)/;

const inline = (line) => line
  // [words](url) -> words (url); a bare autolink keeps its URL.
  .replace(/!?\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_m, words, url) => (words && words !== url ? `${words} (${url})` : url))
  .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
  // Bold and italics, either marker; never inside a word for _.
  .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
  .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
  .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
  .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
  .replace(/`([^`\n]+)`/g, '$1');

export const toPlainText = (markdown) => {
  const out = [];
  let inCode = false;
  for (const line of String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line.length > 0 ? `    ${line}` : '');
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(inline(heading[1]));
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('');
      continue;
    }
    out.push(inline(line.replace(/^(\s*)[*+]\s+/, '$1- ')));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

/** Longest single message; a longer reply goes as several, split at paragraphs, then lines, then words. */
export const MESSAGE_LIMIT = 4000;

export const splitMessages = (text, limit = MESSAGE_LIMIT) => {
  const pieces = [];
  let rest = String(text ?? '').trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit / 2) {
      cut = window.lastIndexOf('\n');
    }
    if (cut < limit / 2) {
      cut = window.lastIndexOf(' ');
    }
    if (cut < limit / 2) {
      cut = limit;
      // Never split a surrogate pair.
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        cut -= 1;
      }
    }
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces;
};
