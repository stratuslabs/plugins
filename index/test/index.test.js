import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const repo = join(here, '..', '..');
const index = pkg.stratusPluginIndex;

// The rules `stratus setup` reads the index by (packages/cli/src/plugin-index.ts
// in stratuslabs/agent). An entry it would drop is a mistake here.
const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/** This repository's plugin packages by npm name. */
const ownPackages = () => {
  const found = new Map();
  for (const entry of readdirSync(repo, { withFileTypes: true })) {
    const manifest = join(repo, entry.name, 'package.json');
    if (entry.isDirectory() && !entry.name.startsWith('.') && existsSync(manifest)) {
      const own = JSON.parse(readFileSync(manifest, 'utf8'));
      found.set(own.name, { dir: entry.name, manifest: own });
    }
  }
  return found;
};

test('the index is schema version 1 with a list of plugins', () => {
  assert.equal(index?.schemaVersion, 1);
  assert.ok(Array.isArray(index.plugins) && index.plugins.length > 0);
});

test('every entry is a package name and one short line, and nothing else', () => {
  const seen = new Set();
  for (const entry of index.plugins) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'name'], JSON.stringify(entry));
    assert.ok(typeof entry.name === 'string' && NAME.test(entry.name) && entry.name.length <= 214, `${entry.name} is not an npm package name`);
    assert.ok(!seen.has(entry.name), `${entry.name} is listed twice`);
    seen.add(entry.name);
    assert.equal(typeof entry.description, 'string');
    assert.equal(entry.description, entry.description.trim(), `${entry.name}: description has stray whitespace`);
    assert.ok(entry.description.length > 0 && entry.description.length <= 80, `${entry.name}: description should be one line of at most 80 characters`);
    // Printed straight into a terminal menu: no line breaks, and no control
    // characters (an escape sequence would be run by the terminal). Setup
    // drops such an entry.
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(entry.description), `${entry.name}: description has a line break or control character`);
  }
});

test('every @stratusagent entry is a plugin in this repository that setup can offer', () => {
  const own = ownPackages();
  for (const { name } of index.plugins.filter((entry) => entry.name.startsWith('@stratusagent/'))) {
    const found = own.get(name);
    assert.ok(found, `${name} is not a package in this repository`);
    const stratus = found.manifest.stratus;
    assert.equal(stratus?.pluginVersion, 1, `${name} (${found.dir}/) has no plugin manifest`);
    // Setup's More plugins is a tools menu and skips a release that adds
    // none (an executor-only plugin, say), so such an entry could never be
    // picked there.
    const tools = [...(stratus.contributes?.tools ?? []), ...(stratus.contributes?.toolsDiscovered ?? [])];
    assert.ok(tools.length > 0, `${name} adds no tools, so setup would never offer it`);
  }
});

test('the package publishes nothing but its package.json and README', () => {
  assert.deepEqual(pkg.files, []);
  assert.equal(pkg.private, undefined);
});
