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

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUNNERS = { darwin: 'macos-latest', linux: 'ubuntu-latest' };

export function listPackages(root, { changed } = {}) {
  const include = [];
  const problems = [];
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!pkg.scripts?.test) {
      problems.push(`${dir}: package.json has no "test" script`);
      continue;
    }
    // npm's reading: "!name" blocks a platform, and once any entry is a
    // plain name, only the platforms named are allowed.
    const os = Array.isArray(pkg.os) ? pkg.os.filter((entry) => typeof entry === 'string') : [];
    const allowed = os.filter((entry) => !entry.startsWith('!'));
    const blocked = new Set(os.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1)));
    const runners = Object.keys(RUNNERS)
      .filter((name) => !blocked.has(name) && (allowed.length === 0 || allowed.includes(name)))
      .map((name) => RUNNERS[name]);
    if (runners.length === 0) {
      problems.push(`${dir}: its "os" (${os.join(', ')}) names no runner this workflow has`);
      continue;
    }
    for (const runner of runners) include.push({ package: dir, runner });
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
  const { include, problems } = listPackages(root, { changed });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  const lines = `matrix=${JSON.stringify({ include })}\nany=${include.length > 0}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
}
