import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const LICENSE_TEXT = 'Apache License\nVersion 2.0, January 2004\n';
const NOTICE_TEXT = 'Stratus Agent plugins\nCopyright 2026 Stratus Labs\n';

function repo(packages) {
  root = mkdtempSync(join(tmpdir(), 'plugins-release-'));
  writeFileSync(join(root, 'LICENSE'), LICENSE_TEXT);
  writeFileSync(join(root, 'NOTICE'), NOTICE_TEXT);
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    if (manifest !== null) {
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
      writeFileSync(join(root, dir, 'LICENSE'), LICENSE_TEXT);
      writeFileSync(join(root, dir, 'NOTICE'), NOTICE_TEXT);
    }
  }
  return root;
}

const pkg = (extra = {}, dir = 'peer') => ({
  name: '@stratusagent/plugin-peer',
  version: '0.1.0',
  license: 'Apache-2.0',
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

test('a package name npm would refuse is refused before it reaches a workflow output', () => {
  // The name goes into $GITHUB_OUTPUT, which is one name=value per line, so a
  // line break in it would write a second output (dir=..., say) for the stage job.
  for (const name of ['@stratusagent/foo\ndir=spawn', '@stratusagent/foo\rdir=spawn', '@stratusagent/Plugin-Peer', '@stratusagent/plugin peer', '@stratusagent/.hidden', '@stratusagent/']) {
    assert.throws(() => resolve(repo({ peer: pkg({ name }) }), 'peer/v0.1.0'),
      /peer\/package\.json is named .* this repository publishes only @stratusagent\/ packages with a valid npm name/s, JSON.stringify(name));
  }
  assert.throws(() => resolve(repo({ peer: pkg({ name: `@stratusagent/${'a'.repeat(201)}` }) }), 'peer/v0.1.0'), /valid npm name/);
  assert.equal(resolve(repo({ peer: pkg({ name: '@stratusagent/plugin-peer.v2_x~y' }) }), 'peer/v0.1.0').name, '@stratusagent/plugin-peer.v2_x~y');
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

test('a package ships under Apache-2.0 with its own LICENSE file', () => {
  assert.throws(() => resolve(repo({ peer: pkg({ license: 'MIT' }) }), 'peer/v0.1.0'),
    /peer\/package\.json has license "MIT"; packages here are Apache-2\.0/);
  assert.throws(() => resolve(repo({ peer: pkg({ license: undefined }) }), 'peer/v0.1.0'),
    /peer\/package\.json has license undefined; packages here are Apache-2\.0/);
  const dir = repo({ peer: pkg() });
  rmSync(join(dir, 'peer', 'LICENSE'));
  assert.throws(() => resolve(dir, 'peer/v0.1.0'), /peer has no LICENSE file/);
});

test("a package's LICENSE is the repository's Apache 2.0 text, byte for byte", () => {
  const dir = repo({ peer: pkg() });
  for (const text of ['MIT License\n\nCopyright (c) 2026 Stratus Labs\n', '', LICENSE_TEXT.slice(0, 10), `${LICENSE_TEXT}\n`]) {
    writeFileSync(join(dir, 'peer', 'LICENSE'), text);
    assert.throws(() => resolve(dir, 'peer/v0.1.0'), /peer\/LICENSE is not the Apache 2\.0 text in the repository's LICENSE/);
  }
  writeFileSync(join(dir, 'peer', 'LICENSE'), LICENSE_TEXT);
  assert.doesNotThrow(() => resolve(dir, 'peer/v0.1.0'));
});

test("a package ships a NOTICE that starts with the repository's NOTICE, and may add attributions after it", () => {
  const dir = repo({ peer: pkg() });
  rmSync(join(dir, 'peer', 'NOTICE'));
  assert.throws(() => resolve(dir, 'peer/v0.1.0'), /peer has no NOTICE file/);
  for (const text of ['', 'Something else\n', NOTICE_TEXT.slice(0, 12)]) {
    writeFileSync(join(dir, 'peer', 'NOTICE'), text);
    assert.throws(() => resolve(dir, 'peer/v0.1.0'), /peer\/NOTICE does not start with the repository's NOTICE/);
  }
  writeFileSync(join(dir, 'peer', 'NOTICE'), `${NOTICE_TEXT}\nThis package includes files from A2UI, licensed under Apache 2.0.\n`);
  assert.doesNotThrow(() => resolve(dir, 'peer/v0.1.0'));
});

test('npm packs both LICENSE and NOTICE, so "files" has to name NOTICE', () => {
  const dir = repo({ peer: pkg({ files: ['index.js'] }) });
  writeFileSync(join(dir, 'peer', 'index.js'), 'export default {};\n');
  assert.throws(() => resolve(dir, 'peer/v0.1.0'), /npm pack leaves NOTICE out of peer\. Add "NOTICE" to "files" in peer\/package\.json/);
  writeFileSync(join(dir, 'peer', 'package.json'), JSON.stringify(pkg({ files: ['index.js', 'NOTICE'] })));
  assert.doesNotThrow(() => resolve(dir, 'peer/v0.1.0'));
});

test("the repository's LICENSE is the Apache License 2.0 text from apache.org, unmodified", () => {
  root = undefined;
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sha256 = createHash('sha256').update(readFileSync(join(here, 'LICENSE'))).digest('hex');
  // https://www.apache.org/licenses/LICENSE-2.0.txt
  assert.equal(sha256, 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
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
