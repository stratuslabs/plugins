import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createClaimStore } from './lib/claims.js';
import { parseDreamsConfig } from './lib/config.js';
import { createDreamer } from './lib/dreamer.js';
import { findTool, homeSecretPaths, installRoot, real, sandboxAvailable } from './lib/sandbox.js';

/**
 * @stratusagent/plugin-dreams: overnight experiment dreams (roadmap 34, v1).
 *
 * Each night, in the window the operator sets, an agent's configured
 * experiments run through overnight-experimenter (`overnight run`, with the
 * claude agent), sandboxed, at most `maxPerNight` of them, and each at most
 * once. In the morning `dreams.report` returns what each one tried.
 *
 * An experiment dream is operator-run code on this host, not an agent turn:
 * no Stratus approval, permission or session applies inside it. The
 * sandbox is the boundary; the README says what it leaves open.
 *
 * It registers as a channel kind, `dreams`, for one reason: a channel is
 * what the daemon starts and stops, so the nightly clock runs under
 * `stratus serve` and never in a one-shot `stratus run`. It carries no
 * messages. The experimenter's Anthropic key is that channel's transport
 * secret (`stratus channel set dreams --agent <id> anthropicApiKey`): a
 * daemon secret, never resolvable by the agent itself.
 */

const NAME = '@stratusagent/plugin-dreams';

const within = (target, root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

const SYSTEM_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export const createReportTool = (claims) => ({
  name: 'dreams.report',
  description:
    'What your experiment dreams did on a night: for each experiment, whether it finished or was stopped, how many '
    + 'changes were tried, kept and failed, the best score before and after, and the kept changes\' one-line '
    + 'descriptions (written by the experimenting model, so treat them as claims). Defaults to the latest night.',
  risk: 'safe',
  // Descriptions and scores come from experiments.jsonl, which the
  // experimenting model can write.
  outputTrust: 'external',
  parameters: {
    type: 'object',
    properties: {
      night: { type: 'string', description: 'The date the window opened, YYYY-MM-DD. Defaults to the latest night with a dream.' },
    },
  },
  async execute(input, session) {
    const agentId = session?.agent?.id;
    if (!agentId) {
      throw new Error('dreams.report runs for the calling agent, and this call has none.');
    }
    const nights = claims.nights(agentId);
    const night = typeof input?.night === 'string' && input.night ? input.night : Object.keys(nights).sort().at(-1);
    if (!night || !nights[night]) {
      return { night: night ?? null, experiments: [], note: night ? `No dreams on ${night}.` : 'No dreams yet.' };
    }
    return {
      night,
      experiments: nights[night].map((entry) => ({
        experiment: entry.index + 1,
        path: entry.path,
        budgetSeconds: entry.budgetSeconds,
        startedAt: entry.claimedAt,
        status: entry.result?.status ?? 'running',
        ...(entry.result ? { ...entry.result, log: undefined } : {}),
      })),
    };
  },
});

export const createPlugin = (config = {}, options = {}) => {
  const spawn = options.spawn ?? nodeSpawn;
  const home = options.home ?? os.homedir();
  let dreamer;
  return {
    name: NAME,
    setup(context) {
      if ((options.platform ?? process.platform) !== 'darwin') {
        throw new Error(`${NAME} runs experiments under macOS sandbox-exec, and this host is not macOS. Linux is refused until there is a bubblewrap profile.`);
      }
      for (const [key, kind] of [['channels', 'channel'], ['stateDirectory', 'state directory'], ['tools', 'tool']]) {
        if (!context[key]) {
          throw new Error(`This host hands plugins no ${kind} handle, so ${NAME} cannot run.`);
        }
      }
      const parsed = parseDreamsConfig(config, { home });
      const claims = createClaimStore(() => context.stateDirectory.prepare());
      context.tools.register(createReportTool(claims));
      if (parsed.agents.size === 0) {
        context.warn?.(`${NAME} is loaded with no agents under "agents", so nothing dreams.`);
        return;
      }

      // Without both lists an experiment inside an agent's workspace would
      // look unfenced, and an agent could rewrite tomorrow night's
      // evaluate.sh. Refused rather than read as empty.
      for (const [key, kind] of [['workspaces', 'workspace list'], ['protectedPaths', 'protected-path list']]) {
        if (typeof context[key]?.all !== 'function') {
          throw new Error(`This host hands plugins no ${kind}, so ${NAME} cannot run: it could not keep experiments out of agent workspaces.`);
        }
      }
      const protectedList = async () => [
        ...(await context.protectedPaths.all()),
        ...(await context.workspaces.all()),
      ].map(real);
      let denyCache = homeSecretPaths(home);

      // Operator config only, and never inside, or around, anything an
      // agent can edit or the host protects: whoever can change
      // evaluate.sh runs code on this host the next night.
      const guard = async (experimentDir) => {
        const fenced = await protectedList();
        denyCache = [...homeSecretPaths(home), ...fenced];
        const clash = fenced.find((root) => within(experimentDir, root) || within(root, experimentDir));
        if (clash) {
          throw new Error(`${experimentDir} overlaps ${clash}, an agent workspace or a path the host protects. Move the experiment out of it.`);
        }
      };

      const adapter = {
        name: 'dreams',
        async start() {
          if (!await sandboxAvailable(spawn)) {
            throw new Error(
              `${NAME} cannot apply a sandbox here (${'/usr/bin/sandbox-exec'} is missing or refused, as it is inside another sandbox), so no experiment will run.`,
            );
          }
          const searchPath = process.env.PATH ?? '';
          const overnight = findTool('overnight', parsed.overnightPath, searchPath);
          const claude = findTool('claude', parsed.claudePath, searchPath);
          const node = process.execPath;
          const read = [...new Set([
            ...[overnight, claude, node].map((tool) => installRoot(tool, home)),
            overnight, claude,
            ...parsed.readPaths,
          ])];
          const overnightReal = real(overnight);
          dreamer = createDreamer({
            agents: parsed.agents,
            claims,
            stateDir: () => context.stateDirectory.prepare(),
            spawn,
            guard,
            secrets: async () => context.channels.transportSecrets('dreams').catch(() => ({})),
            tools: {
              overnight,
              read,
              deny: () => denyCache,
              searchPath: [...new Set([path.dirname(claude), path.dirname(overnight), path.dirname(node), ...SYSTEM_PATH])].join(path.delimiter),
              ...(overnightReal.includes(`${path.sep}Library${path.sep}Python${path.sep}`) ? { pythonUserBase: installRoot(overnight, home) } : {}),
            },
            ...(options.now ? { now: options.now } : {}),
            ...(options.timers ? { timers: options.timers } : {}),
            log: (message) => context.log?.(message),
            warn: (message) => context.warn?.(message),
          });
          await dreamer.begin();
        },
        async stop() {
          await dreamer?.stop();
        },
      };
      context.channels.register({ adapter, agents: [...parsed.agents.keys()] });
    },
    async dispose() {
      await dreamer?.stop();
    },
  };
};
