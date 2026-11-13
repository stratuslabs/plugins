import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * How far each agent has read each of its Photon lines, kept across
 * restarts so that texts sent while the daemon was down are caught up and
 * none is answered twice.
 *
 * Photon numbers every event on a line (`sequence`, increasing). Per line
 * the record keeps:
 *
 * - `cursor`: every event at or before it that this channel took has been
 *   settled (answered, refused, or not for the agent). Catch-up resumes
 *   after it.
 * - `settled`: events after the cursor that are already settled, because
 *   an earlier one is still open. A catch-up skips them.
 *
 * One file per agent, `<agentId>.json`, written whole to a temporary file
 * that is synced and renamed over the old one, so a crash leaves either
 * the old record or the new one. Owner-only.
 */

const VERSION = 1;

const validLine = (line) => line !== null && typeof line === 'object'
  && Number.isSafeInteger(line.cursor) && line.cursor >= 0
  && Array.isArray(line.settled) && line.settled.every((sequence) => Number.isSafeInteger(sequence) && sequence > line.cursor);

export const createCursorStore = ({ directory }) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fileFor = (agentId) => path.join(directory, `${agentId}.json`);
  return {
    file: fileFor,
    /**
     * The agent's record, or undefined when it has none yet. A file that
     * can't be read or doesn't hold a record throws: reading on from a
     * guess could answer old texts again or skip new ones.
     */
    load(agentId) {
      let text;
      try {
        text = readFileSync(fileFor(agentId), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return undefined;
        }
        throw new Error(`could not read ${fileFor(agentId)}: ${error.message}`);
      }
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        throw new Error(`${fileFor(agentId)} is not valid JSON`);
      }
      if (record?.version !== VERSION || record.lines === null || typeof record.lines !== 'object'
        || !Object.values(record.lines).every(validLine)) {
        throw new Error(`${fileFor(agentId)} does not hold a read position this version understands`);
      }
      return { lines: record.lines };
    },
    save(agentId, record) {
      const file = fileFor(agentId);
      const temporary = `${file}.${process.pid}.tmp`;
      const fd = openSync(temporary, 'w', 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ version: VERSION, lines: record.lines })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, file);
    },
  };
};
