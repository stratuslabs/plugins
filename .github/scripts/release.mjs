// Reads a release tag, <dir>/v<major.minor.patch>, and names the package it
// releases and the runners its tests run on, for the Release workflow.
//
// The tag has to agree with the package: the directory holds a package.json,
// the version there is the tag's version, the name is in the @stratusagent/
// scope, and the package isn't private. Anything else fails before a test
// runs, so a mistyped tag never stages a package.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRunners } from './packages.mjs';

const TAG = /^([a-z0-9][a-z0-9_-]*)\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const SCOPE = '@stratusagent/';

export function resolveRelease(root, tag) {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`${JSON.stringify(tag)} is not a release tag. Use <dir>/v<major.minor.patch>, for example peer/v0.1.0.`);
  const [, dir, version] = match;
  const manifest = join(root, dir, 'package.json');
  if (!existsSync(manifest)) throw new Error(`${dir} has no package.json, so ${tag} names no package.`);
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof pkg.name !== 'string' || !pkg.name.startsWith(SCOPE)) {
    throw new Error(`${dir}/package.json is named ${pkg.name}; this repository publishes only ${SCOPE} packages.`);
  }
  if (pkg.private === true) throw new Error(`${dir}/package.json is private, so it is never published.`);
  if (pkg.version !== version) {
    throw new Error(`${tag} says version ${version}, but ${dir}/package.json is at ${pkg.version}. Tag the commit that bumps it.`);
  }
  const { runners, problem } = packageRunners(dir, pkg);
  if (problem) throw new Error(problem);
  return { dir, name: pkg.name, version, include: runners.map((runner) => ({ package: dir, runner })) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root = '.', tag = ''] = process.argv.slice(2);
  let release;
  try {
    release = resolveRelease(root, tag);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const lines = `dir=${release.dir}\nname=${release.name}\nversion=${release.version}\nmatrix=${JSON.stringify({ include: release.include })}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
}
