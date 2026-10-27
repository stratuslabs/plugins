import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { listPackages } from './packages.mjs';

let root;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(packages) {
  root = mkdtempSync(join(tmpdir(), 'plugins-ci-'));
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    if (manifest !== null) writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

const tested = (extra = {}) => ({ name: 'x', scripts: { test: 'node --test' }, ...extra });

test('a package with no os runs on both runners; os picks them otherwise', () => {
  const { include, problems } = listPackages(repo({
    spawn: tested(),
    dreams: tested({ os: ['darwin'] }),
    backup: tested({ os: ['darwin', 'linux'] }),
    server: tested({ os: ['linux'] }),
  }));
  assert.deepEqual(problems, []);
  assert.deepEqual(include, [
    { package: 'backup', runner: 'macos-latest' },
    { package: 'backup', runner: 'ubuntu-latest' },
    { package: 'dreams', runner: 'macos-latest' },
    { package: 'server', runner: 'ubuntu-latest' },
    { package: 'spawn', runner: 'macos-latest' },
    { package: 'spawn', runner: 'ubuntu-latest' },
  ]);
});

test('npm\'s negated os entries block a runner, the way npm reads them', () => {
  const { include, problems } = listPackages(repo({
    anywhere: tested({ os: ['!win32'] }),
    notmac: tested({ os: ['!darwin'] }),
    // A listed platform still has to be the runner's, and a block wins.
    both: tested({ os: ['linux', '!linux', 'darwin'] }),
  }));
  assert.deepEqual(problems, []);
  assert.deepEqual(include, [
    { package: 'anywhere', runner: 'macos-latest' },
    { package: 'anywhere', runner: 'ubuntu-latest' },
    { package: 'both', runner: 'macos-latest' },
    { package: 'notmac', runner: 'ubuntu-latest' },
  ]);
});

test('npm\'s other os forms: a single string, and a sole "any"', () => {
  const { include, problems } = listPackages(repo({
    mac: tested({ os: 'darwin' }),
    any: tested({ os: ['any'] }),
  }));
  assert.deepEqual(problems, []);
  assert.deepEqual(include, [
    { package: 'any', runner: 'macos-latest' },
    { package: 'any', runner: 'ubuntu-latest' },
    { package: 'mac', runner: 'macos-latest' },
  ]);
});

test('an os that blocks every runner fails the listing', () => {
  assert.deepEqual(listPackages(repo({ none: tested({ os: ['!darwin', '!linux'] }) })).problems,
    ['none: its "os" (!darwin, !linux) names no runner this workflow has']);
});

test('directories without a package.json, and dot directories, are not packages', () => {
  const { include, problems } = listPackages(repo({
    docs: null,
    '.github': tested(),
    peer: tested(),
  }));
  assert.deepEqual(problems, []);
  assert.deepEqual(include.map((entry) => entry.package), ['peer', 'peer']);
});

test('on a pull request only the packages it touches run, and every one when CI itself changes', () => {
  const packages = { peer: tested(), spawn: tested({ os: ['linux'] }), docs: null };
  const only = (changed) => listPackages(repo(packages), { changed });
  const peer = only(['peer/index.js', 'peer/test/peer.test.js', 'README.md']);
  assert.deepEqual(peer.problems, []);
  assert.deepEqual(peer.include, [
    { package: 'peer', runner: 'macos-latest' },
    { package: 'peer', runner: 'ubuntu-latest' },
  ]);
  rmSync(root, { recursive: true, force: true });
  assert.equal(only(['.github/workflows/test.yml']).include.length, 3);
  rmSync(root, { recursive: true, force: true });
  // Nothing to test is not a failure: the README alone, or a folder that isn't a package.
  assert.deepEqual(only(['README.md', 'docs/notes.md']), { include: [], problems: [] });
  rmSync(root, { recursive: true, force: true });
  // A file whose name only starts like a package's directory isn't in it.
  assert.deepEqual(only(['peer-notes.md']).include, []);
});

test('a broken package fails the listing even when the pull request does not touch it', () => {
  const { problems } = listPackages(repo({ peer: tested(), quiet: { name: 'quiet' } }), { changed: ['peer/index.js'] });
  assert.deepEqual(problems, ['quiet: package.json has no "test" script']);
});

test('a package with no test script fails the listing instead of being skipped', () => {
  const { problems } = listPackages(repo({ peer: tested(), quiet: { name: 'quiet' } }));
  assert.deepEqual(problems, ['quiet: package.json has no "test" script']);
});

test('an os that names no runner fails the listing', () => {
  const { problems } = listPackages(repo({ win: tested({ os: ['win32'] }) }));
  assert.deepEqual(problems, ['win: its "os" (win32) names no runner this workflow has']);
});

test('a repository with no packages fails the listing', () => {
  const { problems } = listPackages(repo({ docs: null }));
  assert.deepEqual(problems, ['no packages found']);
});

test('one runner per package: Linux where it can run there, macOS only for a package that needs it', () => {
  const { include, problems } = listPackages(repo({
    spawn: tested(),
    sandbox: tested({ os: ['darwin'] }),
    server: tested({ os: ['linux'] }),
  }), { oneRunner: true });
  assert.deepEqual(problems, []);
  assert.deepEqual(include, [
    { package: 'sandbox', runner: 'macos-latest' },
    { package: 'server', runner: 'ubuntu-latest' },
    { package: 'spawn', runner: 'ubuntu-latest' },
  ]);
});

test('one runner per package on a pull request: only the touched packages, macOS only where needed', () => {
  const packages = { spawn: tested(), sandbox: tested({ os: ['darwin'] }), peer: tested() };
  const { include, problems } = listPackages(repo(packages), {
    changed: ['spawn/index.js', 'sandbox/index.js'],
    oneRunner: true,
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(include, [
    { package: 'sandbox', runner: 'macos-latest' },
    { package: 'spawn', runner: 'ubuntu-latest' },
  ]);
  rmSync(root, { recursive: true, force: true });
  // A change to CI itself runs every package, still on one runner each.
  assert.deepEqual(listPackages(repo(packages), { changed: ['.github/workflows/test.yml'], oneRunner: true }).include, [
    { package: 'peer', runner: 'ubuntu-latest' },
    { package: 'sandbox', runner: 'macos-latest' },
    { package: 'spawn', runner: 'ubuntu-latest' },
  ]);
});
