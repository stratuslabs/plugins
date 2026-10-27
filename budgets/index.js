import { BudgetExceededError, PACKAGE_NAME, findBreach, parseBudgetConfig } from './budget.js';
import { UsageLedger } from './ledger.js';

export { BudgetExceededError, budgetWindow, parseBudgetConfig, weightedTokens } from './budget.js';
export { UsageLedger } from './ledger.js';

/**
 * Token budgets and a usage ledger, out of core.
 *
 * Two kernel seams do the work. Every provider call's usage is announced on
 * the bus as `session.usage`, and the ledger writes it down. Before every
 * provider call the host asks this plugin's guard, which refuses with a
 * `BudgetExceededError` once a limit is reached. Read the README for the
 * config and what a crash costs.
 */
export const createPlugin = (config = {}) => {
  const budget = parseBudgetConfig(config);
  let unsubscribe;

  return {
    name: PACKAGE_NAME,

    setup(context) {
      for (const seam of ['providerCalls', 'stateDirectory']) {
        if (!context[seam]) {
          throw new Error(`${PACKAGE_NAME} needs the host's ${seam}, which this Stratus doesn't provide, so no budget could be enforced. Update Stratus.`);
        }
      }
      const warn = context.warn ?? (() => {});
      const directory = () => context.stateDirectory.prepare();
      const ledger = new UsageLedger({ directory, warn });
      const cannotWrite = (error) => new Error(
        `${PACKAGE_NAME} could not write its usage ledger in ${directory()}: ${error.message}. Model calls under a budget are refused until it can.`,
      );

      /** Usage announced but not yet on disk, written before anything else. */
      const unwritten = [];
      /** Reserves this process holds open, by session. */
      const open = new Map();

      const flush = () => {
        while (unwritten.length > 0) {
          ledger.record(unwritten[0]);
          unwritten.shift();
        }
      };
      const settle = (sessionId) => {
        const reserves = open.get(sessionId);
        while (reserves && reserves.length > 0) {
          ledger.settle(reserves[0]);
          reserves.shift();
        }
        open.delete(sessionId);
      };

      unsubscribe = context.bus.subscribe((event) => {
        if (event.type === 'session.usage') {
          for (const record of event.records) unwritten.push({ agentId: event.agentId, sessionId: event.sessionId, record });
        } else if (!(event.type === 'session.updated' && event.status !== 'running')
          && event.type !== 'session.completed' && event.type !== 'session.failed') {
          return;
        }
        // The call's usage is in, or the turn has stopped (done, failed,
        // cancelled, or parked for an approval), so its reserve is done.
        try {
          flush();
          settle(event.sessionId);
        } catch (error) {
          warn(`${PACKAGE_NAME}: could not write to the usage ledger (${error.message}). Kept in memory and written before the next model call.`);
        }
      });

      context.providerCalls.register(async ({ agentId, sessionId, provider }) => {
        const limited = budget.limited(agentId);
        try {
          flush();
          // A session asks again only once its last call is over.
          settle(sessionId);
          ledger.refresh();
        } catch (error) {
          if (limited) throw cannotWrite(error);
          return;
        }
        if (!limited) return;
        const spend = (since, forAgent) => ledger.spend({ since, agentId: forAgent, weights: budget.weights, reservePerCall: budget.reservePerCall });
        const breach = findBreach(budget, agentId, spend, new Date());
        if (breach) throw new BudgetExceededError(breach);
        let reserve;
        try {
          reserve = ledger.reserve({ agentId, sessionId, provider });
        } catch (error) {
          throw cannotWrite(error);
        }
        const reserves = open.get(sessionId) ?? [];
        reserves.push(reserve);
        open.set(sessionId, reserves);
      });

      context.log?.(`${PACKAGE_NAME}: usage ledger in ${directory()}`);
    },

    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
};
