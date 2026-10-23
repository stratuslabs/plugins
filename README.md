# Stratus plugins

Plugins extend a [Stratus agent](https://github.com/stratuslabs/agent): one
package contributing tools, skills, providers, channels, memory stores,
executors, or hooks. This is the index of what exists.

## Installing one grants nothing

Two gates, always, and both are yours:

```bash
npm install -g @stratusagent/tool-shell
```

```jsonc
// ~/.stratus/config.json — a trusted config only
{
  "plugins": {
    "@stratusagent/tool-shell": { "enabled": true, "cwd": "~/work" }
  }
}
```

```markdown
---
id: blair
tools: [shell.run]
---
```

A plugin runs inside the daemon's own process, so only a config **you**
chose may enable one — `--config`, `STRATUS_CONFIG`, or the global
`~/.stratus/config.json`. A project-local `stratus.config.json` ships with
any repository you clone, and its `plugins` block is ignored.

Then the soul's `tools:` list decides which agent may call what. Installing
a plugin and enabling it still grants no agent anything.

`stratus plugins` shows where that chain is broken on your machine —
installed, enabled, granted, and what the approval policy does with the
call.

## First-party

Shipped from [`stratuslabs/agent`](https://github.com/stratuslabs/agent),
published under `@stratusagent`.

| Package | Contributes | Risk |
| --- | --- | --- |
| [`tool-fs`](https://github.com/stratuslabs/agent/tree/main/packages/tool-fs) | `fs.read`, `fs.list`, `fs.search` | `safe` inside the agent's roots |
| | `fs.write` | `gated` |
| [`tool-shell`](https://github.com/stratuslabs/agent/tree/main/packages/tool-shell) | `shell.run` | `gated`, then judged per command |
| [`tool-web`](https://github.com/stratuslabs/agent/tree/main/packages/tool-web) | `web.fetch` | `gated` |
| [`tool-browser`](https://github.com/stratuslabs/agent/tree/main/packages/tool-browser) | `browser.goto`, `.read`, `.screenshot` | `gated` |
| | `browser.act` | `gated`, then judged per site |
| [`plugin-mcp`](https://github.com/stratuslabs/agent/tree/main/packages/plugin-mcp) | `mcp.<server>.<tool>` — any MCP server's tools, discovered at connect | `gated`, whatever the server says |
| [`channel-slack`](https://github.com/stratuslabs/agent/tree/main/packages/channel-slack) | Slack as a channel: DMs, mentions, threads, approval buttons | — |
| [`control-api`](https://github.com/stratuslabs/agent/tree/main/packages/control-api) · [`dashboard`](https://github.com/stratuslabs/agent/tree/main/packages/dashboard) | The HTTP + WebSocket control API, and the web dashboard on it | — |

## In this repository

Optional packages that live here rather than in the agent's core. Each is
published as `@stratusagent/plugin-<name>` from its directory `<name>/`,
whatever it contributes (tools, a channel, an executor, or a command), so the
name says it is optional and outside core. Third-party plugins are
encouraged to use `stratus-plugin-<name>` or `@scope/stratus-plugin-<name>`.

| Package | Contributes | Notes |
| --- | --- | --- |
| [`@stratusagent/plugin-sandbox`](./sandbox) | executor `sandbox` | macOS. Every agent command runs under `sandbox-exec`, so it can write only the agent's workspace. Selected with `"executor": "sandbox"`. |
| [`@stratusagent/plugin-spawn`](./spawn) | `agent.spawn`: several tasks at once in short-lived sub-agents with only the tools you hand them | `safe`; each sub-agent's calls are judged again |
| [`@stratusagent/plugin-peer`](./peer) | channel `peer`, `peer.delegate`: hand a task to an agent on another Stratus daemon and get its answer | `gated`. Signed HTTP between daemons, pairwise secrets per agent, a hop budget shared across daemons. Answers arrive labelled `agent`. |

## In this repository

Plugins that live here rather than in the agent's core.

| Package | Contributes | Notes |
| --- | --- | --- |
| [`@stratusagent/plugin-a2ui`](./a2ui) | `ui.render`, `ui.catalog`, skill `a2ui-screens` | An agent shows a native screen as A2UI v1.0 JSON, validated against the catalogs you configure. Both tools `safe`. |

## Third-party

Nothing listed yet. Open a pull request adding a row.

### `web.search` is a contract, not a package we ship

Every search backend needs a vendor key and a commercial relationship, so
the agent ships `web.fetch` and the ecosystem ships `web.search`. What is
first-party is the *shape* — one tool name, one meaning per option, one
result envelope — so swapping vendors changes no soul and no skill. The
contract lives in
[`packages/search`](https://github.com/stratuslabs/agent/tree/main/packages/search).

A backend asks for the credential `search.apiKey` whatever the vendor is.
That is what makes a swap free.

## Building one

The plugin contract — the manifest, what `setup()` may register, and the
seams a plugin extends — is in
[`docs/architecture/plugins.md`](https://github.com/stratuslabs/agent/blob/main/docs/architecture/plugins.md).
The trust model behind the two gates above is in
[`docs/concepts/plugins.md`](https://github.com/stratuslabs/agent/blob/main/docs/concepts/plugins.md).

Two things worth knowing before you start:

- **A manifest is read without importing your package.** It declares your
  tools and their risk in `package.json`, so a misconfigured plugin is
  refused at load rather than at the first tool call in the middle of
  someone's turn.
- **Only first-party packages may declare a tool `safe`.** Everything else
  registers at `gated` or higher, whatever its manifest says. An operator's
  `toolRisks` entry is the only thing that changes that, and it is theirs to
  write, not yours.

## Vocabulary

One word per thing, because the ecosystem reads these docs before it reads
the code.

- **Plugin** — one package, the unit of distribution and installation.
- **Tool** — a callable action, named `namespace.verb` (`fs.read`).
- **Toolset** — the namespace a group of tools shares (`fs`), and what
  `tools: [fs.*]` globs over.
- **Skill** — markdown that teaches an agent a procedure. Not code; a skill
  that needs to *do* something is a plugin contributing a tool.
- **Soul** — the markdown file defining an agent: persona plus the `tools`,
  `skills`, and `credentials` it may use.
