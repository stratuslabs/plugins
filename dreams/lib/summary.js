import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * A morning summary of one experiment's night, from the lines the
 * experimenter appended to experiments.jsonl after the claimed offset.
 * Descriptions are model-written, so the tool that returns them labels its
 * output external; they are capped rather than copied whole.
 */

const DESCRIPTION_LIMIT = 200;
const KEPT_LIMIT = 5;

const records = (text) => text
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return record && typeof record === 'object' ? [record] : [];
    } catch {
      return [];
    }
  });

const score = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const clip = (value) => {
  const text = typeof value === 'string' ? value : '';
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}…` : text;
};

export const summarizeLog = (buffer, offset) => {
  const notes = [];
  let from = offset;
  if (offset > buffer.length) {
    // Someone shortened the log during the night. Read what is there.
    notes.push('experiments.jsonl is shorter than when the night began, so the summary reads the whole file.');
    from = 0;
  }
  const before = records(buffer.subarray(0, from).toString('utf8'));
  const tonight = records(buffer.subarray(from).toString('utf8'));
  const baseline = tonight.find((record) => record.experiment_id === 0 && record.description === 'baseline');
  const attempts = tonight.filter((record) => record !== baseline);
  const priorBest = [...before].reverse().map((record) => score(record.best_score)).find((value) => value !== undefined);
  const startBest = priorBest ?? score(baseline?.score);
  const endBest = [...tonight].reverse().map((record) => score(record.best_score)).find((value) => value !== undefined) ?? startBest;
  const kept = attempts.filter((record) => record.improved === true);
  const failed = attempts.filter((record) => score(record.score) === undefined);
  return {
    attempts: attempts.length,
    kept: kept.length,
    notKept: attempts.length - kept.length - failed.length,
    failed: failed.length,
    ...(startBest !== undefined ? { startBest } : {}),
    ...(endBest !== undefined ? { endBest } : {}),
    keptChanges: kept.slice(-KEPT_LIMIT).map((record) => ({
      experiment: record.experiment_id,
      score: score(record.score),
      description: clip(record.description),
    })),
    ...(notes.length > 0 ? { notes } : {}),
  };
};

/** What one summary reads of tonight's lines, and of the lines before them. */
export const READ_LIMIT = 8 * 1024 * 1024;
export const TAIL_LIMIT = 1024 * 1024;

const readRange = (fd, start, end) => {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  let done = 0;
  while (done < buffer.length) {
    const n = readSync(fd, buffer, done, buffer.length - done, start + done);
    if (n === 0) {
      break;
    }
    done += n;
  }
  return buffer.subarray(0, done);
};

// A chunk cut out of the middle of the file: keep whole lines only.
const fromFirstLine = (buffer) => buffer.subarray(buffer.indexOf(0x0a) + 1);
const toLastLine = (buffer) => buffer.subarray(0, buffer.lastIndexOf(0x0a) + 1);

/**
 * The model can write experiments.jsonl, so it can make it any size: the
 * summary reads at most `limit` bytes of tonight's lines and `tail` bytes
 * of the ones before, never the whole file.
 */
export const summarizeFile = (file, offset, { limit = READ_LIMIT, tail = TAIL_LIMIT } = {}) => {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { attempts: 0, kept: 0, notKept: 0, failed: 0, keptChanges: [], notes: ['No experiments.jsonl: nothing was recorded.'] };
    }
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    if (offset > size) {
      // Someone shortened the log during the night: read its end.
      const start = Math.max(0, size - limit);
      const chunk = readRange(fd, start, size);
      const summary = summarizeLog(start > 0 ? fromFirstLine(chunk) : chunk, 0);
      return { ...summary, notes: ['experiments.jsonl is shorter than when the night began, so the summary reads the end of the file.'] };
    }
    const tailStart = Math.max(0, offset - tail);
    const before = readRange(fd, tailStart, offset);
    const end = Math.min(size, offset + limit);
    let tonight = readRange(fd, offset, end);
    const notes = [];
    if (end < size) {
      tonight = toLastLine(tonight);
      notes.push(`experiments.jsonl grew larger than ${limit} bytes tonight, so the summary reads only the start of it.`);
    }
    const head = tailStart > 0 ? fromFirstLine(before) : before;
    const summary = summarizeLog(Buffer.concat([head, tonight]), head.length);
    return notes.length > 0 ? { ...summary, notes: [...(summary.notes ?? []), ...notes] } : summary;
  } finally {
    closeSync(fd);
  }
};
