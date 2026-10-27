import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closure, HOST_PACKAGES, hostManifest, loaderConfig, pointAtMain, readPacks, stratusDependencies } from './agent-main.mjs';

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

test('a package is pointed at main: its own entries in place, everything they pull in through overrides', () => {
  const pkg = {
    name: '@stratusagent/plugin-sandbox',
    dependencies: { '@stratusagent/executor-local': '^0.11.8', '@stratusagent/plugins': '^0.11.8', ajv: '^8.17.1' },
    devDependencies: { '@stratusagent/core': '^0.13.6' },
    scripts: { test: 'node --test' },
  };
  const out = pointAtMain(pkg, PACKS);
  assert.deepEqual(out.dependencies, { '@stratusagent/executor-local': file('executor-local'), '@stratusagent/plugins': file('plugins'), ajv: '^8.17.1' });
  assert.deepEqual(out.devDependencies, { '@stratusagent/core': file('core') });
  // core is a direct entry, so it is not overridden as well (npm refuses an
  // override that disagrees with a direct dependency).
  assert.deepEqual(out.overrides, { '@stratusagent/agents': file('agents'), '@stratusagent/executors': file('executors') });
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
  assert.deepEqual(host.overrides, {
    '@stratusagent/cli': file('cli'),
    '@stratusagent/executor-local': file('executor-local'),
    '@stratusagent/executors': file('executors'),
    '@stratusagent/providers': file('providers'),
  });
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
