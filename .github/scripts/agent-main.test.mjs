import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closure, HOST_PACKAGES, hostManifest, loaderConfig, mainOverrides, pointAtMain, readPacks, strayCopies, stratusDependencies } from './agent-main.mjs';

// What `pnpm pack` makes from agent main, cut down: plugins needs core and
// agents, executor-local needs core and executors, providers needs core.
const pack = (name, dependencies = []) => [`@stratusagent/${name}`, { file: `/packs/stratusagent-${name}-0.13.6.tgz`, version: '0.13.6', dependencies: dependencies.map((dep) => `@stratusagent/${dep}`) }];
const PACKS = new Map([
  pack('agents', ['core']),
  pack('core'),
  pack('executor-local', ['core', 'executors']),
  pack('executors', ['core']),
  pack('plugins', ['core', 'agents']),
  pack('providers', ['core']),
  pack('cli', ['core', 'plugins', 'providers']),
]);
const file = (name) => `file:/packs/stratusagent-${name}-0.13.6.tgz`;

test('only @stratusagent packages count, from every dependency field', () => {
  assert.deepEqual(
    stratusDependencies({
      dependencies: { ajv: '^8', '@stratusagent/providers': '^0.13.6' },
      devDependencies: { '@stratusagent/core': '^0.13.6', '@stratusagent/plugins': '^0.13.6' },
      peerDependencies: { '@stratusagent/core': '^0.13.6' },
      optionalDependencies: { '@stratusagent/state': '^0.13.6' },
    }),
    ['@stratusagent/core', '@stratusagent/plugins', '@stratusagent/providers', '@stratusagent/state'],
  );
  assert.deepEqual(stratusDependencies({ dependencies: { ajv: '^8' } }), []);
});

test('the closure follows main\'s own dependencies, and a package main dropped is an error', () => {
  assert.deepEqual(closure(['@stratusagent/plugins'], PACKS), ['@stratusagent/agents', '@stratusagent/core', '@stratusagent/plugins']);
  assert.deepEqual(closure([], PACKS), []);
  assert.throws(() => closure(['@stratusagent/plugins', '@stratusagent/memory-sqlite'], PACKS), /agent main has no package @stratusagent\/memory-sqlite/);
});

test('a packed package that needs a package main does not pack is an error too, naming both', () => {
  // npm would fetch the released one, and the check would run on a mix.
  const packs = new Map([...PACKS, pack('state', ['core', 'memory-sqlite'])]);
  assert.throws(() => closure(['@stratusagent/state'], packs), /agent main's @stratusagent\/state needs @stratusagent\/memory-sqlite, which agent main does not pack/);
  assert.throws(() => closure(['@stratusagent/plugins'], new Map([...PACKS, pack('agents', ['core', 'gone'])])), /@stratusagent\/agents needs @stratusagent\/gone/);
});

test('a pull request that changes a script the nightly runs runs the nightly', () => {
  const workflow = readFileSync(new URL('../workflows/nightly.yml', import.meta.url), 'utf8');
  const on = workflow.slice(workflow.indexOf('pull_request:'), workflow.indexOf('\npermissions:'));
  const paths = [...on.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]);
  const run = [...workflow.matchAll(/node (\.github\/scripts\/[\w.-]+)/g)].map((match) => match[1]);
  assert.ok(run.length >= 2, `found the scripts it runs: ${run}`);
  for (const script of new Set(run)) assert.ok(paths.includes(script), `${script} is in the pull_request paths (${paths})`);
});

test('main\'s copy is forced for every packed package; one the root names itself is a $ reference to that entry', () => {
  assert.deepEqual(mainOverrides(['@stratusagent/core', '@stratusagent/plugins'], PACKS), {
    '@stratusagent/agents': file('agents'),
    '@stratusagent/cli': file('cli'),
    '@stratusagent/core': '$@stratusagent/core',
    '@stratusagent/executor-local': file('executor-local'),
    '@stratusagent/executors': file('executors'),
    '@stratusagent/plugins': '$@stratusagent/plugins',
    '@stratusagent/providers': file('providers'),
  });
});

