// The nightly run is the OS's own timer calling `stratus-backup now`: a
// LaunchAgent on macOS, a systemd user timer on Linux. It needs no daemon
// change, and it runs when the daemon is down, which is when a backup is
// most wanted. Failures land in <home>/logs/backup.log (macOS) or the
// journal (Linux), and in `stratus-backup status` either way.

import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LABEL = 'to.stratus.backup';

const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const parseTime = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) throw new Error(`${JSON.stringify(value)} is not a time like 03:30.`);
  return { hour, minute };
};

/**
 * The command the timer runs, with the same config selection this shell has.
 * Node is found on the PATH the unit carries rather than pinned to
 * process.execPath, which on Homebrew is a versioned Cellar path that the
 * next `brew upgrade` deletes.
 */
export const commandFor = ({ script, configPath }) => ['/usr/bin/env', 'node', script, 'now', ...(configPath ? ['--config', configPath] : [])];

export const launchAgentPlist = ({ command, home, time, workingDirectory, env }) => {
  const environment = Object.entries(env)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join('\n');
  const log = xml(path.join(home, 'logs', 'backup.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${command.map((arg) => `      <string>${xml(arg)}</string>`).join('\n')}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${time.hour}</integer>
      <key>Minute</key>
      <integer>${time.minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${log}</string>
    <key>StandardErrorPath</key>
    <string>${log}</string>
  </dict>
</plist>
`;
};

const systemdQuote = (arg) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
// ExecStart= expands $VAR and ${VAR}, so a literal $ is written $$ there.
// WorkingDirectory= and Environment= do no variable expansion.
const execQuote = (arg) => systemdQuote(arg.replace(/\$/g, '$$$$'));

export const systemdUnits = ({ command, time, workingDirectory, env }) => ({
  service: `[Unit]
Description=Stratus nightly backup

[Service]
Type=oneshot
WorkingDirectory=${systemdQuote(workingDirectory)}
${Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n')}
ExecStart=${command.map(execQuote).join(' ')}
`,
  timer: `[Unit]
Description=Stratus nightly backup

[Timer]
OnCalendar=*-*-* ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}:00
Persistent=true

[Install]
WantedBy=timers.target
`,
});

const run = (command, args, { allowFailure = false } = {}) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error && !allowFailure) reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
      else resolve({ code: error ? 1 : 0, stdout });
    });
  });

const paths = (userHome) => ({
  plist: path.join(userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  service: path.join(userHome, '.config', 'systemd', 'user', 'stratus-backup.service'),
  timer: path.join(userHome, '.config', 'systemd', 'user', 'stratus-backup.timer'),
});

/**
 * Writes the units. With `install: false` (the --dry-run flag) it only
 * returns what it would write, so the generated files can be inspected
 * without touching the service manager.
 */
export const enable = async ({ platform, userHome, home, time, command, workingDirectory, env, install = true }) => {
  const where = paths(userHome);
  if (platform === 'darwin') {
    const contents = launchAgentPlist({ command, home, time, workingDirectory, env });
    if (!install) return { files: { [where.plist]: contents } };
    await mkdir(path.dirname(where.plist), { recursive: true });
    await mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
    await writeFile(where.plist, contents, { mode: 0o644 });
    const domain = `gui/${process.getuid()}`;
    await run('launchctl', ['bootout', `${domain}/${LABEL}`], { allowFailure: true });
    await run('launchctl', ['bootstrap', domain, where.plist]);
    return { files: { [where.plist]: contents } };
  }
  if (platform === 'linux') {
    const units = systemdUnits({ command, time, workingDirectory, env });
    const files = { [where.service]: units.service, [where.timer]: units.timer };
    if (!install) return { files };
    await mkdir(path.dirname(where.service), { recursive: true });
    for (const [file, contents] of Object.entries(files)) await writeFile(file, contents, { mode: 0o644 });
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', 'stratus-backup.timer']);
    return { files };
  }
  throw new Error(`No timer support on ${platform}. Run \`stratus-backup now\` from your own scheduler.`);
};

export const disable = async ({ platform, userHome }) => {
  const where = paths(userHome);
  if (platform === 'darwin') {
    await run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { allowFailure: true });
    await rm(where.plist, { force: true });
    return;
  }
  if (platform === 'linux') {
    await run('systemctl', ['--user', 'disable', '--now', 'stratus-backup.timer'], { allowFailure: true });
    await rm(where.service, { force: true });
    await rm(where.timer, { force: true });
    await run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
    return;
  }
  throw new Error(`No timer support on ${platform}.`);
};
