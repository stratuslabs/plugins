import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { resolveRelease } from './release.mjs';

let root;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(packages) {
  root = mkdtempSync(join(tmpdir(), 'plugins-release-'));
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    if (manifest !== null) writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

const pkg = (extra = {}) => ({
  name: '@stratusagent/plugin-peer',
  version: '0.1.0',
  scripts: { test: 'node --test' },
  ...extra,
});

test('a tag <dir>/v<version> names the package in that directory and the runners it is tested on', () => {
  const release = resolveRelease(repo({ peer: pkg(), dreams: pkg({ name: '@stratusagent/plugin-dreams', os: ['darwin'] }) }), 'peer/v0.1.0');
  assert.deepEqual(release, {
    dir: 'peer',
    name: '@stratusagent/plugin-peer',
    version: '0.1.0',
    include: [
      { package: 'peer', runner: 'macos-latest' },
      { package: 'peer', runner: 'ubuntu-latest' },
    ],
  });
  assert.deepEqual(resolveRelease(root, 'dreams/v0.1.0').include, [{ package: 'dreams', runner: 'macos-latest' }]);
});

test('the version in the tag must be the version in package.json', () => {
  assert.throws(() => resolveRelease(repo({ peer: pkg({ version: '0.1.1' }) }), 'peer/v0.1.0'),
    /peer\/v0\.1\.0 says version 0\.1\.0, but peer\/package\.json is at 0\.1\.1/);
});

test('only @stratusagent packages publish from here, and never a private one', () => {
  assert.throws(() => resolveRelease(repo({ peer: pkg({ name: 'stratus-plugin-peer' }) }), 'peer/v0.1.0'),
    /peer\/package\.json is named stratus-plugin-peer; this repository publishes only @stratusagent\/ packages/);
  assert.throws(() => resolveRelease(repo({ peer: pkg({ private: true }) }), 'peer/v0.1.0'),
    /peer\/package\.json is private/);
});

test('a tag that is not <dir>/v<major.minor.patch> is refused, prereleases included', () => {
  repo({ peer: pkg() });
  for (const tag of ['v0.1.0', 'peer@0.1.0', 'peer/0.1.0', 'peer/v0.1', 'peer/v0.1.0-rc.1', 'peer/v01.1.0', 'a/b/v0.1.0', '../peer/v0.1.0', '.github/v0.1.0', 'peer/v0.1.0 ']) {
    assert.throws(() => resolveRelease(root, tag), /is not a release tag/, tag);
  }
});

test('a directory with no package.json is not a package', () => {
  assert.throws(() => resolveRelease(repo({ docs: null }), 'docs/v0.1.0'), /docs has no package\.json/);
  assert.throws(() => resolveRelease(root, 'missing/v0.1.0'), /missing has no package\.json/);
});

test('a package that cannot be tested is not released', () => {
  assert.throws(() => resolveRelease(repo({ peer: pkg({ scripts: {} }) }), 'peer/v0.1.0'), /peer: package\.json has no "test" script/);
  assert.throws(() => resolveRelease(repo({ peer: pkg({ os: ['win32'] }) }), 'peer/v0.1.0'), /peer: its "os" \(win32\) names no runner/);
});