test('a package is pointed at main: its own entries in place, every package forced to main\'s through overrides', () => {
  const pkg = {
    name: '@stratusagent/plugin-sandbox',
    dependencies: { '@stratusagent/executor-local': '^0.11.8', '@stratusagent/plugins': '^0.11.8', ajv: '^8.17.1' },
    devDependencies: { '@stratusagent/core': '^0.13.6' },
    scripts: { test: 'node --test' },
  };
  const out = pointAtMain(pkg, PACKS);
  assert.deepEqual(out.dependencies, { '@stratusagent/executor-local': file('executor-local'), '@stratusagent/plugins': file('plugins'), ajv: '^8.17.1' });
  assert.deepEqual(out.devDependencies, { '@stratusagent/core': file('core') });
  // Direct entries are overridden by reference (npm refuses an override that
  // disagrees with a direct dependency); the rest by file.
  assert.deepEqual(out.overrides, mainOverrides(['@stratusagent/core', '@stratusagent/executor-local', '@stratusagent/plugins'], PACKS));
  assert.equal(out.overrides['@stratusagent/core'], '$@stratusagent/core');
  assert.equal(out.overrides['@stratusagent/agents'], file('agents'));
  assert.equal(pkg.dependencies['@stratusagent/plugins'], '^0.11.8', 'the original is left alone');
});

test('a package with no @stratusagent dependency is left as it is', () => {
  const pkg = { name: '@stratusagent/plugin-fleet', scripts: { test: 'node --test' } };
  assert.deepEqual(pointAtMain(pkg, PACKS), pkg);
});

test('a package that names one main no longer has fails, rather than testing against npm\'s', () => {
  assert.throws(() => pointAtMain({ dependencies: { '@stratusagent/provider-openai': '^0.13.6' } }, PACKS), /agent main has no package @stratusagent\/provider-openai/);
});

test('the loader host installs the plugin beside main\'s core and plugins, and forces main\'s copy of every other package', () => {
  const host = hostManifest('@stratusagent/provider-openai', '/work/host/stratusagent-provider-openai-0.14.0.tgz', PACKS);
  assert.deepEqual(host.dependencies, {
    '@stratusagent/provider-openai': 'file:/work/host/stratusagent-provider-openai-0.14.0.tgz',
    '@stratusagent/agents': file('agents'),
    '@stratusagent/core': file('core'),
    '@stratusagent/plugins': file('plugins'),
  });
  // Including core/plugins/agents by reference: a plugin asking for
  // ^0.11.8 (sandbox) would otherwise get its own copies from npm.
  assert.deepEqual(host.overrides, mainOverrides(['@stratusagent/agents', '@stratusagent/core', '@stratusagent/plugins'], PACKS));
  for (const name of HOST_PACKAGES) assert.ok(host.dependencies[name]);
  assert.equal(host.type, 'module');
});

test('loader config: the entry for the package with its placeholders filled in, or {} when it has none', () => {
  const table = {
    '@stratusagent/plugin-a2ui': { catalogs: [{ path: '{package}/test/fixtures/basic_catalog.json' }], note: 'kept {as} is' },
    '@stratusagent/memory-sqlite': { path: '{state}/memory.sqlite', count: 2 },
  };
  const dirs = { packageDir: '/repo/a2ui', stateDir: '/work/state' };
  assert.deepEqual(loaderConfig(table, '@stratusagent/plugin-a2ui', dirs), { catalogs: [{ path: '/repo/a2ui/test/fixtures/basic_catalog.json' }], note: 'kept {as} is' });
  assert.deepEqual(loaderConfig(table, '@stratusagent/memory-sqlite', dirs), { path: '/work/state/memory.sqlite', count: 2 });
  assert.deepEqual(loaderConfig(table, '@stratusagent/plugin-fleet', dirs), {});
});

test('readPacks reads each tarball\'s name, version and @stratusagent run-time dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-main-packs-'));
  const make = (file, pkg) => {
    const src = mkdtempSync(join(tmpdir(), 'agent-main-src-'));
    mkdirSync(join(src, 'package'));
    writeFileSync(join(src, 'package', 'package.json'), JSON.stringify(pkg));
    execFileSync('tar', ['-czf', join(dir, file), '-C', src, 'package']);
  };
  make('stratusagent-plugins-0.13.6.tgz', {
    name: '@stratusagent/plugins',
    version: '0.13.6',
    dependencies: { '@stratusagent/core': '0.13.6', ajv: '^8' },
    peerDependencies: { '@stratusagent/agents': '0.13.6' },
    devDependencies: { '@stratusagent/state': '0.13.6' },
  });
  make('stratusagent-core-0.13.6.tgz', { name: '@stratusagent/core', version: '0.13.6' });
  writeFileSync(join(dir, 'notes.txt'), 'not a tarball');
  const packs = readPacks(dir);
  assert.deepEqual([...packs.keys()], ['@stratusagent/core', '@stratusagent/plugins']);
  assert.deepEqual(packs.get('@stratusagent/plugins'), {
    file: join(dir, 'stratusagent-plugins-0.13.6.tgz'),
    version: '0.13.6',
    dependencies: ['@stratusagent/core', '@stratusagent/agents'],
  });
  assert.deepEqual(packs.get('@stratusagent/core').dependencies, []);
});

