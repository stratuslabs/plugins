/**
 * The nightly tidy window, on the wall clock of a named time zone. A Fly
 * machine's clock is UTC, so the zone is configuration rather than the
 * host's. A night is named by the date its window opened on, so a window
 * across midnight is one night.
 */

const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** `"HH:MM-HH:MM"` as minutes after midnight, or undefined when it is not one. */
export const parseWindow = (text) => {
  const match = typeof text === 'string' ? WINDOW.exec(text) : null;
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return start === end ? undefined : { start, end, text };
};

/** Whether `timeZone` is one this Node's Intl knows. */
export const isTimeZone = (timeZone) => {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

const formats = new Map();

const wallClock = (timeZone, date) => {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
};

const pad = (n) => String(n).padStart(2, '0');

const dateName = (year, month, day) => {
  // Through UTC so day 0 and day 32 roll into the next month or the last.
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

/** The night `date` falls in, as `YYYY-MM-DD`, or undefined outside the window. */
export const nightIn = (window, timeZone, date) => {
  const { year, month, day, minutes } = wallClock(timeZone, date);
  if (window.start < window.end) {
    return minutes >= window.start && minutes < window.end ? dateName(year, month, day) : undefined;
  }
  if (minutes >= window.start) {
    return dateName(year, month, day);
  }
  if (minutes < window.end) {
    return dateName(year, month, day - 1);
  }
  return undefined;
};
