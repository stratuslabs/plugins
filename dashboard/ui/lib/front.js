/**
 * The line an agent's settings show for its soul's `front:` block, or
 * undefined when the roster entry has none.
 *
 * GET /agents carries the block as the soul wrote it: `front: { model,
 * provider?, tools? }`, the model the agent's conversation turns run on. An
 * omitted provider is the agent's own, which `runsOn` names. `runsOn` is
 * absent when the daemon can't read the soul and `none` when no provider
 * resolves, and neither is a provider to name, so the line leaves it out.
 * Read-only: the front is set by editing the soul.
 */
export const frontLine = (agent) => {
  const front = agent?.front;
  if (typeof front?.model !== 'string' || front.model === '') {
    return undefined;
  }
  const own = agent.runsOn?.provider;
  const provider = front.provider || (own && own !== 'none' ? own : undefined);
  return provider ? `Front: ${front.model} (on ${provider})` : `Front: ${front.model}`;
};
