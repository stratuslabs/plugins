# Stratus plugins

Optional packages for a [Stratus agent](https://github.com/stratuslabs/agent).
Each one adds tools, a channel, an executor, or a command without making the
agent's core any bigger.

## Plugins

| Package | What it adds | Notes |
| --- | --- | --- |
| [`plugin-spawn`](./spawn) | `agent.spawn`: run several tasks at once in short-lived sub-agents, each with only the tools you hand it | Each sub-agent's calls are judged again |
| [`plugin-fleet`](./fleet) | `fleet.agents`, `fleet.sessions`, `fleet.schedules`, `fleet.approvals`: read-only fleet metadata for an agent that reports what needs a person | Needs `PluginContext.fleet` (agent#412). No messages, prompts or approval inputs |
| [`plugin-peer`](./peer) | `peer.delegate`: hand a task to an agent on another Stratus daemon and get its answer | Signed HTTP, a secret per pair of agents, one hop limit across daemons |
| [`plugin-a2ui`](./a2ui) | `ui.render`, `ui.catalog`: an agent shows a native screen as A2UI v1.0, validated against your catalogs | Comes with the `a2ui-screens` skill |
| [`plugin-sandbox`](./sandbox) | A `sandbox` executor: every agent command runs under `sandbox-exec` and can write only the agent's workspace | macOS. Turn it on with `"executor": "sandbox"` |
| [`plugin-backup`](./backup) | `stratus-backup`: a nightly, model-free copy of a Stratus home in a private git repo, with age encryption you choose per kind of file | A command, not an agent tool |
| [`plugin-dreams`](./dreams) | Overnight experiment dreams: in a nightly window, run [overnight-experimenter](https://github.com/dylanfeltus/overnight-experimenter) at most once per experiment, and `dreams.report` in the morning | macOS. Runs host code under `sandbox-exec`; read its README first |

All are published as `@stratusagent/plugin-<name>` from the directory of the
same name. Each directory's README covers setup and configuration.

## Installing one grants nothing

There are two gates, and both are yours. First, a config you trust enables the
plugin:

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "@stratusagent/plugin-spawn": { "enabled": true }
  }
}
```

Then an agent's soul lists the tools it may call:

```markdown
---
id: blair
tools: [agent.spawn]
---
```

A plugin runs inside the daemon, so only a config you chose can enable one:
`--config`, `STRATUS_CONFIG`, or `~/.stratus/config.json`. A project's own
`stratus.config.json` ships with whatever repository you clone, so its
`plugins` block is ignored. Run `stratus plugins` to see where that chain stops
on your machine.

## Third-party plugins

None listed yet. Built one? Open a pull request adding a row above.

## Building one

The contract (the manifest, what `setup()` can register, and the extension
points) is in
[`docs/architecture/plugins.md`](https://github.com/stratuslabs/agent/blob/main/docs/architecture/plugins.md),
and the trust model is in
[`docs/concepts/plugins.md`](https://github.com/stratuslabs/agent/blob/main/docs/concepts/plugins.md).
Two things to know before you start:

- **The manifest is read without importing your package.** Your tools and
  their risk go in `package.json`, so a misconfigured plugin is refused when it
  loads, not halfway through someone's turn.
- **Only first-party packages can mark a tool `safe`.** Everything else
  registers as `gated` or higher. An operator can change that with a
  `toolRisks` entry; a plugin can't.

Name a third-party plugin `stratus-plugin-<name>` or
`@scope/stratus-plugin-<name>`. If you build a `web.search` backend, implement
the shared contract in
[`packages/search`](https://github.com/stratuslabs/agent/tree/main/packages/search)
and read the key from the `search.apiKey` credential, so switching vendors
never changes a soul or a skill.

## Built into the agent

Some capabilities ship with the agent itself rather than here: files, shell,
web fetch, browser, MCP servers, Slack, and the control API with its
dashboard. Their packages are in
[`stratuslabs/agent/packages`](https://github.com/stratuslabs/agent/tree/main/packages).
