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
| [`provider-openai`](./provider-openai) | `openai-compatible`: any OpenAI-compatible chat-completions endpoint as a provider a soul selects, with the key resolved per agent | Moved here from the agent repository; keeps its name |

Each is released to npm as `@stratusagent/plugin-<name>` from the directory
of the same name, on its own version (see [Releasing a plugin](#releasing-a-plugin)).
A package that moved here from the agent repository keeps its npm name, so
`provider-openai` is still `@stratusagent/provider-openai`.
Each directory's README covers setup and configuration.

[`index`](./index) isn't a plugin. It's the curated list `stratus setup`
offers under Plugins → More plugins, published as `@stratusagent/plugin-index`.
To list a plugin there, add it to that package's `stratusPluginIndex`.

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

## Releasing a plugin

Each package has its own version and is released on its own. A release is
staged on npm by CI and goes public only when a maintainer approves it.

1. Merge a pull request that bumps `version` in the package's `package.json`.
2. Tag that commit on main `<dir>/v<version>` and push the tag, for example
   `git tag peer/v0.2.0 <sha> && git push origin peer/v0.2.0`.
3. The [Release workflow](.github/workflows/release.yml) refuses a tag whose
   commit isn't on main, whose version isn't the one in `package.json`, or
   whose package isn't a public `@stratusagent/` one. Then it runs that
   package's tests on its runners and stages it with `npm stage publish`.
4. Approve the staged version on npmjs.com (the Staged Packages tab) or with
   `npm stage approve <id>`. npm asks for 2FA. Until then nothing is public.

CI holds no npm token. It stages through npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers), which npm
sets up in an existing package's settings. npm also checks that the
package's `repository.url` is this repository, and the Release workflow
refuses a tag whose package says otherwise. Provenance is added by npm once
this repository is public; it isn't generated from a private one. Each
package needs this once:

- **A package that was never published** is staged by hand the first time:
  from a clean checkout of its tag, run
  `npx npm@11.19.1 stage publish --access public` (staging needs npm 11.15.0
  or later and Node 22.14.0 or later; Node 22 ships npm 10), then approve it.
  Staging a package npm has never seen also publishes a `0.0.0-stage`
  placeholder version.
- **Then, on npmjs.com**, open the package's Settings, Trusted publishing, and
  add GitHub Actions: organization `stratuslabs`, repository `plugins`,
  workflow `release.yml`, environment `release`, allowed action stage publish
  only. Then set the package to disallow publishing with tokens.
- **A package that moved here from the agent repository** is already on npm,
  so it skips the hand-staged first release. Its first tag here must be a
  version above the last one the agent repository published (`stratus update`
  only moves a plugin to a newer release, so a lower one would never reach an
  existing install), and its Trusted publishing settings need this
  repository's entry, as above.

## Built into the agent

Some capabilities ship with the agent itself rather than here: files, shell,
web fetch, browser, MCP servers, Slack, and the control API with its
dashboard. Their packages are in
[`stratuslabs/agent/packages`](https://github.com/stratuslabs/agent/tree/main/packages).
