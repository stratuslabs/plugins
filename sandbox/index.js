import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import { resolvePluginAgentConfig } from '@stratusagent/plugins';

/**
 * stratus-plugin-sandbox: an executor that runs every command an agent
 * composes under the operating system's sandbox, so it can write only its
 * own workspace and read only the system's toolchains plus what the
 * operator lists. Selected with `"executor": "sandbox"` in a trusted config.
 *
 * This is the boundary the permission engine can't be: the engine judges a
 * command's arguments, and a program it approved can still run whatever its
 * config names (git hooks, filters, a repository's `core.sshCommand`). Under
 * this executor those run inside the same walls.
 *
 * macOS only for now (`sandbox-exec`). On any other platform the plugin
 * refuses to load rather than leave commands running on the host under a
 * name that says otherwise.
 */

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** What every command may read: the system and the usual toolchain homes. */
const SYSTEM_READ = [
  '/usr', '/bin', '/sbin', '/System', '/Library', '/opt/homebrew', '/usr/local',
  '/private/etc', '/private/var/db', '/dev', '/Applications/Xcode.app',
];

/**
 * The Mach services a command may look up: name and user lookups, DNS,
 * network configuration, certificate trust, preferences, notifications and
 * logging. Nothing else, so shared per-user services such as the pasteboard
 * (pbpaste) and the keychain (security) are out of reach. Verified with
 * curl, git, node and python over HTTPS, dig, ssh, npm and id.
 */
const MACH_SERVICES = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.system.DirectoryService.libinfo_v1',
  'com.apple.system.notification_center',
  'com.apple.system.logger',
  'com.apple.logd',
  'com.apple.diagnosticd',
  'com.apple.dnssd.service',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.ocspd',
  'com.apple.cfprefsd.daemon',
  'com.apple.cfprefsd.agent',
];

/** Paths are spliced into the profile as strings: no quote or backslash may end one early. */
const sbplString = (value) => {
  if (/["\\\n\r\0]/.test(value)) {
    throw new Error(`stratus-plugin-sandbox cannot express the path ${JSON.stringify(value)} in a sandbox profile.`);
  }
  return `"${value}"`;
};

/** The real path, so a symlinked workspace is allowed where it actually is. */
const real = (target) => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.length > 0) : []);

const expandHome = (target, home) => (target === '~' ? home : target.startsWith('~/') ? path.join(home, target.slice(2)) : target);

/**
 * The profile for one command: deny everything, then allow running
 * programs, reading the system and the listed paths, writing the workspace
 * and its temporary directory, and (unless turned off) the network.
 */
export const sandboxProfile = ({ write, read, network }) => {
  const readRules = [...SYSTEM_READ, ...read, ...write].map((target) => `(subpath ${sbplString(target)})`).join(' ');
  const writeRules = write.map((target) => `(subpath ${sbplString(target)})`).join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork sysctl-read ipc-posix-shm pseudo-tty)',
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${sbplString(name)})`).join(' ')})`,
    // A command may signal its own children, never the daemon or another
    // process the same user owns: sandbox-exec execs the command, so $PPID
    // is the unsandboxed host.
    '(allow signal (target same-sandbox))',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${readRules})`,
    `(allow file-write* ${writeRules} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    ...(network ? ['(allow network*)'] : []),
  ].join('\n');
};

/**
 * What one agent's commands may touch, from the plugin's config (shared
 * keys, overridden or added to per agent under `agents.<id>`).
 */
export const sandboxSettings = (config, agentId, workspace, cwd, home = os.homedir()) => {
  const resolved = resolvePluginAgentConfig(config, agentId, { mergeKeys: [] });
  const shared = config ?? {};
  const own = (shared.agents && typeof shared.agents === 'object' ? shared.agents[agentId] : undefined) ?? {};
  // Lists add up: every agent reads the shared paths, and its own besides.
  const list = (key) => [...strings(shared[key]), ...strings(own[key])].map((target) => real(expandHome(target, home)));
  // The workspace is checked on its own: a cwd or configured write path
  // must never stand in for a missing one.
  const ownWorkspace = typeof workspace === 'string' && workspace.length > 0 ? real(workspace) : undefined;
  const write = ownWorkspace
    ? [...new Set([ownWorkspace, ...(typeof cwd === 'string' && cwd.length > 0 ? [real(cwd)] : []), ...list('writePaths')])]
    : [];
  return {
    workspace: ownWorkspace,
    write,
    read: list('readPaths'),
    network: resolved.network !== false,
  };
};

export const createPlugin = (config = {}) => ({
  name: 'stratus-plugin-sandbox',
  setup(context) {
    if (process.platform !== 'darwin') {
      throw new Error(
        'stratus-plugin-sandbox runs commands under macOS sandbox-exec, and this host is not macOS. '
        + 'Remove "executor": "sandbox" and the plugin from the config, or run on macOS.',
      );
    }
    if (!context.executors) {
      throw new Error('This host hands plugins no executor handle, so stratus-plugin-sandbox cannot register one.');
    }
    const workspaces = context.workspaces;
    const spawnFor = (settings) => (command, args, options) => {
      if (!settings.workspace) {
        // No workspace was named for this agent: refuse rather than guess
        // one, and before anything is created on the host.
        throw new Error('stratus-plugin-sandbox has no workspace for this agent, so it will not run the command.');
      }
      // Temporary files go inside the workspace, which is writable, rather
      // than to a shared directory, which isn't.
      const tmp = path.join(settings.workspace, '.tmp');
      mkdirSync(tmp, { recursive: true });
      const profile = sandboxProfile(settings);
      return nodeSpawn(SANDBOX_EXEC, ['-p', profile, command, ...args], {
        ...options,
        env: { ...(options.env ?? {}), TMPDIR: tmp },
      });
    };
    context.executors.register({
      name: 'sandbox',
      executor: {
        async execute(call, tool, session, executionContext) {
          const workspace = workspaces?.prepare(session.agent.id);
          // The command's own cwd decides nothing until spawn time, so the
          // spawn reads it there and allows it alongside the workspace.
          const local = createLocalCommandExecutor({
            spawn: (command, args, options) => spawnFor(sandboxSettings(config, session.agent.id, workspace, options.cwd))(command, args, options),
          });
          return local.execute(call, tool, session, executionContext);
        },
      },
    });
  },
});
