import { createImessageAdapter } from './lib/adapter.js';
import { parseImessageConfig } from './lib/config.js';

/**
 * @stratusagent/plugin-imessage: text an agent from your phone through
 * Messages.app on its own Mac.
 *
 * The config (lib/config.js) binds each agent to the Apple ID it sends as
 * and says whom it answers. Local delivery has no secret to store.
 *
 * `options.chatDb`, `openDb`, `sender`, `intervalMs`, `watch` and
 * `sendRetryMs` point the channel at a stand-in Messages for tests.
 */
export const createPlugin = (config = {}, options = {}) => ({
  name: 'imessage',
  async setup(context) {
    if (!context?.channels) {
      throw new Error('This host hands plugins no channel handle (PluginContext.channels), so @stratusagent/plugin-imessage cannot register.');
    }
    if (!context.stateDirectory) {
      throw new Error('This host gives plugins no state directory, so @stratusagent/plugin-imessage has nowhere to keep how far it has read Messages.');
    }
    const parsed = parseImessageConfig(config, options.platform ? { platform: options.platform } : {});
    const log = context.log ?? (() => {});
    const warn = context.warn ?? log;
    for (const [agentId, reason] of parsed.refused) {
      warn(`imessage: ${agentId} is not on iMessage: ${reason}`);
    }
    const adapter = createImessageAdapter({
      config: parsed,
      stateDirectory: context.stateDirectory.prepare(),
      log,
      warn,
      ...(options.chatDb ? { chatDb: options.chatDb } : {}),
      ...(options.openDb ? { openDb: options.openDb } : {}),
      ...(options.sender ? { sender: options.sender } : {}),
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      ...(options.watch !== undefined ? { watch: options.watch } : {}),
      ...(options.sendRetryMs ? { sendRetryMs: options.sendRetryMs } : {}),
    });
    context.channels.register({ adapter, agents: [...parsed.agents.keys()] });
  },
});