test('a copy of a main package from anywhere but main\'s tarball is reported, wherever it is nested', () => {
  const lock = {
    packages: {
      '': { name: 'agent-main-host' },
      'node_modules/@stratusagent/core': { version: '0.13.6', resolved: 'file:../packs/stratusagent-core-0.13.6.tgz' },
      'node_modules/@stratusagent/plugin-sandbox': { version: '0.1.0', resolved: 'file:stratusagent-plugin-sandbox-0.1.0.tgz' },
      'node_modules/@stratusagent/plugin-sandbox/node_modules/@stratusagent/plugins': {
        version: '0.11.10',
        resolved: 'https://registry.npmjs.org/@stratusagent/plugins/-/plugins-0.11.10.tgz',
      },
      'node_modules/ajv': { version: '8.17.1', resolved: 'https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz' },
    },
  };
  assert.deepEqual(strayCopies(lock, PACKS), [
    'node_modules/@stratusagent/plugin-sandbox/node_modules/@stratusagent/plugins 0.11.10 from https://registry.npmjs.org/@stratusagent/plugins/-/plugins-0.11.10.tgz',
  ]);
  delete lock.packages['node_modules/@stratusagent/plugin-sandbox/node_modules/@stratusagent/plugins'];
  assert.deepEqual(strayCopies(lock, PACKS), []);
});

// The Report job's script, run as Actions runs it (bash -eo pipefail) with a
// stub gh that records each call and answers `gh issue list` with `open`.
const runReport = ({ packed, tested, open = '' }) => {
  const workflow = readFileSync(new URL('../workflows/nightly.yml', import.meta.url), 'utf8');
  const lines = workflow.split('\n');
  const step = lines.findIndex((line) => line.trim() === '- name: Open, update or close the issue');
  assert.ok(step > 0, 'found the Report step');
  assert.equal(lines[step + 1].trim(), 'run: |');
  const body = [];
  for (const line of lines.slice(step + 2)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  const dir = mkdtempSync(join(tmpdir(), 'nightly-report-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'report.sh'), body.join('\n'));
  writeFileSync(
    join(dir, 'bin', 'gh'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'issue' && args[1] === 'list') process.stdout.write(process.env.STUB_OPEN);
`,
    { mode: 0o755 },
  );
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'report.sh')], {
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      GH_LOG: log,
      STUB_OPEN: open,
      TITLE: 'Nightly against agent main is failing',
      RUN: 'https://github.com/stratuslabs/plugins/actions/runs/1',
      SHA: 'f0b756d1',
      PACKED: packed,
      TESTED: tested,
    },
  });
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((args) => args[1] !== 'list');
};

test('report: a passing run closes the open issue, and does nothing when none is open', () => {
  assert.deepEqual(runReport({ packed: 'success', tested: 'success', open: '56' }), [
    ['issue', 'close', '56', '--comment', 'Passing again against agent main f0b756d1: https://github.com/stratuslabs/plugins/actions/runs/1'],
  ]);
  assert.deepEqual(runReport({ packed: 'success', tested: 'success' }), []);
});

test('report: a failing plugin job says a plugin fails, and opens the issue when none is open', () => {
  const [call] = runReport({ packed: 'success', tested: 'failure' });
  assert.deepEqual(call.slice(0, 4), ['issue', 'create', '--title', 'Nightly against agent main is failing']);
  assert.equal(call[4], '--body');
  assert.equal(call[5], 'At least one plugin fails against agent main f0b756d1 (failure). The failing jobs name the package and the check: https://github.com/stratuslabs/plugins/actions/runs/1');
});

test('report: a job that never finished, such as one that got no runner, is not called a plugin failing', () => {
  for (const tested of ['abandoned', 'cancelled']) {
    const [call] = runReport({ packed: 'success', tested, open: '56' });
    assert.deepEqual(call.slice(0, 4), ['issue', 'comment', '56', '--body']);
    assert.doesNotMatch(call[4], /fails/, tested);
    assert.match(call[4], new RegExp(`didn't finish against agent main f0b756d1 \\(${tested}\\)`), tested);
    assert.match(call[4], /runs\/1$/, tested);
  }
});

test('report: agent main that did not pack says no plugin was checked', () => {
  const [call] = runReport({ packed: 'failure', tested: 'skipped', open: '56' });
  assert.deepEqual(call, ['issue', 'comment', '56', '--body', "Agent main didn't build or pack (failure), so no plugin was checked: https://github.com/stratuslabs/plugins/actions/runs/1"]);
});
