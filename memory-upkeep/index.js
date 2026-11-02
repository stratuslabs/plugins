// @stratusagent/memory-upkeep: decides when an agent's memory passes run
// (spec 962). A save pass once a conversation has been quiet for a while or
// its floor rose; a tidy pass in a nightly window.
//
// Core runs every pass and enforces every rule: what a pass may read, which
// conversations count, the trust label each fact carries, one pass per agent
// at a time, the ledger and undo. This plugin only asks, from bus events and
// fleet metadata, and never sees a message or a fact.

import { readUpkeepConfig } from './lib/config.js';
import { createUpkeep } from './lib/upkeep.js';

export { readUpkeepConfig } from './lib/config.js';
export { createUpkeep } from './lib/upkeep.js';
export { nightIn, parseWindow } from './lib/window.js';

export const createPlugin = (config = {}) => {
  // Checked here, before setup, so a bad window or time zone stops the
  // daemon's start with the setting named rather than failing at 3 a.m.
  const agents = readUpkeepConfig(config);
  let upkeep;
  return {
    name: 'memory-upkeep',
    async setup(context) {
      const log = context.log ?? ((line) => console.log(line));
      const warn = context.warn ?? ((line) => console.warn(line));
      if (agents.size === 0) {
        log('memory-upkeep: no agents listed under "agents", so no memory passes run.');
        return;
      }
      if (context.memoryPasses === undefined) {
        throw new Error(
          'memory-upkeep needs PluginContext.memoryPasses, which this host does not provide. '
            + 'Memory passes run in the daemon (stratus serve), with @stratusagent/core 0.14.3 or later; stratus run cannot run them.',
        );
      }
      if (context.fleet === undefined) {
        throw new Error('memory-upkeep needs PluginContext.fleet to find recent sessions after a restart, and this host does not provide it.');
      }
      upkeep = createUpkeep({ agents, passes: context.memoryPasses, fleet: context.fleet, bus: context.bus, log, warn });
      await upkeep.start();
    },
    dispose() {
      upkeep?.stop();
    },
  };
};
