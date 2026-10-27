// Lists the plugin packages (top-level directories with a package.json) and
// the runners their tests run on, as a GitHub Actions matrix.
//
// A package's "os" field picks the runners, read the way npm reads it:
// darwin is macos-latest, linux is ubuntu-latest, "!name" blocks one, and a
// package with no "os" runs on both. A package with no test script, or
// whose "os" leaves no runner, fails the listing instead of being skipped
// without a word.
//
// Given the files a pull request changes, only the packages it touches run,
// and every package runs when it changes CI itself (.github/). Pushes to
// main run everything. Every package is still checked, touched or not.
// --one-runner keeps one runner per package (the nightly run's choice).

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUNNERS = { darwin: 'macos-latest', linux: 'ubuntu-latest' };

/**
 * Whether npm would install a package with this "os" on this platform: the
 * same rules as npm-install-checks' checkList. A string is a list of one, a
 * sole "any" allows everything, "!name" blocks name, and once any entry is a
 * plain name, only the platforms named are allowed.
 */
export function osAllows(os, platform) {
  const list = typeof os === 'string' ? [os] : Array.isArray(os) ? os.filter((entry) => typeof entry === 'string') : [];
  if (list.length === 1 && list[0] === 'any') return true;
  let negated = 0;
  let match = false;
  for (const entry of list) {
    if (entry.startsWith('!')) {
      negated += 1;
      if (entry.slice(1) === platform) return false;
    } else if (entry === platform) {
      match = true;
    }
  }
  return match || negated === list.length;
}

/**
 * The runners a package's tests run on, or why it can't be tested here: no
 * test script, or an "os" that leaves no runner.
 */
export function packageRunners(dir, pkg) {
  if (!pkg.scripts?.test) return { problem: `${dir}: package.json has no "test" script` };
  const runners = Object.keys(RUNNERS).filter((name) => osAllows(pkg.os, name)).map((name) => RUNNERS[name]);
  if (runners.length === 0) return { problem: `${dir}: its "os" (${[pkg.os].flat().join(', ')}) names no runner this workflow has` };
  return { runners };
}

/**
 * oneRunner: each package on one runner only, Linux when it can run there,
 * for the nightly run, which checks agent main rather than the platforms
 * (and macOS minutes cost more).
 */
export function listPackages(root, { changed, oneRunner = false } = {}) {
  const include = [];
  const problems = [];
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { runners, problem } = packageRunners(dir, JSON.parse(readFileSync(manifest, 'utf8')));
    if (problem) {
      problems.push(problem);
      continue;
    }
    const picked = oneRunner ? [runners.includes(RUNNERS.linux) ? RUNNERS.linux : runners[0]] : runners;
    for (const runner of picked) include.push({ package: dir, runner });
  }
  if (problems.length === 0 && include.length === 0) problems.push('no packages found');
  if (changed === undefined || changed.some((file) => file.startsWith('.github/'))) return { include, problems };
  return { include: include.filter((entry) => changed.some((file) => file.startsWith(`${entry.package}/`))), problems };
}

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changedFile = flag('--changed');
  const changed = changedFile === undefined
    ? undefined
    : readFileSync(changedFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.';
  const { include, problems } = listPackages(root, { changed, oneRunner: process.argv.includes('--one-runner') });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  const lines = `matrix=${JSON.stringify({ include })}\nany=${include.length > 0}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
}
