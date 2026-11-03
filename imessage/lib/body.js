import { Unarchiver } from '@parseaple/typedstream';

/**
 * The text of one chat.db message row.
 *
 * Messages fills `text` on some rows and leaves it NULL on others, keeping
 * the body only in `attributedBody`: an NSArchiver typedstream of an
 * NSMutableAttributedString. `text` wins when it is there. U+FFFC is the
 * placeholder Messages puts where an attachment sits in the text; it is
 * dropped, since the attachment arrives separately.
 *
 * Throws when `attributedBody` is present but cannot be decoded. That is a
 * fact about the row, not the moment, so the caller treats it as poison.
 */
export const messageText = ({ text, attributedBody }) => {
  if (typeof text === 'string' && text.length > 0) {
    return clean(text);
  }
  if (attributedBody === null || attributedBody === undefined || attributedBody.length === 0) {
    return '';
  }
  let root;
  try {
    root = Unarchiver.open(Buffer.from(attributedBody)).decodeSingleRoot();
  } catch (error) {
    throw new Error(`attributedBody could not be decoded (${error?.message ?? error})`);
  }
  const decoded = root?.string;
  const value = typeof decoded === 'string' ? decoded : decoded?.value;
  if (typeof value !== 'string') {
    throw new Error(`attributedBody decoded to ${root?.constructor?.name ?? typeof root}, not an attributed string`);
  }
  return clean(value);
};

const clean = (value) => value.replaceAll('￼', '');
