import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * The macOS sandbox an experiment runs in. The experimenter's `claude -p`
 * can Edit and Write anywhere its cwd reaches, and evaluate.sh runs what it
 * wrote, so the whole `overnight run` process tree runs under a profile
 * that denies by default: it reads the system, the experiment, the tools'
 * own install directories and what the operator lists; it writes only
 * what the experimenter itself has to (workspace/, best/,
 * experiments.jsonl, report.html) plus a private home and tmp. evaluate.sh
 * and program.md are not writable, and the operator's ~/.claude, keys and
 * the Stratus home are not readable. Network stays on: claude needs the API.
 *
 * Modeled on @stratusagent/plugin-sandbox's profile; kept separate so this
 * plugin does not depend on another plugin's internals.
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const SYSTEM_READ = [
  '/usr', '/bin', '/sbin', '/System', '/Library', '/opt/homebrew', '/usr/local',
  '/private/etc', '/private/var/db', '/dev', '/Applications/Xcode.app',
];

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
  'com.apple.dnssd.service',
];

/** Under the operator's home: never readable, whatever a read path covers. */
export const HOME_SECRETS = [
  '.ssh', '.aws', '.azure', '.claude', '.claude.json', '.codex', '.config/gh', '.config/gcloud', '.config/op',
  '.docker', '.fly', '.git-credentials', '.gnupg', '.kube', '.netrc', '.npmrc', '.password-store', '.pypirc',
  'Library/Keychains', '.stratus',
];

const sbpl = (value) => {
  if (/["\\\n\r\0]/.test(value)) {
    throw new Error(`@stratusagent/plugin-dreams cannot express the path ${JSON.stringify(value)} in a sandbox profile.`);
  }
  return `"${value}"`;
};

export const real = (target) => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

const subpaths = (list) => list.map((target) => `(subpath ${sbpl(target)})`).join(' ');
const literals = (list) => list.map((target) => `(literal ${sbpl(target)})`).join(' ');

/**
 * One experiment's profile. `deny` comes after every allow and SBPL's last
 * matching rule wins, so a read path that happens to cover a secret does
 * not open it; `own` comes last of all, because the plugin's private home
 * lives in its state directory, inside the protected Stratus home.
 */
export const experimentProfile = ({ experimentDir, home, tmp, read = [], deny = [] }) => {
  const writeDirs = [path.join(experimentDir, 'workspace'), path.join(experimentDir, 'best')];
  const writeFiles = [path.join(experimentDir, 'experiments.jsonl'), path.join(experimentDir, 'report.html')];
  const own = [home, tmp];
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork sysctl-read pseudo-tty)',
    '(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata (ipc-posix-name "apple.shm.notification_center"))',
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${sbpl(name)})`).join(' ')})`,
    '(allow signal (target same-sandbox))',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${subpaths([...SYSTEM_READ, ...read, experimentDir])})`,
    `(allow file-write* ${subpaths(writeDirs)} ${literals(writeFiles)} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    '(allow system-socket)',
    '(allow network-outbound (remote ip) (literal "/private/var/run/mDNSResponder"))',
    ...(deny.length > 0 ? [`(deny file-read* file-write* ${subpaths(deny)})`] : []),
    `(allow file-read* file-write* ${subpaths(own)})`,
  ].join('\n');
};

const executable = (file) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** An absolute path to `name`: the configured one, or the first on `searchPath`. */
export const findTool = (name, configured, searchPath) => {
  if (configured) {
    if (!executable(configured)) {
      throw new Error(`@stratusagent/plugin-dreams: ${configured} is not an executable ${name}.`);
    }
    return configured;
  }
  for (const dir of (searchPath ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(dir, name);
    if (executable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `@stratusagent/plugin-dreams cannot find ${name} on the daemon's PATH. Install it, or set "${name}Path" in the plugin's config.`,
  );
};

const within = (target, root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * What a tool needs readable: the directory above the one its real binary
 * sits in (a venv, a pip --user base, ~/.local/share/claude), never the
 * home itself or anything above it.
 */
export const installRoot = (tool, home) => {
  const binary = real(tool);
  for (const candidate of [path.dirname(path.dirname(binary)), path.dirname(binary)]) {
    if (candidate !== path.parse(candidate).root && !within(home, candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `@stratusagent/plugin-dreams will not open ${path.dirname(binary)} to the experiment just to run ${path.basename(tool)}: `
    + 'it is your home directory or above it. Install the tool somewhere of its own.',
  );
};

/** Whether this host lets this process apply a sandbox (it does not inside another sandbox). */
export const sandboxAvailable = async (spawn) => new Promise((resolve) => {
  try {
    const child = spawn(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  } catch {
    resolve(false);
  }
});
