import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * Which experiments each agent has spent, per night. A claim is written,
 * and synced, before the experiment's process starts: a daemon that dies
 * mid-run finds the claim on restart and moves on, so an experiment never
 * runs twice in one night. The cost is that one interrupted by a crash is
 * not retried that night.
 */

const KEEP_NIGHTS = 14;

const writeDurably = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const dir = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
};

export const createClaimStore = (directory) => {
  const fileFor = (agentId) => path.join(directory(), 'claims', `${agentId}.json`);

  const load = (agentId) => {
    try {
      const parsed = JSON.parse(readFileSync(fileFor(agentId), 'utf8'));
      return parsed && typeof parsed.nights === 'object' ? parsed : { nights: {} };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { nights: {} };
      }
      // A claim file we cannot read must not read as "nothing spent".
      throw new Error(`@stratusagent/plugin-dreams cannot read its claims for ${agentId}: ${error.message}`);
    }
  };

  const save = (agentId, state) => {
    const nights = Object.keys(state.nights).sort();
    for (const old of nights.slice(0, Math.max(0, nights.length - KEEP_NIGHTS))) {
      delete state.nights[old];
    }
    const file = fileFor(agentId);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeDurably(file, `${JSON.stringify(state, null, 2)}\n`);
  };

  return {
    /** This night's claims, oldest first. */
    night(agentId, night) {
      return load(agentId).nights[night] ?? [];
    },
    nights(agentId) {
      return load(agentId).nights;
    },
    /** Durable when it returns. */
    claim(agentId, night, entry) {
      const state = load(agentId);
      state.nights[night] = [...(state.nights[night] ?? []), entry];
      save(agentId, state);
    },
    finish(agentId, night, index, result) {
      const state = load(agentId);
      const entry = (state.nights[night] ?? []).find((candidate) => candidate.index === index);
      if (entry) {
        entry.result = result;
        save(agentId, state);
      }
    },
  };
};
