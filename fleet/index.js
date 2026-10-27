// fleet.*: read-only tools for an agent that reports on the fleet (roadmap 26).
//
// The host owns what crosses: `PluginContext.fleet` returns metadata only
// (no messages, prompts, approval inputs or session metadata), has no write
// verb, and logs every read with this plugin's name. This plugin owns only
// the tool shapes, a bound on how many sessions one call returns, and the
// minutes-since figures a report needs. What counts as stuck or failing is
// the soul's judgement, not a constant here.

export const DEFAULT_SESSION_LIMIT = 50;
export const MAX_SESSION_LIMIT = 500;

const SESSION_STATUSES = ['idle', 'running', 'pending_approval', 'completed', 'failed'];

const minutesSince = (iso, now) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : undefined;
};

const withMinutes = (row, field, key, now) => {
  const minutes = minutesSince(row[field], now);
  return minutes === undefined ? { ...row } : { ...row, [key]: minutes };
};

const readSessionQuery = (input) => {
  const { agentId, status, limit } = input ?? {};
  if (agentId !== undefined && (typeof agentId !== 'string' || agentId.trim() === '')) {
    throw new Error('fleet.sessions: "agentId" is an agent id, e.g. "ava".');
  }
  if (status !== undefined && !SESSION_STATUSES.includes(status)) {
    throw new Error(`fleet.sessions: "status" is one of ${SESSION_STATUSES.join(', ')}.`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_LIMIT)) {
    throw new Error(`fleet.sessions: "limit" is a whole number from 1 to ${MAX_SESSION_LIMIT}.`);
  }
  return {
    ...(agentId !== undefined ? { agentId: agentId.trim() } : {}),
    ...(status !== undefined ? { status } : {}),
    limit: limit ?? DEFAULT_SESSION_LIMIT,
  };
};

const noInput = { type: 'object', properties: {} };

export const createFleetTools = (fleet, options = {}) => {
  const now = options.now ?? Date.now;
  return [
    {
      name: 'fleet.agents',
      description:
        'Every agent this Stratus daemon serves, with when each was last active and how many of its sessions are '
        + 'running or waiting on a person, plus how many stored sessions are in each status. Metadata only.',
      risk: 'safe',
      parameters: noInput,
      async execute() {
        const [agents, sessionsByStatus] = await Promise.all([fleet.agents(), fleet.countByStatus()]);
        return { agents, sessionsByStatus };
      },
    },
    {
      name: 'fleet.sessions',
      description:
        'Sessions across the fleet, newest first: id, agent, status, when created and last updated, and minutes since '
        + `that update. Filter by agentId and status. At most ${DEFAULT_SESSION_LIMIT} unless you set limit `
        + `(up to ${MAX_SESSION_LIMIT}). Never a session's messages.`,
      risk: 'safe',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Only this agent\'s sessions.' },
          status: { type: 'string', enum: SESSION_STATUSES, description: 'Only sessions in this status.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SESSION_LIMIT, description: 'How many rows at most.' },
        },
      },
      async execute(input) {
        const query = readSessionQuery(input);
        // A status filter is applied here, so it reads every row for the
        // agent first and bounds after; otherwise the host bounds the read.
        const rows = await fleet.sessions({
          ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
          ...(query.status === undefined ? { limit: query.limit } : {}),
        });
        const matched = query.status === undefined ? rows : rows.filter((row) => row.status === query.status);
        const at = now();
        return { sessions: matched.slice(0, query.limit).map((row) => withMinutes(row, 'updatedAt', 'minutesSinceUpdate', at)) };
      },
    },
    {
      name: 'fleet.schedules',
      description:
        'Every schedule in the fleet: agent, cadence, where it reports, next and last firing, and the status of the '
        + 'last firing\'s session (failed means the last run failed). Never a schedule\'s prompt.',
      risk: 'safe',
      parameters: noInput,
      async execute() {
        return { schedules: await fleet.schedules() };
      },
    },
    {
      name: 'fleet.approvals',
      description:
        'Every tool call waiting on a person right now: which tool, agent and session, its risk, when it was parked, '
        + 'when it expires, and minutes waiting. Never the call\'s input.',
      risk: 'safe',
      parameters: noInput,
      async execute() {
        const at = now();
        return { approvals: (await fleet.pendingApprovals()).map((row) => withMinutes(row, 'parkedAt', 'minutesWaiting', at)) };
      },
    },
  ];
};

export const createPlugin = () => ({
  name: 'fleet',
  setup(context) {
    if (!context.fleet) {
      throw new Error(
        '@stratusagent/plugin-fleet needs a Stratus host that can read the fleet (PluginContext.fleet), and this one cannot. Update Stratus.',
      );
    }
    for (const tool of createFleetTools(context.fleet)) {
      context.tools.register(tool);
    }
  },
});
