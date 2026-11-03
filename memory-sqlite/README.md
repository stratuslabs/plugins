# @stratusagent/memory-sqlite

Agent memory on one SQLite file, as a **plugin**. It registers a memory
store named `sqlite` through the plugin seam. A trusted config selects it
for the fleet, and from then on every agent's `memory.remember`,
`memory.recall`, `memory.forget` and `memory.pin`, and the memory each
turn's prompt is built from, go through it instead of the built-in file
store.

It used to ship from the [agent repository](https://github.com/stratuslabs/agent)
in lockstep with the CLI (up to 0.13.x). From 0.14.0 it releases from here, on
its own version, under the same name, so an existing install keeps updating
with `stratus update`. The code, the config and the database layout didn't
change in the move: a file written by 0.13.x opens as it is.

## Install and enable

```bash
npm install -g @stratusagent/memory-sqlite
```

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/memory-sqlite": { "enabled": true, "path": "~/.stratus/memory.sqlite" }
  },
  "memoryStore": "sqlite"
}
```

`path` is required: where the database lives is your decision, not one
the plugin guesses inside a directory it doesn't own. `~` expands as in a
shell. The file and its WAL sidecars are owner-only (`0600`), like the
file store and the session database. The loader refuses a block with no
`path` or with a setting it doesn't know.

## What it is, and is not

The same [memory contract](https://github.com/stratuslabs/agent/blob/main/docs/concepts/memory.md)
as the built-in store: per-agent keying, `search` as whole-token AND matching
over content *and* `about` keys, newest first with ties broken by id, bounded
reads by count and bytes, tombstones rather than deletes, supersession scoped
to the successor's validity window, episodic notes that leave `list` and `topics`
14 days after they're written unless they set their own end (search
still finds them, and a pin keeps one current), a pinned core that refuses rather
than evicting, the topic index, an operator audit read, and trust re-assertion.
The shape is different: rows in SQLite, no derived index. Every read selects
an agent's live rows and applies the contract's own rules from
`@stratusagent/core`, so this store and the file store can't disagree about
what a query matches or which entries a bounded read keeps.

Two tables hold what the file store keeps in its record lane and its index:
`pins`, ordered by arrival rather than by timestamp, so a budget is
allocated the way `O_APPEND` allocates it there; and `usage`, the recall
counters. Those are derived, and they're the only thing here a rebuild
couldn't restore: dropping that table loses statistics, never memories.

It exists to prove that `AgentMemoryStore` holds for a shape that isn't
JSONL-plus-FTS5, and it's a real store, not a faster one. Selecting it
moves new memories here. Nothing is migrated from the file store, and
switching back leaves what was written here where it is.

## Testing

```bash
npm install
npm test
```

The tests run against `@stratusagent/core` and `@stratusagent/plugins` from
npm, and load the package by name through the daemon's own plugin loader.
