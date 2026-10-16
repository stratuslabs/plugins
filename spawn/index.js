// agent.spawn: fan one task out to several sub-agents at once (roadmap 24).
//
// The host does everything that is a trust boundary: which tools a
// sub-agent may have, that it never asks a person, depth, how many run at
// once per turn, cancellation. See `PluginContext.subAgents` in
// @stratusagent/core. This plugin owns only the fan-out: how many tasks one
// call may carry, running them together, and the shape of what comes back.

export const SPAWN_TOOL_NAME = 'agent.spawn';
export const DEFAULT_MAX_TASKS = 8;
export const MAX_TASKS_CEILING = 32;

const TRUST_ORDER = ['user', 'agent', 'unknown', 'external'];

/** The least trusted of `labels`: what a call carrying all of them is worth. */
const leastTrusted = (labels) =>
  labels.reduce((lowest, label) => (TRUST_ORDER.indexOf(label) > TRUST_ORDER.indexOf(lowest) ? label : lowest), 'agent');

const readMaxTasks = (config) => {
  const value = config?.maxTasks;
  if (value === undefined) {
    return DEFAULT_MAX_TASKS;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_TASKS_CEILING) {
    throw new Error(`@stratusagent/tool-spawn: maxTasks must be a whole number from 1 to ${MAX_TASKS_CEILING}.`);
  }
  return value;
};

const readTasks = (input, maxTasks) => {
  const tasks = input?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('agent.spawn needs "tasks": a list of { instruction, tools }.');
  }
  if (tasks.length > maxTasks) {
    throw new Error(`agent.spawn takes at most ${maxTasks} tasks in one call; this one had ${tasks.length}. Split them, or do some yourself.`);
  }
  return tasks.map((task, index) => {
    const instruction = typeof task?.instruction === 'string' ? task.instruction.trim() : '';
    if (!instruction) {
      throw new Error(`agent.spawn task ${index + 1} has no instruction.`);
    }
    const tools = task?.tools === undefined ? [] : task.tools;
    if (!Array.isArray(tools) || tools.some((name) => typeof name !== 'string')) {
      throw new Error(`agent.spawn task ${index + 1}: "tools" is a list of tool names.`);
    }
    return { instruction, tools };
  });
};

export const createSpawnTool = (subAgents, options = {}) => {
  const maxTasks = readMaxTasks(options);
  return {
    name: SPAWN_TOOL_NAME,
    description:
      'Run several tasks at once, each in a short-lived sub-agent that has only the tools you list for it '
      + '(each one you can use yourself; not agent.spawn, agent.delegate, or memory). Sub-agents start with no '
      + 'memory and no conversation, so say everything a task needs in its instruction. They never ask anyone '
      + 'for approval: a call that would need it fails inside the sub-agent and is reported back. You get each '
      + 'task\'s answer, or why it failed, in order.',
    // Safe for the reasons agent.delegate is: it acts on nothing outside
    // Stratus, each sub-agent's own calls face the approval policy again,
    // and what a sub-agent may do is strictly narrower than this agent.
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: maxTasks,
          items: {
            type: 'object',
            properties: {
              instruction: { type: 'string', description: 'Everything the sub-agent needs to do the task and what to answer with.' },
              tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool names it may use, e.g. ["web.fetch"]. Empty for a task that only thinks.' },
            },
            required: ['instruction'],
          },
        },
      },
      required: ['tasks'],
    },
    async execute(input, session, context) {
      const tasks = readTasks(input, maxTasks);
      const settled = await Promise.allSettled(tasks.map((task) => subAgents.run({
        parent: session,
        instruction: task.instruction,
        tools: task.tools,
        ...(context?.signal ? { signal: context.signal } : {}),
      })));
      // The parent's own cancellation ends the call; nothing to report.
      if (context?.signal?.aborted) {
        throw context.signal.reason instanceof Error ? context.signal.reason : new Error('agent.spawn was cancelled.');
      }
      const results = settled.map((outcome, index) => {
        if (outcome.status === 'rejected') {
          // Refused before it ran: nothing a sub-agent read is in this text.
          const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          return { task: index + 1, status: 'refused', error: reason };
        }
        const value = outcome.value;
        if (value.status === 'result') {
          return { task: index + 1, status: 'result', answer: value.text, sessionId: value.sessionId };
        }
        if (value.status === 'empty') {
          return { task: index + 1, status: 'empty', sessionId: value.sessionId };
        }
        return { task: index + 1, status: 'error', error: value.error, sessionId: value.sessionId };
      });
      // What came back may repeat what the sub-agents read: the call is
      // worth the least trusted of them, as agent.delegate marks its reply.
      const ran = settled.filter((outcome) => outcome.status === 'fulfilled').map((outcome) => outcome.value.trust);
      if (ran.length > 0) {
        context?.markTrust?.(leastTrusted(ran));
      }
      return { results };
    },
  };
};

export const createPlugin = (config = {}) => ({
  name: 'spawn',
  setup(context) {
    if (!context.subAgents) {
      throw new Error(
        '@stratusagent/tool-spawn needs a Stratus host that can run sub-agents (PluginContext.subAgents), and this one cannot. Update Stratus.',
      );
    }
    context.tools.register(createSpawnTool(context.subAgents, config));
  },
});
