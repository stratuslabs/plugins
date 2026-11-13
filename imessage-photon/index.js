import { CHANNEL, createPhotonAdapter } from './lib/adapter.js';
import { parsePhotonConfig } from './lib/config.js';

/**
 * @stratusagent/plugin-imessage-photon: text an agent from your phone,
 * on an iMessage line Photon hosts (photon.codes), with no Mac or Apple ID
 * of your own.
 *
 * Each agent has its own Photon project, stored as the channel's transport
 * secrets: `stratus channel set imessage-photon --agent <id> projectId
 * projectSecret`. The config (lib/config.js) says who it answers and who
 * approves its gated calls.
 *
 * `options.connect` replaces the connection to a Photon line, `fetch` the
 * token request, and the `*RetryMs` lists shorten waits. All for tests.
 */
export const createPlugin = (config = {}, options = {}) => ({
  name: CHANNEL,
  async setup(context) {
    if (!context?.channels) {
      throw new Error('This host hands plugins no channel handle (PluginContext.channels), so @stratusagent/plugin-imessage-photon cannot register.');
    }
    if (!context.stateDirectory) {
      throw new Error('This host gives plugins no state directory, so @stratusagent/plugin-imessage-photon has nowhere to keep how far it has read each line.');
    }
    const secrets = await context.channels.transportSecrets(CHANNEL);
    const withSecrets = Object.keys(secrets).filter((agentId) => typeof secrets[agentId]?.projectId === 'string' && typeof secrets[agentId]?.projectSecret === 'string');
    const parsed = parsePhotonConfig(config, { withSecrets });
    const log = context.log ?? (() => {});
    const warn = context.warn ?? log;
    for (const [agentId, reason] of parsed.refused) {
      warn(`imessage-photon: ${agentId} is not on iMessage: ${reason}.`);
    }
    for (const agentId of parsed.unbound) {
      warn(`imessage-photon: ${agentId} is configured but has no Photon project stored. Store one with \`stratus channel set imessage-photon --agent ${agentId} projectId projectSecret\`.`);
    }
    const adapter = createPhotonAdapter({
      config: parsed,
      secrets,
      stateDirectory: context.stateDirectory.prepare(),
      log,
      warn,
      ...(options.connect ? { connect: options.connect } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sendRetryMs ? { sendRetryMs: options.sendRetryMs } : {}),
      ...(options.startRetryMs ? { startRetryMs: options.startRetryMs } : {}),
      ...(options.retryMs ? { retryMs: options.retryMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    context.channels.register({ adapter, agents: [...parsed.agents.keys()] });
  },
});
