import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { resolveRelease } from './release.mjs';

let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

const REPO = 'stratuslabs/plugins';
const resolve = (dir, tag) => resolveRelease(dir, tag, REPO);

function repo(packages) {
  root = mkdtempSync(join(tmpdir(), 'plugins-release-'));
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    if (manifest !== null) writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

const pkg = (extra = {}, dir = 'peer') => ({
  name: '@stratusagent/plugin-peer',
  version: '0.1.0',
  scripts: { test: 'node --test' },
  repository: { type: 'git', url: 'git+https://github.com/stratuslabs/plugins.git', directory: dir },
  ...extra,
});

test('a tag <dir>/v<version> names the package in that directory and the runners it is tested on', () => {
  const release = resolve(repo({ peer: pkg(), dreams: pkg({ name: '@stratusagent/plugin-dreams', os: ['darwin'] }, 'dreams') }), 'peer/v0.1.0');
  assert.deepEqual(release, {
    dir: 'peer',
    name: '@stratusagent/plugin-peer',
    version: '0.1.0',
    include: [
      { package: 'peer', runner: 'macos-latest' },
      { package: 'peer', runner: 'ubuntu-latest' },
    ],
  });
  assert.deepEqual(resolve(root, 'dreams/v0.1.0').include, [{ package: 'dreams', runner: 'macos-latest' }]);
});

test('the version in the tag must be the version in package.json', () => {
  assert.throws(() => resolve(repo({ peer: pkg({ version: '0.1.1' }) }), 'peer/v0.1.0'),
    /peer\/v0\.1\.0 says version 0\.1\.0, but peer\/package\.json is at 0\.1\.1/);
});

test('only @stratusagent packages publish from here, and never a private one', () => {
  assert.throws(() => resolve(repo({ peer: pkg({ name: 'stratus-plugin-peer' }) }), 'peer/v0.1.0'),
    /peer\/package\.json is named stratus-plugin-peer; this repository publishes only @stratusagent\/ packages/);
  assert.throws(() => resolve(repo({ peer: pkg({ private: true }) }), 'peer/v0.1.0'),
    /peer\/package\.json is private/);
});

test('a tag that is not <dir>/v<major.minor.patch> is refused, prereleases included', () => {
  repo({ peer: pkg() });
  for (const tag of ['v0.1.0', 'peer@0.1.0', 'peer/0.1.0', 'peer/v0.1', 'peer/v0.1.0-rc.1', 'peer/v01.1.0', 'a/b/v0.1.0', '../peer/v0.1.0', '.github/v0.1.0', 'peer/v0.1.0 ']) {
    assert.throws(() => resolve(root, tag), /is not a release tag/, tag);
  }
});

test('a directory with no package.json is not a package', () => {
  assert.throws(() => resolve(repo({ docs: null }), 'docs/v0.1.0'), /docs has no package\.json/);
  assert.throws(() => resolve(root, 'missing/v0.1.0'), /missing has no package\.json/);
});

test('a package that cannot be tested is not released', () => {
  assert.throws(() => resolve(repo({ peer: pkg({ scripts: {} }) }), 'peer/v0.1.0'), /peer: package\.json has no "test" script/);
  assert.throws(() => resolve(repo({ peer: pkg({ os: ['win32'] }) }), 'peer/v0.1.0'), /peer: its "os" \(win32\) names no runner/);
});

test('npm trusted publishing needs repository.url to be this GitHub repository', () => {
  assert.throws(() => resolve(repo({ peer: pkg({ repository: undefined }) }), 'peer/v0.1.0'),
    /peer\/package\.json has no repository\.url\. npm trusted publishing stages a package only when it is https:\/\/github\.com\/stratuslabs\/plugins/);
  for (const url of ['git+https://github.com/stratuslabs/agent.git', 'https://github.com/StratusLabs/plugins', 'github:stratuslabs/plugins', 'git@github.com:stratuslabs/plugins.git']) {
    assert.throws(() => resolve(repo({ peer: pkg({ repository: { type: 'git', url, directory: 'peer' } }) }), 'peer/v0.1.0'),
      /peer\/package\.json has repository\.url .*; npm trusted publishing stages a package only when it is https:\/\/github\.com\/stratuslabs\/plugins/, url);
  }
  assert.throws(() => resolve(repo({ peer: pkg({ repository: 'https://github.com/stratuslabs/plugins' }) }), 'peer/v0.1.0'),
    /peer\/package\.json has no repository\.url/);
  for (const url of ['git+https://github.com/stratuslabs/plugins.git', 'https://github.com/stratuslabs/plugins', 'https://github.com/stratuslabs/plugins.git']) {
    assert.equal(resolve(repo({ peer: pkg({ repository: { type: 'git', url, directory: 'peer' } }) }), 'peer/v0.1.0').name, '@stratusagent/plugin-peer', url);
  }
});

test('repository.directory names the package directory, so npm links its source', () => {
  assert.throws(() => resolve(repo({ peer: pkg({}, 'dreams') }), 'peer/v0.1.0'),
    /peer\/package\.json has repository\.directory "dreams"; it should be "peer"/);
  assert.throws(() => resolve(repo({ peer: pkg({ repository: { type: 'git', url: 'https://github.com/stratuslabs/plugins' } }) }), 'peer/v0.1.0'),
    /peer\/package\.json has repository\.directory undefined; it should be "peer"/);
});

test('every package in this repository can be tagged for release as it stands', () => {
  root = undefined;
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dirs = readdirSync(here, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(here, entry.name, 'package.json')));
  assert.ok(dirs.length > 0);
  for (const { name: dir } of dirs) {
    const { version } = JSON.parse(readFileSync(join(here, dir, 'package.json'), 'utf8'));
    assert.doesNotThrow(() => resolve(here, `${dir}/v${version}`), dir);
  }
});
