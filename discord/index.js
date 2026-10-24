import { createDiscordAdapter } from './lib/adapter.js';
import { parseDiscordConfig } from './lib/config.js';

/**
 * @stratusagent/plugin-discord: each agent answers as its own Discord bot.
 *
 * The config (lib/config.js) says who each agent answers and where; the bot
 * token is the channel's transport secret, stored with
 * `stratus channel set discord --agent <id> botToken`, never an agent
 * credential. An agent is registered on Discord only when it has both.
 *
 * `options.api` points the bots at another Discord and `options.drainTimeoutMs`
 * shortens the stop drain, both for tests.
 */
export const createPlugin = (config = {}, options = {}) => ({
  name: 'discord',
  async setup(context) {
    if (!context?.channels) {
      throw new Error('This host hands plugins no channel handle (PluginContext.channels), so @stratusagent/plugin-discord cannot register.');
    }
    const secrets = await context.channels.transportSecrets('discord');
    const withTokens = Object.keys(secrets).filter((agentId) => typeof secrets[agentId]?.botToken === 'string' && secrets[agentId].botToken.length > 0);
    const parsed = parseDiscordConfig(config, { withTokens });
    const agents = [...parsed.agents.keys()].filter((agentId) => withTokens.includes(agentId));
    const log = context.log ?? (() => {});
    const warn = context.warn ?? log;
    for (const agentId of parsed.agents.keys()) {
      if (!agents.includes(agentId)) {
        warn(`discord: ${agentId} is configured but has no bot token. Store one with \`stratus channel set discord --agent ${agentId} botToken\`.`);
      }
    }
    const adapter = createDiscordAdapter({ config: parsed, secrets, api: options.api, log, warn, ...(options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}) });
    context.channels.register({ adapter, agents });
  },
});
