// Tests one plugin package against stratuslabs/agent main, for the nightly
// run. The pull request and main workflows test every package against the
// core packages already on npm, so a change on agent main that breaks a
// plugin would otherwise show up only after it was released.
//
//   node .github/scripts/agent-main.mjs <package-dir> --packs <dir> --work <dir>
//
// --packs holds the tarballs `pnpm pack` made from agent main's packages.
// --work is an empty scratch directory. Two checks, both against main:
//
// 1. Tests. The repository is copied into <work>/repo, every @stratusagent/*
//    dependency the package names is pointed at main's tarball (and every
//    one of those packages' own, through overrides), and `npm test` runs in
//    the package's copy.
// 2. Loader. The package is packed the way npm would publish it, installed
//    into <work>/host beside main's core and plugins, and loaded by name
//    through main's loadPlugins with its entry in load-config.json. It
//    passes only when it loads whole and registers what its manifest
//    declares. A package with no "stratus" manifest is not a plugin
//    (index, backup) and gets only the tests.

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCOPE = '@stratusagent/';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
/** What the loader check imports, whatever the plugin itself depends on. */
export const HOST_PACKAGES = [`${SCOPE}core`, `${SCOPE}plugins`];

/** The @stratusagent/* packages a package.json names in any dependency field. */
export function stratusDependencies(pkg) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) if (name.startsWith(SCOPE)) names.add(name);
  }
  return [...names].sort();
}

/**
 * The packed packages, by name: { file, version, dependencies }, where
 * dependencies are the @stratusagent/* ones it needs at run time.
 */
export function readPacks(dir) {
  const packs = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.tgz')).sort()) {
    const path = resolve(dir, file);
    const pkg = JSON.parse(execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }));
    const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((name) => name.startsWith(SCOPE));
    packs.set(pkg.name, { file: path, version: pkg.version, dependencies });
  }
  return packs;
}

/**
 * Every packed package the given names need, the names included. A name
 * agent main no longer has is an error, since that is a break too. So is a
 * packed package needing one main doesn't pack: npm would fetch the
 * released one, and the check would run on a mix of main and npm.
 */
export function closure(names, packs) {
  const missing = names.filter((name) => !packs.has(name));
  if (missing.length > 0) throw new Error(`agent main has no package ${missing.join(', ')}`);
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dependency of packs.get(name).dependencies) {
      if (!packs.has(dependency)) throw new Error(`agent main's ${name} needs ${dependency}, which agent main does not pack`);
      visit(dependency);
    }
  };
  for (const name of names) visit(name);
  return [...seen].sort();
}

/**
 * Overrides that force main's copy of every packed package wherever it sits
 * in the tree, not only at the top: a dependency whose range shuts main's
 * version out would otherwise get its own copy from npm. A package the root
 * names itself is overridden with `$name`, npm's reference to that entry,
 * since an override that differs from a direct dependency is refused.
 */
export function mainOverrides(direct, packs) {
  const overrides = {};
  for (const name of [...packs.keys()].sort()) overrides[name] = direct.includes(name) ? `$${name}` : `file:${packs.get(name).file}`;
  return overrides;
}

/**
 * The package.json pointed at agent main: each @stratusagent/* dependency it
 * names becomes main's tarball in the same field, and overrides force
 * main's copy of every package everywhere else in the tree.
 */
export function pointAtMain(pkg, packs) {
  const direct = stratusDependencies(pkg);
  closure(direct, packs);
  if (direct.length === 0) return pkg;
  const out = structuredClone(pkg);
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(out[field] ?? {})) {
      if (name.startsWith(SCOPE)) out[field][name] = `file:${packs.get(name).file}`;
    }
  }
  out.overrides = { ...out.overrides, ...mainOverrides(direct, packs) };
  return out;
}

/**
 * Every @stratusagent/* package npm installed that is not main's, from the
 * hidden lockfile npm writes into node_modules: a copy from the registry (a
 * plugin whose range shuts main's version out gets its own) would mean the
 * check ran partly against npm's code.
 */
export function strayCopies(installedLock, packs) {
  const stray = [];
  for (const [path, entry] of Object.entries(installedLock.packages ?? {})) {
    const at = path.lastIndexOf('node_modules/');
    if (at === -1) continue;
    const name = path.slice(at + 'node_modules/'.length);
    if (!packs.has(name)) continue;
    if (!String(entry.resolved ?? '').startsWith('file:')) stray.push(`${path} ${entry.version} from ${entry.resolved ?? 'nowhere'}`);
  }
  return stray;
}

/** The host project the loader check runs in: the packed plugin and main. */
export function hostManifest(pluginName, pluginTarball, packs) {
  const needed = closure(HOST_PACKAGES, packs);
  const dependencies = { [pluginName]: `file:${pluginTarball}` };
  for (const name of needed) dependencies[name] = `file:${packs.get(name).file}`;
  // The plugin's own @stratusagent/* ranges name the last release, which may
  // not admit main's version; the overrides make it get main's anyway.
  return { name: 'agent-main-host', private: true, type: 'module', dependencies, overrides: mainOverrides(needed, packs) };
}

