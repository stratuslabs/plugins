/**
 * The nightly window, in the host's local time. A night is named by the
 * calendar date its window opened on, so a window that crosses midnight is
 * one night, and a night the daemon was down for is simply never named
 * again: a missed night is skipped, never caught up.
 */

const pad = (n) => String(n).padStart(2, '0');

const at = (year, month, day, minutes) => new Date(year, month, day, Math.floor(minutes / 60), minutes % 60, 0, 0);

/**
 * The window `now` falls in, or undefined outside every window. Dates are
 * built from calendar fields, so a window across a DST change follows the
 * wall clock: the 8 hours from 23:00 to 07:00 are 9 on the night clocks go
 * back.
 */
export const nightAt = (window, now) => {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  let openedOn;
  if (window.start < window.end) {
    if (minutes < window.start || minutes >= window.end) {
      return undefined;
    }
    openedOn = [y, m, d];
  } else if (minutes >= window.start) {
    openedOn = [y, m, d];
  } else if (minutes < window.end) {
    const yesterday = new Date(y, m, d - 1, 12);
    openedOn = [yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()];
  } else {
    return undefined;
  }
  const [oy, om, od] = openedOn;
  const start = at(oy, om, od, window.start);
  const end = window.start < window.end ? at(oy, om, od, window.end) : at(oy, om, od + 1, window.end);
  return { night: `${oy}-${pad(om + 1)}-${pad(od)}`, start, end };
};

/** The experimenter can overrun --budget by one agent call (600s) and one evaluation (300s). */
export const OVERRUN_MARGIN_SECONDS = 15 * 60;
/** Below this, an experiment is not worth starting. */
export const MIN_BUDGET_SECONDS = 10 * 60;

/**
 * The budget to pass: the configured one, cut to what is left of the
 * window less the overrun margin. Undefined when that is under the floor,
 * which means: do not start.
 */
export const clampBudget = (budgetSeconds, windowEnd, now, { margin = OVERRUN_MARGIN_SECONDS, floor = MIN_BUDGET_SECONDS } = {}) => {
  const left = Math.floor((windowEnd.getTime() - now.getTime()) / 1000) - margin;
  const budget = Math.min(budgetSeconds, left);
  return budget >= floor ? budget : undefined;
};
