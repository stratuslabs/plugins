# @stratusagent/plugin-backup

A nightly, model-free copy of a Stratus home (`~/.stratus`) in a private git
repository. A script does the work, not an agent: no agent can call it, and
it runs whether or not the daemon is up.

```bash
npm install -g @stratusagent/plugin-backup   # installs the stratus-backup command
stratus-backup keygen --out ~/backup-identity.txt                 # prints its public key, age1...
# Move backup-identity.txt off this machine (a password manager). Lose it and the backups are unreadable.
stratus-backup init git@github.com:you/stratus-home-backup.git --recipient age1...   # one branch per machine, named after the host
stratus-backup now                                                # first snapshot
stratus-backup enable                                             # every night at 03:30 (--at to change)
```

## Encrypted by default

Every file of a snapshot is encrypted with [age](https://age-encryption.org)
on this machine before it is committed, to the recipients (public keys)
given to `init`. The remote holds a `format.json` marker, an encrypted index,
and one encrypted blob per file under a random name, so not even file names
are readable there. This machine never holds the identity (private key)
that decrypts them: only the operator does, for restore. A lost identity is
a lost backup.

Unchanged files keep their ciphertext, so a quiet night still makes no
commit. A local `backup/encryption-cache.json` (never committed) remembers
which blob holds which file. Changing the recipients (`init` again with a
new `--recipient`) re-encrypts everything on the next run. Old commits stay
encrypted to the old key until the branch is deleted. Pass `--recipient`
more than once to encrypt to several keys, for example yours and an offline
spare.

`init --plaintext` makes readable snapshots instead, protected only by
redaction (below), which can't catch every form a secret can take. A branch
never switches between the two: its history would keep the old format, so
`init` refuses and asks for a new branch or repository. The format uses the
standard age file format (X25519 recipients), via the reference
TypeScript implementation (`age-encryption`).

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

In skills, only regular files are copied. Nested `.git` metadata (a
directory, or the file a worktree or submodule has),
symbolic links (the skills directory itself included), hard-linked files and files that keep changing while read
are skipped, and each run names what it skipped. A skills directory replaced
by a link while it is read is skipped too, with anything read through it (a
swap made and undone between two checks is not seen). A file is judged by
the link count of the file actually opened, so one replaced by a hard link
after it was checked is skipped as well. The agents directory and each agent's
directory are rechecked the same way after they are listed and read, but a
swap there stops the run instead of skipping, since leaving an agent's state
out would commit it as deleted.

Running `init` again with another remote changes nothing if it fails. If it
also can't undo its own changes to the backup repository, runs and restores
from this machine's repository stop with a message until an `init` succeeds,
rather than push or restore another remote's history. That `init` starts
from a fresh repository and moves the old one aside to
`backup/repo.suspect-<time>`, never deleting it.

**Sessions and workspaces are not backed up yet.** They hold arbitrary tool
output, and they are the largest state in a home. Encryption (above) makes
them safe to push; the size and database-consistency work is still to do.

## How secrets are kept out

Both layers run on every snapshot. On an encrypted branch they are defense
in depth: a scan finding is printed as a warning and the backup still runs,
because ciphertext is the guarantee. On a plaintext branch they are the
only protection, and a finding stops the run.

1. **Replacement.** Every value in `credentials.json`, and the control API
   token, is replaced with `[redacted by stratus-backup]` wherever it
   appears in the snapshot: raw, JSON-escaped (in any valid escape spelling, at
   any depth), percent-encoded, base64 (line-wrapped too) and hex (spaced and
   wrapped too, as `od` and `xxd` print it). A file name holding one stops the run instead, since a
   renamed file would not restore. A stored secret (or a nonempty `gateway-token`) shorter than 8
   characters once surrounding whitespace is set aside (so one that is only whitespace) is too likely to be an ordinary word to replace everywhere,
   so it stops the run too, naming where it is stored (Codex's fixed
   `chatgpt` sign-in marker is not a secret and is skipped). In the config, every string under a key named like a credential (`token`,
   `apiKey`, `secret`, `password`, ...) or in an `env` block is replaced
   too, at any depth, arrays included. Credentials are read before and
   after the files, along with each credential file's inode, size and
   change time. If anything moved, even a credential rotated away and back
   to the same value, the snapshot is read again (three tries, then the run
   stops), so the one committed was read while no credential changed. A
   `credentials.json` or `gateway-token` that is a symlink stops the run:
   its target can change and change back with no state of its own moving. Every
   value either read saw is replaced. A value stored only briefly and copied
   somewhere permanent before it was removed was never seen, so it cannot be
   replaced; the scan below is the backstop for key-shaped ones.
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
is checked as the GitHub repository it reaches. GitHub is github.com,
www.github.com or ssh.github.com, written with or without the trailing DNS
dot. An SSH host is checked as
the hostname `ssh -G` resolves it to, given the user and port git connects
with, so a `Host` or `Match` alias for github.com is caught too; if ssh can't resolve the host, nothing is pushed. A custom ssh
set in `GIT_SSH_COMMAND` or `core.sshCommand` that reads a different config
is not followed, and neither is a `ProxyCommand` or `ProxyJump` that ends
up at GitHub under another host name. The check is a guard against the
common mistake, not a guarantee: the repository being private is what
keeps a backup private.
Other hosts (GitLab, Bitbucket, your own server) are not checked: making
sure the repository is private there is up to you.

A run also refuses unless origin names exactly the remote the settings do:
one URL, and no push URL to anywhere else, since git pushes to every one.

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
stratus-backup restore ~/restored-home --remote git@github.com:you/stratus-home-backup.git --branch old-mini \
  --identity ~/backup-identity.txt
```

An encrypted backup needs its identity: `--identity <file>`, or a file
named by `STRATUS_BACKUP_IDENTITY`. It is read for the restore and never
stored. Every file is decrypted and checked against the checksum in the
encrypted index before the first one is written, so a wrong identity or a
tampered blob leaves the target empty.

Restore writes only into an empty or new directory, never over a home, and
only plain files under the snapshot's `home/`. Add `--commit <sha>` for an
older snapshot. If the remote can't be reached, restore stops rather than
bring back a copy that may be older than the remote's; `--offline` restores
the latest snapshot this machine already has, without contacting the remote.
A restore from this machine's repository waits for no backup or `init` to be
running, and refuses if one is. Then, with the daemon stopped, move the directory to
`~/.stratus`, run `stratus setup` to sign in again, and re-add Slack tokens
and named credentials. Restore lists the config values that were redacted.
The memory index rebuilds itself. Recall counts are not kept. Each file is
streamed from git to disk, so any file a backup took restores. A file too
big for the secret scan (about 512 MiB, Node's longest string) stops `now`
with its name, before anything is committed.

A soul with no `id:` or `name:` gets an id generated from its file path, so
restored at a different path its memories would not line up. `now` warns
about each such soul; add an `id:` to it.

## Not yet

- Sessions and workspaces. Encryption makes them safe to push; they still
  need their own size and database-consistency work.
- A memory store other than the built-in file store. `now` refuses rather
  than back up no memories.
- The memory index's recall counts.
- Targets other than git.