/**
 * The loader config for one package, with {package} replaced by the
 * package's source directory and {state} by a scratch directory.
 */
export function loaderConfig(table, name, { packageDir, stateDir }) {
  const entry = table[name] ?? {};
  return JSON.parse(JSON.stringify(entry), (_key, value) =>
    typeof value === 'string' ? value.replaceAll('{package}', packageDir).replaceAll('{state}', stateDir) : value,
  );
}

const run = (command, args, cwd) => {
  console.log(`\n$ (${cwd}) ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
};

const NPM_INSTALL = ['install', '--no-audit', '--no-fund', '--no-package-lock'];

const installMain = (dir, packs) => {
  run('npm', NPM_INSTALL, dir);
  // npm writes no hidden lockfile when there was nothing to install.
  const installed = join(dir, 'node_modules', '.package-lock.json');
  if (!existsSync(installed)) return;
  const stray = strayCopies(JSON.parse(readFileSync(installed, 'utf8')), packs);
  if (stray.length > 0) throw new Error(`npm installed packages that are not agent main's:\n  ${stray.join('\n  ')}`);
};

export function testAgainstMain(packageDir, { packs, work }) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  // The whole repository is copied, not just the package, because some
  // tests read their neighbours (index checks every entry is a package here).
  const root = resolve(packageDir, '..');
  const repo = join(work, 'repo');
  const testDir = join(repo, basename(resolve(packageDir)));
  rmSync(repo, { recursive: true, force: true });
  cpSync(root, repo, { recursive: true, filter: (source) => !['node_modules', '.git'].includes(basename(source)) });
  // The lockfile pins npm's copies; the point here is main's.
  rmSync(join(testDir, 'package-lock.json'), { force: true });
  writeFileSync(join(testDir, 'package.json'), `${JSON.stringify(pointAtMain(pkg, packs), null, 2)}\n`);
  installMain(testDir, packs);
  run('npm', ['test'], testDir);
}

export function loadThroughMain(packageDir, { packs, work, configTable }) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const hostDir = join(work, 'host');
  const stateDir = join(work, 'state');
  rmSync(hostDir, { recursive: true, force: true });
  mkdirSync(hostDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', hostDir], { cwd: packageDir, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop();
  writeFileSync(join(hostDir, 'package.json'), `${JSON.stringify(hostManifest(pkg.name, join(hostDir, tarball), packs), null, 2)}\n`);
  installMain(hostDir, packs);
  // Copied in, so its imports resolve from the host's node_modules the way
  // the daemon's do from its own install.
  const here = dirname(fileURLToPath(import.meta.url));
  copyFileSync(join(here, 'load-plugin.mjs'), join(hostDir, 'load-plugin.mjs'));
  const config = loaderConfig(configTable, pkg.name, { packageDir: resolve(packageDir), stateDir: resolve(stateDir) });
  writeFileSync(join(hostDir, 'config.json'), `${JSON.stringify({ [pkg.name]: config }, null, 2)}\n`);
  run('node', ['load-plugin.mjs', pkg.name, 'config.json', resolve(stateDir)], hostDir);
}

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const packageDir = process.argv[2];
  const packsDir = flag('--packs');
  const work = flag('--work');
  if (!packageDir || packageDir.startsWith('--') || !packsDir || !work) {
    console.error('usage: node agent-main.mjs <package-dir> --packs <dir> --work <dir>');
    process.exit(2);
  }
  const packs = readPacks(packsDir);
  if (packs.size === 0) {
    console.error(`no tarballs in ${packsDir}`);
    process.exit(2);
  }
  if (`${resolve(work)}/`.startsWith(`${resolve(packageDir, '..')}/`)) {
    console.error(`--work ${work} is inside the repository the tests copy; use a directory outside it`);
    process.exit(2);
  }
  mkdirSync(work, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  console.log(`${pkg.name}: against agent main ${[...packs.values()][0].version}, ${packs.size} packages`);
  // Both checks run even when the first fails, so one run says everything
  // main broke in this package.
  const failed = [];
  try {
    testAgainstMain(packageDir, { packs, work: resolve(work) });
  } catch (error) {
    failed.push(`its tests (${error.message})`);
  }
  if (pkg.stratus === undefined) {
    console.log(`\n${pkg.name} has no "stratus" manifest, so it is not loaded as a plugin.`);
  } else {
    const here = dirname(fileURLToPath(import.meta.url));
    const configTable = JSON.parse(readFileSync(join(here, 'load-config.json'), 'utf8'));
    try {
      loadThroughMain(packageDir, { packs, work: resolve(work), configTable });
    } catch (error) {
      failed.push(`loading it through main's loader (${error.message})`);
    }
  }
  if (failed.length > 0) {
    console.error(`\n${pkg.name} fails against agent main: ${failed.join('; ')}`);
    process.exit(1);
  }
  console.log(`\n${pkg.name} passes against agent main.`);
}
