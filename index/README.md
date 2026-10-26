# @stratusagent/plugin-index

The curated list of plugins that `stratus setup` offers under **Plugins →
More plugins**. It's data, not code: the list is the `stratusPluginIndex`
field of this package's `package.json`, and setup reads it with
`npm view @stratusagent/plugin-index@latest stratusPluginIndex --json`, so it
goes through the same registry, proxy and auth as `npm install -g`.

```json
{
  "schemaVersion": 1,
  "plugins": [
    { "name": "@stratusagent/plugin-spawn", "description": "Run several tasks at once in short-lived sub-agents" }
  ]
}
```

Each entry is an npm package name and one line, at most 80 characters, on
what it adds. Setup drops an entry whose name npm couldn't be handed, or whose
description is empty or has a line break or control character.

## What an entry does and doesn't do

The index decides what setup **suggests**. It doesn't decide what's trusted
or what a plugin contributes:

- Setup offers an entry only when the plugin's latest release on npm says it
  can be used there: it's published, it's a Stratus plugin of a
  `pluginVersion` that CLI loads, its `os` field includes the host, and it
  adds tools. Every other entry is listed with the reason, for example
  `plugin-peer (not on npm yet)`.
- Picking one runs `npm install -g <name>` and enables it the same way as any
  other plugin in the menu. Setup still asks first, and what the plugin
  contributes is read from its own manifest.
- Trust comes from the publisher (`@stratusagent` is the first-party scope),
  never from being listed here.

Packages released with the CLI itself (`tool-fs`, `tool-shell`, `tool-web`,
`tool-browser`, `plugin-mcp`) aren't listed: they always match the CLI and
are rows of the menu already.

## Changing the list

1. Edit `stratusPluginIndex` in `package.json` and bump `version`.
   `npm test` checks the shape, and that every `@stratusagent` entry is a
   plugin package in this repository.
2. After it merges, release it like any other package here: push the tag
   `index/v<version>`. The release workflow (added in #37, which also adds
   "Releasing a plugin" to the top-level README) tests it and stages it on
   npm, and nothing changes for anyone until a maintainer approves the
   staged version.
3. Each CLI release carries a copy of the list (`BUNDLED_PLUGIN_INDEX` in
   `packages/cli/src/plugin-index.ts` in stratuslabs/agent), which setup
   shows when npm has no index or can't be reached. Keep that copy equal to
   this one when the CLI releases.
