/**
 * iMessage handles: an Apple ID email or a phone number in E.164 form.
 * Both the config and chat.db are compared in one normalized form, so
 * `Ava@iCloud.com` and `ava@icloud.com`, or `+1 (555) 123-4821` and
 * `+15551234821`, are one person.
 */

const E164 = /^\+[1-9][0-9]{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The normalized handle, or null when `raw` is neither an email nor an E.164 number. */
export const normalizeHandle = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (value.includes('@')) {
    const email = value.toLowerCase();
    return EMAIL.test(email) ? email : null;
  }
  const phone = value.replace(/[\s().-]/g, '');
  return E164.test(phone) ? phone : null;
};

/** `+1•••••4821` and `a•••@icloud.com`: enough to tell people apart in a log, not to text them. */
export const maskHandle = (handle) => {
  if (typeof handle !== 'string' || handle.length === 0) {
    return '•••';
  }
  if (handle.includes('@')) {
    const [user, domain] = handle.split('@');
    return `${user.slice(0, 1)}•••@${domain}`;
  }
  return `${handle.slice(0, 2)}•••••${handle.slice(-4)}`;
};
