import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { allow, init, now, readSettings, repoDir, shownRemote, status } from './backup.js';
import { restore } from './restore.js';
import { commandFor, disable, enable, parseTime } from './timer.js';

const USAGE = `stratus-backup: a nightly copy of ~/.stratus in a private git repository

  stratus-backup init <remote> [--branch <name>]   set up; one branch per machine (default: hostname)
  stratus-backup now [--config <file>]             snapshot, redact, commit, push
  stratus-backup status                            the remote, the branch, the last run
  stratus-backup restore <dir> [--commit <sha>] [--remote <url> --branch <name>] [--offline]
                                                   restore into an empty or new directory
  stratus-backup enable [--at 03:30] [--dry-run]   run nightly from launchd or systemd
  stratus-backup disable                           remove the nightly run
  stratus-backup allow <finding-id>                accept a scan finding that is not a secret
`;

const homeOf = (env) => path.join(env.HOME || os.homedir(), '.stratus');

export const main = async (argv, { env = process.env, out = console.log, cwd = process.cwd(), scriptPath } = {}) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      branch: { type: 'string' },
      config: { type: 'string' },
      commit: { type: 'string' },
      offline: { type: 'boolean' },
      remote: { type: 'string' },
      at: { type: 'string', default: '03:30' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, argument] = positionals;
  const home = homeOf(env);
  if (values.help || command === undefined) {
    out(USAGE);
    return;
  }
  switch (command) {
    case 'init': {
      if (!argument) throw new Error('Name the private repository: stratus-backup init <remote>');
      const result = await init(home, argument, { branch: values.branch });
      out(`Backing up ${home} to ${shownRemote(argument)}, branch ${result.branch}${result.adopted ? ' (continuing its existing history)' : ''}.`);
      out('Run `stratus-backup now` to take the first snapshot, and `stratus-backup enable` to run it nightly.');
      return;
    }
    case 'now': {
      const result = await now(home, { configPath: values.config, env, cwd });
      const head = result.commit ? result.commit.slice(0, 12) : 'none';
      out(result.unchanged ? `No changes since the last snapshot (${head}).` : `Snapshot ${head} committed.`);
      out(result.pushed ? 'Pushed.' : 'Remote already up to date.');
      if (result.replaced > 0) out(`Replaced ${result.replaced} occurrence(s) of stored secrets.`);
      for (const item of result.skipped) out(`Skipped ${item.path}: ${item.reason}.`);
      if (result.manifest.soulsWithoutId.length > 0) {
        out(`Souls with no id or name in their frontmatter (${result.manifest.soulsWithoutId.join(', ')}) get an id from their file path, `
          + 'so a restore to another path would not find their memories. Add `id:` to each.');
      }
      return;
    }
    case 'status': {
      const result = await status(home);
      if (!result.configured) {
        out('Not set up. Run `stratus-backup init <remote>`.');
        return;
      }
      out(`Remote ${shownRemote(result.settings.remote)}, branch ${result.settings.branch}.`);
      if (!result.last) out('No run yet.');
      else if (result.last.ok) out(`Last run ${result.last.lastRun}: ok, ${result.last.commit?.slice(0, 12)}${result.last.pushed ? ', pushed' : ''}.`);
      else out(`Last run ${result.last.lastRun}: FAILED. ${result.last.error}`);
      return;
    }
    case 'restore': {
      if (!argument) throw new Error('Name the directory to restore into: stratus-backup restore <dir>');
      let options = { remote: values.remote, branch: values.branch, commit: values.commit, offline: values.offline === true };
      if (!values.remote) {
        const settings = await readSettings(home);
        options = { repo: repoDir(home), branch: values.branch ?? settings.branch, commit: values.commit, offline: values.offline === true };
      }
      const result = await restore(path.resolve(cwd, argument), options);
      out(`Restored ${result.commit.slice(0, 12)} into ${path.resolve(cwd, argument)}.`);
      out('Credentials are never backed up: sign in again with `stratus setup` and re-add named credentials and Slack tokens.');
      if (result.manifest.redactedConfigPaths?.length > 0) {
        out(`These config values were redacted and need filling back in: ${result.manifest.redactedConfigPaths.join(', ')}.`);
      }
      if (result.manifest.config && result.manifest.config.source !== 'default') {
        out(`The config came from ${result.manifest.config.path} (${result.manifest.config.source}); it is restored as config.json.`);
      }
      out('The memory index rebuilds on first use. Move the directory to ~/.stratus with the daemon stopped.');
      return;
    }
    case 'enable': {
      await readSettings(home);
      const script = scriptPath ?? realpathSync(process.argv[1]);
      // The unit runs from the user home, so a relative path is fixed here, where it was meant.
      const configPath = values.config ? path.resolve(cwd, values.config) : (env.STRATUS_CONFIG ? path.resolve(cwd, env.STRATUS_CONFIG) : undefined);
      const result = await enable({
        platform: process.platform,
        userHome: env.HOME || os.homedir(),
        home,
        time: parseTime(values.at),
        command: commandFor({ script, configPath }),
        workingDirectory: env.HOME || os.homedir(),
        env: { HOME: env.HOME || os.homedir(), PATH: env.PATH ?? '/usr/bin:/bin' },
        install: !values['dry-run'],
      });
      for (const [file, contents] of Object.entries(result.files)) {
        out(values['dry-run'] ? `Would write ${file}:\n${contents}` : `Wrote ${file}.`);
      }
      if (!values['dry-run']) out(`Backups run nightly at ${values.at}.`);
      return;
    }
    case 'disable':
      await disable({ platform: process.platform, userHome: env.HOME || os.homedir() });
      out('Nightly backups are off. The repository and its history are untouched.');
      return;
    case 'allow':
      if (!argument) throw new Error('Name the finding id: stratus-backup allow <id>');
      await allow(home, argument);
      out(`Finding ${argument} will no longer stop a backup.`);
      return;
    default:
      throw new Error(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`);
  }
};
