import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Sending through Messages.app with `osascript`.
 *
 * The script is a file; the handle and the text are its arguments. osascript
 * hands everything after the script path to `on run argv` as-is (a text
 * starting with `-e` included), so a message can never become script.
 */

export const SEND_SCRIPT = fileURLToPath(new URL('./send.applescript', import.meta.url));
const OSASCRIPT = '/usr/bin/osascript';
const TIMEOUT_MS = 30_000;

const run = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stderr = String(stderr ?? '');
      reject(error);
      return;
    }
    resolve(String(stdout ?? ''));
  });
});

/** A sentence for an osascript failure: what went wrong and, where known, the fix. */
export const sendFailure = (error) => {
  const detail = `${error?.stderr ?? ''} ${error?.message ?? ''}`;
  if (/-1743/.test(detail)) {
    return `macOS has not allowed ${process.execPath} to control Messages. Grant it in System Settings > Privacy & Security > Automation, then restart the daemon.`;
  }
  if (/-1728|Can.t get participant|Can.t get account/i.test(detail)) {
    return 'Messages has no iMessage account signed in on this Mac user, or cannot reach that handle over iMessage.';
  }
  if (error?.killed || error?.signal === 'SIGTERM') {
    return `Messages did not answer within ${TIMEOUT_MS / 1000}s.`;
  }
  const first = String(error?.stderr || error?.message || error).trim().split('\n')[0];
  return `Messages refused the send: ${first.slice(0, 200)}`;
};

export const createSender = ({ exec = run, script = SEND_SCRIPT, timeoutMs = TIMEOUT_MS } = {}) => ({
  /** Sends `text` to `handle`; rejects with a sentence fit for a log. */
  sendText: async (handle, text) => {
    try {
      await exec(OSASCRIPT, [script, handle, text], { timeout: timeoutMs });
    } catch (error) {
      throw new Error(sendFailure(error));
    }
  },
});
