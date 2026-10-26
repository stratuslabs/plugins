# @stratusagent/plugin-sandbox

Runs every command an agent composes under the macOS sandbox. A command can write only the agent's workspace, and can read only the system, the usual toolchain locations, and paths you list. It's the boundary for an agent you want locked down: the permission engine judges a command's arguments, but a program it approved can still run whatever its config names (git hooks, filters, a repository's `core.sshCommand`). Under this executor, those programs run inside the same walls.

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/plugin-sandbox": {
      "enabled": true,
      "network": true,                              // default; false cuts every command off the network
      "readPaths": ["~/.stratus/integrations/shared"],
      "agents": {
        "nova": { "readPaths": ["~/.stratus/integrations/nova"], "network": true }
      }
    }
  },
  "executor": "sandbox"
}
```

## What a command can touch

- **Write:** the agent's workspace (`~/.stratus/agents/<id>/workspace`), the command's own working directory if the shell is configured with a different one, and any `writePaths` you list. Temporary files go to `<workspace>/.tmp` (set as `TMPDIR`), because the shared temporary directory isn't writable.
- **Read:** everything it can write, plus `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/opt/homebrew`, `/usr/local`, `/private/etc`, `/private/var/db`, `/dev`, the active Xcode whatever its bundle is named (the one `xcode-select -p` names, read when the daemon starts, so switching Xcode takes a restart), and any `readPaths`. Not the rest of your home directory, not `~/.ssh`, not `~/.stratus`, and not other agents' workspaces.
- **Network:** on by default (git fetch and push, package installs), IP only: a command can't connect to local Unix sockets such as Docker's, apart from the system resolver's. Set `network: false`, shared or per agent, to turn it off; that also takes away the system resolver, so no DNS query leaves either.

`readPaths` and `writePaths` add up: an agent gets the shared list plus its own. Paths are resolved through symlinks, so a symlinked workspace is allowed where it actually is. A working directory, write path or read path named inside a writable path must also resolve inside it: if an agent swaps such a folder for a symlink that points elsewhere, the command is refused rather than given the target. `~` expands to the daemon user's home.

If a tool needs a file outside these, such as a git identity file or a credential helper, list it in `readPaths`. A command that's denied fails with `Operation not permitted`, and the failed output reaches the agent.

## Scope

- **Commands only.** In-process tools (`fs.*`, `web.fetch`, the browser, memory) run in the daemon and stay under the permission policy, as roadmap step 15 describes.
- **macOS only** (`/usr/bin/sandbox-exec`). On other platforms the plugin refuses to load rather than run commands on the host while the config says otherwise. Linux (bubblewrap) is planned.
- **Same user, so process details stay visible.** Commands run as the daemon's user, and macOS lets any process read another same-user process's arguments and environment (`KERN_PROCARGS2`, what `ps -E` shows). The sandbox can't stop that: on macOS 15.3.1 the read still works under a profile that denies every sysctl. Keep credentials out of the daemon's environment and arguments, and use a separate user account for a hard process boundary.
- **`executor` is daemon-wide.** Every agent's commands run sandboxed once it's selected.
- `sandbox-exec` is deprecated in name, but it ships with current macOS and is what Apple's own tools use. If a future macOS removes it, this plugin will refuse to load.

## Overhead

On a Mac mini (M4, macOS 15.3), starting `/bin/sh -c true` takes about 16 ms on the host and about 40 ms under the sandbox, averaged over 30 runs. That's roughly 24 ms per command.

## Tests

`npm test`. The escape suite runs real commands under `sandbox-exec`: reading and writing outside the workspace, a symlink out, listing the home directory, and a git hook writing outside. Each command is first run on the host to prove it would succeed there, so a pass shows the wall and not a broken command.
