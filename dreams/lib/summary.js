import { readFileSync } from 'node:fs';

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

export const summarizeFile = (file, offset) => {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { attempts: 0, kept: 0, notKept: 0, failed: 0, keptChanges: [], notes: ['No experiments.jsonl: nothing was recorded.'] };
    }
    throw error;
  }
  return summarizeLog(buffer, offset);
};
