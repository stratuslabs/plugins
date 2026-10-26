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

test('directories without a package.json, and dot directories, are not packages', () => {
  const { include, problems } = listPackages(repo({
    docs: null,
    '.github': tested(),
    peer: tested(),
  }));
  assert.deepEqual(problems, []);
  assert.deepEqual(include.map((entry) => entry.package), ['peer', 'peer']);
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
