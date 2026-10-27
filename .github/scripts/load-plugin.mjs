// Loads one plugin by package name through agent main's loader, the way
// the daemon does: manifest, config validation, setup, registration.
// agent-main.mjs copies this into a host project that has the packed
// plugin and main's core and plugins installed, and runs it there, so
// every import below resolves from that project.
//
//   node load-plugin.mjs <package-name> <config.json> <state-dir>
//
// The host seams are stand-ins: no credential or channel secret is stored,
// workspaces and state directories are under <state-dir>, and the fleet is
// empty. A plugin that needs a real one at setup fails here, which is the
// point: it would fail the same way on a daemon that lacks it.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus, SkillRegistry, ToolRegistry } from '@stratusagent/core';
import { createContributionTargets, loadPlugins } from '@stratusagent/plugins';

const [name, configPath, stateDir] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const lines = [];
const prepared = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

const targets = createContributionTargets();
const result = await loadPlugins({
  config,
  host: {
    resolve: (specifier) => import.meta.resolve(specifier),
    import: (specifier) => import(specifier),
  },
  tools: new ToolRegistry(),
  skills: new SkillRegistry(),
  bus: new EventBus(),
  ...targets,
  channelSecrets: async () => ({}),
  credentials: {
    async resolve(_agent, credential) {
      throw new Error(`no credential ${credential} is stored on this host`);
    },
  },
  workspaces: {
    forAgent: (agentId) => join(stateDir, 'workspaces', agentId),
    prepare: (agentId) => prepared(join(stateDir, 'workspaces', agentId)),
    all: async () => [],
  },
  stateDirectories: (packageName) => ({ prepare: () => prepared(join(stateDir, 'plugins', packageName)) }),
  protectedPaths: { all: async () => [], exempt: async () => [] },
  subAgents: {
    async run() {
      throw new Error('this host runs no sub-agents');
    },
  },
  fleet: () => ({
    agents: async () => [],
    sessions: async () => [],
    countByStatus: async () => ({}),
    schedules: async () => [],
    pendingApprovals: async () => [],
  }),
  log: (line) => lines.push(line),
  warn: (line) => lines.push(`warn: ${line}`),
});

for (const line of lines) console.log(`  ${line}`);
const problems = result.failures.map((failure) => `${failure.package} failed to load: ${failure.reason}`);
const loaded = result.loaded.find((plugin) => plugin.package === name);
if (!loaded) {
  problems.push(`${name} was not loaded`);
} else {
  const declared = loaded.manifest.contributes ?? {};
  const missing = (kind, wanted, got) => {
    for (const item of wanted) if (!got.includes(item)) problems.push(`${name} declares ${kind} ${item} but did not register it`);
  };
  missing('tool', (declared.tools ?? []).map((tool) => tool.name), loaded.tools.map((tool) => tool.name));
  missing('skill', (declared.skills ?? []).map((skill) => skill.id), loaded.skills.map((skill) => skill.bareId));
  for (const kind of ['providers', 'memory', 'executors']) {
    missing(kind, (declared[kind] ?? []).map((item) => item.name), loaded.contributions[kind]);
  }
  // A channel registers for the agents it serves, which can be none here
  // (no secrets are stored); the kind is what has to be there.
  missing('channel', (declared.channels ?? []).map((item) => item.name), loaded.contributions.channels.map((channel) => channel.kind));
  console.log(
    `${name}: loaded through agent main's loader; tools [${loaded.tools.map((tool) => tool.name).join(', ')}], ` +
      `skills [${loaded.skills.map((skill) => skill.id).join(', ')}], contributions ${JSON.stringify(loaded.contributions)}`,
  );
}
await Promise.allSettled(result.loaded.map((plugin) => plugin.instance.dispose?.()));
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
