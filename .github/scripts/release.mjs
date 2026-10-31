// Reads a release tag, <dir>/v<major.minor.patch>, and names the package it
// releases and the runners its tests run on, for the Release workflow.
//
// The tag has to agree with the package: the directory holds a package.json,
// the version there is the tag's version, the name is in the @stratusagent/
// scope, the package isn't private, and its repository is this GitHub
// repository (npm trusted publishing refuses a package whose repository.url
// is anything else), and it ships under Apache-2.0 with a LICENSE file of its
// own (npm packs a package's directory, not the repository root). Anything
// else fails before a test runs, so a mistyped tag never stages a package.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRunners } from './packages.mjs';

const TAG = /^([a-z0-9][a-z0-9_-]*)\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const SCOPE = '@stratusagent/';
const LICENSE_ID = 'Apache-2.0';
// npm's rule for a new scoped name: lowercase, URL-safe, no leading dot or
// underscore, 214 characters at most. It also keeps line breaks out of the
// name, which goes into $GITHUB_OUTPUT one name=value per line.
const NAME = /^@stratusagent\/[a-z0-9~-][a-z0-9._~-]*$/;

// npm compares repository.url with the repository in the workflow's OIDC
// token, case-sensitively. These are the spellings of it npm writes and reads.
function repositoryProblem(dir, pkg, repository) {
  const expected = `https://github.com/${repository}`;
  const url = typeof pkg.repository === 'object' && pkg.repository !== null ? pkg.repository.url : undefined;
  if (typeof url !== 'string') {
    return `${dir}/package.json has no repository.url. npm trusted publishing stages a package only when it is ${expected}.`;
  }
  if (![expected, `${expected}.git`, `git+${expected}.git`].includes(url)) {
    return `${dir}/package.json has repository.url ${JSON.stringify(url)}; npm trusted publishing stages a package only when it is ${expected}.`;
  }
  if (pkg.repository.directory !== dir) {
    return `${dir}/package.json has repository.directory ${JSON.stringify(pkg.repository.directory)}; it should be "${dir}".`;
  }
  return undefined;
}

export function resolveRelease(root, tag, repository) {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`${JSON.stringify(tag)} is not a release tag. Use <dir>/v<major.minor.patch>, for example peer/v0.1.0.`);
  const [, dir, version] = match;
  const manifest = join(root, dir, 'package.json');
  if (!existsSync(manifest)) throw new Error(`${dir} has no package.json, so ${tag} names no package.`);
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof pkg.name !== 'string' || !pkg.name.startsWith(SCOPE)) {
    throw new Error(`${dir}/package.json is named ${pkg.name}; this repository publishes only ${SCOPE} packages.`);
  }
  if (!NAME.test(pkg.name) || pkg.name.length > 214) {
    throw new Error(`${dir}/package.json is named ${JSON.stringify(pkg.name)}; this repository publishes only ${SCOPE} packages with a valid npm name (lowercase letters, digits, - . _ ~).`);
  }
  if (pkg.private === true) throw new Error(`${dir}/package.json is private, so it is never published.`);
  if (pkg.version !== version) {
    throw new Error(`${tag} says version ${version}, but ${dir}/package.json is at ${pkg.version}. Tag the commit that bumps it.`);
  }
  const repoProblem = repositoryProblem(dir, pkg, repository);
  if (repoProblem) throw new Error(repoProblem);
  if (pkg.license !== LICENSE_ID) {
    throw new Error(`${dir}/package.json has license ${JSON.stringify(pkg.license)}; packages here are ${LICENSE_ID}.`);
  }
  if (!existsSync(join(root, dir, 'LICENSE'))) {
    throw new Error(`${dir} has no LICENSE file, so its npm package would ship without the license text.`);
  }
  const { runners, problem } = packageRunners(dir, pkg);
  if (problem) throw new Error(problem);
  return { dir, name: pkg.name, version, include: runners.map((runner) => ({ package: dir, runner })) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root = '.', tag = ''] = process.argv.slice(2);
  let release;
  try {
    release = resolveRelease(root, tag, process.env.GITHUB_REPOSITORY || 'stratuslabs/plugins');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const lines = `dir=${release.dir}\nname=${release.name}\nversion=${release.version}\nmatrix=${JSON.stringify({ include: release.include })}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
}
