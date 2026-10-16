# stratus-backup

A nightly, model-free copy of a Stratus home (`~/.stratus`) in a private git
repository. A script does the work, not an agent: no agent can call it, and
it runs whether or not the daemon is up.

```bash
npm install -g stratus-backup
stratus-backup init git@github.com:you/stratus-home-backup.git   # one branch per machine, named after the host
stratus-backup now                                                # first snapshot
stratus-backup enable                                             # every night at 03:30 (--at to change)
```

Requires Node 22.13 or later and `git` on the PATH, with push access to the
repository already set up (an SSH key or a credential helper). macOS and
Linux.

## What is in a snapshot

| Backed up | Never backed up |
| --- | --- |
| Souls (`agents/*.md`), `skills/`, `state.json` | `credentials.json`, `gateway-token`, `gateway.json` |
| The trusted config, with credential-like values redacted | `logs/`, locks, the derived `memory.jsonl.index` |
| Each agent's `memory.jsonl` and `whitelist.json` | Each agent's `sessions.db` and `workspace/` (see below) |
| The schedules from `fleet.db`, as `schedules.jsonl` | The session index in `fleet.db` |

The trusted config is the one `stratus serve` would use: `--config`, then
`STRATUS_CONFIG`, then `~/.stratus/config.json`. Pass the same `--config` to
`now` and `enable` if your service uses one. A config named by `--config` or
`STRATUS_CONFIG` that doesn't exist fails the run rather than being left out.

In skills, only regular files are copied. Nested `.git` directories,
symbolic links, hard-linked files and files that keep changing while read
are skipped, and each run names what it skipped.

**Sessions and workspaces are not backed up yet.** They hold arbitrary tool
output, and a scan cannot promise to find a secret a tool wrote in some
encoded form. They need encryption first, which is planned.

## How secrets are kept out

1. **Replacement.** Every value in `credentials.json`, and the control API
   token, is replaced with `[redacted by stratus-backup]` wherever it
   appears in the snapshot: raw, JSON-escaped (once or twice), base64, hex
   and URL-encoded. A file name holding one stops the run instead, since a
   renamed file would not restore. In the config, every string under a key named like a credential (`token`,
   `apiKey`, `secret`, `password`, ...) or in an `env` block is replaced
   too, at any depth, arrays included.
2. **A scan.** Anything still shaped like a well-known key (Anthropic,
   OpenAI, Slack, GitHub, AWS, Google, Stripe, Fly.io, private keys) stops
   the run before anything is committed. The error gives the file, line and
   kind of key, never the text. Remove it at the source. If it really is not
   a secret, `stratus-backup allow <id>` accepts that one finding.

What this does not catch: a secret an agent rewrote into a form neither
layer recognizes (paraphrased, split up, ROT13'd) in a memory or a schedule
prompt. That is why the repository must be private. On GitHub, every run
checks, without credentials, that the repository is not publicly readable
and refuses to push if it is. The check covers the URL git actually uses,
so a remote written as an alias (`url.<base>.insteadOf` or `pushInsteadOf`)
is checked as the GitHub repository it reaches.

## How history is kept

Each snapshot is a commit on this machine's branch. A run with no changes
makes no commit. Nothing is ever force-pushed or rewritten. If the branch on
the remote has commits this machine did not make, the run stops: give each
machine its own branch. Commits are built with git plumbing, so no
`.gitignore`, `.gitattributes`, filter or hook (yours or a skill's) can
change what is stored.

`stratus-backup status` shows the last run. On macOS a nightly failure is
also in `~/.stratus/logs/backup.log`; on Linux it is in the user journal.

## Restoring

```bash
stratus-backup restore ~/restored-home --remote git@github.com:you/stratus-home-backup.git --branch old-mini
```

Restore writes only into an empty or new directory, never over a home, and
only plain files under the snapshot's `home/`. Add `--commit <sha>` for an
older snapshot. Then, with the daemon stopped, move the directory to
`~/.stratus`, run `stratus setup` to sign in again, and re-add Slack tokens
and named credentials. Restore lists the config values that were redacted.
The memory index rebuilds itself. Recall counts are not kept.

A soul with no `id:` or `name:` gets an id generated from its file path, so
restored at a different path its memories would not line up. `now` warns
about each such soul; add an `id:` to it.

## Not yet

- Sessions and workspaces (needs encryption).
- A memory store other than the built-in file store. `now` refuses rather
  than back up no memories.
- The memory index's recall counts.
- Targets other than git.
