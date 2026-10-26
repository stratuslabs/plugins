import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import { resolvePluginAgentConfig } from '@stratusagent/plugins';

/**
 * @stratusagent/plugin-sandbox: an executor that runs every command an agent
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
 * network configuration, certificate trust, notifications and logging.
 * Not cfprefsd: preferences are then read from their plist files, under the
 * file rules, rather than asked of a daemon outside them. Nothing else, so shared per-user services such as the pasteboard
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
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.ocspd',
];

/** The resolver broker, allowed only with the network: without it a command could still send DNS queries. */
const NETWORK_MACH_SERVICES = ['com.apple.dnssd.service'];

/**
 * POSIX shared memory by name only: the notification center's, read-only.
 * Any other named object a same-user process created stays out of reach.
 */
const SHM_READ = ['apple.shm.notification_center'];

/** Paths are spliced into the profile as strings: no quote or backslash may end one early. */
const sbplString = (value) => {
  if (/["\\\n\r\0]/.test(value)) {
    throw new Error(`@stratusagent/plugin-sandbox cannot express the path ${JSON.stringify(value)} in a sandbox profile.`);
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

/**
 * The Xcode bundle a command's tools come from, when the active developer
 * directory is inside one. /usr/bin/git, clang, make and the other shims run
 * xcrun, which loads its library from that directory, and Xcode can be
 * installed under any name (Xcode_26.6.app on GitHub's macOS runners,
 * Xcode-beta.app). The bundle is read-only, like the rest of the system.
 * Command Line Tools live under /Library, which is already readable, so
 * nothing is added for them, or for a directory outside any bundle.
 */
export const toolchainReads = (developerDir) => {
  if (typeof developerDir !== 'string') return [];
  const dir = developerDir.trim();
  if (!path.isAbsolute(dir)) return [];
  const bundle = /^(\/.+?\.app)(?=\/|$)/.exec(real(dir));
  return bundle ? [bundle[1]] : [];
};

/** Where xcode-select points (DEVELOPER_DIR included), or nothing if it can't say. */
const activeDeveloperDir = () => {
  try {
    return execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.length > 0) : []);

const expandHome = (target, home) => (target === '~' ? home : target.startsWith('~/') ? path.join(home, target.slice(2)) : target);

/**
 * The profile for one command: deny everything, then allow running
 * programs, reading the system and the listed paths, writing the workspace
 * and its temporary directory, and (unless turned off) the network.
 */
export const sandboxProfile = ({ write, read, network, toolchains = [] }) => {
  const mach = [...MACH_SERVICES, ...(network ? NETWORK_MACH_SERVICES : [])];
  const readRules = [...SYSTEM_READ, ...toolchains, ...read, ...write].map((target) => `(subpath ${sbplString(target)})`).join(' ');
  const writeRules = write.map((target) => `(subpath ${sbplString(target)})`).join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork sysctl-read pseudo-tty)',
    `(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata ${SHM_READ.map((name) => `(ipc-posix-name ${sbplString(name)})`).join(' ')})`,
    `(allow mach-lookup ${mach.map((name) => `(global-name ${sbplString(name)})`).join(' ')})`,
    // A command may signal its own children, never the daemon or another
    // process the same user owns: sandbox-exec execs the command, so $PPID
    // is the unsandboxed host.
    '(allow signal (target same-sandbox))',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${readRules})`,
    `(allow file-write* ${writeRules} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    // IP traffic only. A bare network* also lets a command connect to any
    // Unix socket the user can reach, such as Docker's, which is a way
    // around every file rule here. The one Unix socket allowed is the
    // system resolver's, so names still resolve.
    ...(network
      ? [
        '(allow system-socket)',
        '(allow network-outbound (remote ip) (literal "/private/var/run/mDNSResponder"))',
        '(allow network-inbound (local ip))',
        '(allow network-bind (local ip))',
      ]
      : []),
  ].join('\n');
};

/**
 * What one agent's commands may touch, from the plugin's config (shared
 * keys, overridden or added to per agent under `agents.<id>`).
 */
const within = (target, root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export const sandboxSettings = (config, agentId, workspace, cwd, home = os.homedir()) => {
  const resolved = resolvePluginAgentConfig(config, agentId, { mergeKeys: [] });
  const shared = config ?? {};
  const own = (shared.agents && typeof shared.agents === 'object' ? shared.agents[agentId] : undefined) ?? {};
  // Lists add up: every agent reads the shared paths, and its own besides.
  const raw = (key) => [...strings(shared[key]), ...strings(own[key])].map((target) => path.resolve(expandHome(target, home)));
  // The workspace is checked on its own: a cwd or configured write path
  // must never stand in for a missing one.
  const lexicalWorkspace = typeof workspace === 'string' && workspace.length > 0 ? path.resolve(workspace) : undefined;
  const ownWorkspace = lexicalWorkspace ? real(lexicalWorkspace) : undefined;
  const writePaths = raw('writePaths');
  const extras = [...(typeof cwd === 'string' && cwd.length > 0 ? [path.resolve(cwd)] : []), ...writePaths];
  const roots = ownWorkspace ? [{ lexical: lexicalWorkspace, real: ownWorkspace }, ...writePaths.map((lexical) => ({ lexical, real: real(lexical) }))] : [];
  const write = ownWorkspace ? [ownWorkspace] : [];
  if (ownWorkspace) {
    for (const lexical of extras) {
      const target = real(lexical);
      // A path named inside another writable path can be replaced by the
      // agent, so it may be a symlink the agent planted. Allow it only where
      // it really is inside that path; never promote where it points.
      const parents = roots.filter((root) => root.lexical !== lexical && (within(lexical, root.lexical) || within(lexical, root.real)));
      if (parents.length > 0) {
        const parent = parents.find((root) => within(target, root.real));
        if (!parent) {
          throw new Error(`@stratusagent/plugin-sandbox will not run the command: ${lexical} is inside writable ${parents[0].lexical} but resolves outside it, to ${target}.`);
        }
        continue;
      }
      write.push(target);
    }
  }
  // The same holds for a read path: one named inside a writable path may
  // have been swapped for a symlink to somewhere the agent may not read.
  const read = raw('readPaths').map((lexical) => {
    const target = real(lexical);
    const parents = roots.filter((root) => within(lexical, root.lexical) || within(lexical, root.real));
    if (parents.length > 0 && !parents.some((root) => within(target, root.real))) {
      throw new Error(`@stratusagent/plugin-sandbox will not run the command: read path ${lexical} is inside writable ${parents[0].lexical} but resolves outside it, to ${target}.`);
    }
    return target;
  });
  return {
    workspace: ownWorkspace,
    write: [...new Set(write)],
    read,
    network: resolved.network !== false,
  };
};

export const createPlugin = (config = {}, { developerDir = activeDeveloperDir, spawn = nodeSpawn } = {}) => ({
  name: '@stratusagent/plugin-sandbox',
  setup(context) {
    if (process.platform !== 'darwin') {
      throw new Error(
        '@stratusagent/plugin-sandbox runs commands under macOS sandbox-exec, and this host is not macOS. '
        + 'Remove "executor": "sandbox" and the plugin from the config, or run on macOS.',
      );
    }
    if (!context.executors) {
      throw new Error('This host hands plugins no executor handle, so @stratusagent/plugin-sandbox cannot register one.');
    }
    const workspaces = context.workspaces;
    // Read once: switching Xcode with xcode-select takes a daemon restart.
    const toolchains = toolchainReads(developerDir());
    const spawnFor = (settings) => (command, args, options) => {
      if (!settings.workspace) {
        // No workspace was named for this agent: refuse rather than guess
        // one, and before anything is created on the host.
        throw new Error('@stratusagent/plugin-sandbox has no workspace for this agent, so it will not run the command.');
      }
      // Temporary files go inside the workspace, which is writable, rather
      // than to a shared directory, which isn't.
      const tmp = path.join(settings.workspace, '.tmp');
      mkdirSync(tmp, { recursive: true });
      const profile = sandboxProfile({ ...settings, toolchains });
      return spawn(SANDBOX_EXEC, ['-p', profile, command, ...args], {
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
