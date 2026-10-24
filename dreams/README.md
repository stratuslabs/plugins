# @stratusagent/plugin-dreams

Overnight experiment dreams. Each night, in a window you set, an agent's
experiments run through
[overnight-experimenter](https://github.com/dylanfeltus/overnight-experimenter)
under the macOS sandbox. Each experiment runs at most once a night, and in the
morning `dreams.report` tells the agent what was tried.

**macOS only.** On any other platform the plugin refuses to load. Linux waits
for a bubblewrap profile.

## Read this first: an experiment dream is code on your host, not an agent turn

`overnight run` loops on its own. `claude -p` edits `workspace/`, then
`evaluate.sh` runs whatever was written, scores it, and the change is kept or
reverted. Stratus approvals, permissions and sessions don't apply to any of
that. What contains it is the sandbox this plugin wraps around the whole
process tree:

| | |
| --- | --- |
| Writable | `workspace/`, `best/`, `experiments.jsonl`, `report.html`, plus a private home and tmp for each experiment in the plugin's state directory |
| Read-only | the rest of the experiment directory, including `evaluate.sh` and `program.md`, the system, the install directories of `overnight`, `claude` and node, and your `readPaths` |
| Unreadable | everything else in your home, and never `~/.ssh`, `~/.aws`, `~/.claude`, `~/.claude.json`, `~/.config/gh`, `~/Library/Keychains`, `~/.stratus`, every agent workspace or any path Stratus protects, even if a read path covers them |
| Network | on, because `claude` needs the API |
| Anthropic key | never in the sandbox: see below |

`HOME` and `CLAUDE_CONFIG_DIR` point at that private home, so the
experimenter's Claude never sees your `~/.claude`. A hook it plants in its own
settings can reach only its next sandboxed run.

The Anthropic key stays in the daemon. Each run gets a loopback proxy that
the plugin runs outside the sandbox, on `127.0.0.1` and a random port.
The run's `claude` gets `ANTHROPIC_BASE_URL` pointing at it, plus a random
per-run token as its `ANTHROPIC_API_KEY`. The proxy forwards only requests
that carry that token, only to `api.anthropic.com`, and swaps the token for
the real key on the way. It closes when the run's whole process group is gone.

**What's still open:** code the model writes into `workspace/` runs during
`evaluate.sh` with network access, and with read access to whatever the
sandbox allows. It can read the run's token, so while the run lasts it can
spend tokens on your key through the proxy. It can't read the key itself,
and the token stops working when the run ends. A spend limit on the key
caps the cost.

A run never outlives the daemon. Each one runs under a small tether process
that holds a pipe from the daemon: when the daemon stops, crashes or is
killed, the pipe closes and the tether stops the run's whole process group
(SIGTERM, 30s, then SIGKILL). When the experimenter exits but something
`evaluate.sh` started is still running in its group, the tether stops that
too before the run is recorded as ended. Code that leaves its process group
on purpose (`setsid`) escapes this; the sandbox still applies to it. One experiment directory belongs
to one agent: config that lists it twice is refused at load, and two agents
never run in the same directory at once, even through a symlink. That comes with running agent-written code. Running the daemon
as a dedicated low-privilege user would narrow it further, but that's host
setup, not something this plugin can do.

The experiment path is operator config, and it's refused if it's inside, or
contains, any agent workspace or protected path. Whoever can edit
`evaluate.sh` gets code run on this host the next night.

## Set up

1. Install the experimenter and Claude Code where the daemon's `PATH` finds
   them, or set `overnightPath` and `claudePath`:
   `pip install overnight-experimenter`. Python 3.10 or newer is required.
   The experimenter runs the command `claude`, so `claudePath` must name a
   file called `claude`. To use a wrapper, put it in its own directory under
   that name.
2. Create an experiment: `overnight init ~/experiments/judge-prompt`, then
   write its `program.md`, `evaluate.sh` and `workspace/`. Run it once by hand
   to check it scores.
3. Store the experimenter's Anthropic key as the `dreams` channel's secret for
   the agent. It's a daemon secret, never something the agent can resolve:

   ```sh
   stratus channel set dreams --agent atlas anthropicApiKey
   ```

   With no key stored, no dream runs and the daemon log says so once. Logging
   `claude` in instead isn't supported: a login in the run's config directory
   would be as readable to `evaluate.sh` as a key in its environment.
4. Enable the plugin in a trusted config:

   ```jsonc
   // ~/.stratus/config.json
   {
     "plugins": {
       "@stratusagent/plugin-dreams": {
         "enabled": true,
         "agents": {
           "atlas": {
             "window": "23:00-07:00",
             "maxPerNight": 1,
             "experiments": [
               { "path": "/Users/me/experiments/judge-prompt", "budget": "6h", "direction": "maximize", "maxExperiments": 40 }
             ]
           }
         },
         // Optional: anything else the run must read, such as a pyenv Python.
         "readPaths": ["~/.pyenv"]
       }
     }
   }
   ```

5. Give the agent the tool in its soul (`tools: [dreams.report]`), and
   restart the daemon.

## How a night runs

- **Window:** two local times, which may cross midnight. A night is named by
  the date its window opened. A night the daemon was down for is skipped,
  never caught up.
- **Order and limit:** experiments run one at a time per agent, in config
  order, at most `maxPerNight` a night (default 1).
- **Budget:** `min(budget, time left in the window - 15 min)`. The
  experimenter can overrun its budget by one agent call plus one evaluation
  (up to 15 minutes). If less than 10 minutes remain, nothing starts. At the
  window's end the process group gets SIGTERM, then SIGKILL 30 seconds later.
- **Restarts:** a daemon restart ends that night's run, since the run goes
  with the daemon. `best/` and `experiments.jsonl` keep everything it got
  done, and the next night picks up from there.
- **At most once:** each experiment is claimed, and the claim synced to disk,
  before its process starts. If the daemon dies mid-run, the next daemon marks
  that experiment `interrupted` and moves on to the next experiment, once the
  old run has finished stopping and let go of its directory. The interrupted one isn't retried that
  night.
- **Report:** when a run ends, the plugin runs `overnight report` (same
  sandbox) and summarizes only the lines appended to `experiments.jsonl` that
  night: attempts, kept, not kept, failed, best score before and after, and up
  to five kept changes. The run's output goes to a log in the plugin's state
  directory, never to the daemon log.

## `dreams.report`

`safe`, read-only, and answers for the calling agent only. Input: optional
`night` (`YYYY-MM-DD`, default: the latest night with a dream). Its output is
labeled `external`, because descriptions and scores come from a file the
experimenting model can write.

To get the report posted in the morning, give the agent a schedule with a
destination ("post last night's dream report"). That's the existing way for a
schedule to speak, so this plugin grants no destination of its own.

Statuses: `running`, `finished` (check `exitCode`), `stopped-at-window-end`,
`stopped-by-daemon`, `interrupted`, `refused` (with `reason`),
`failed-to-start`.

## Why it registers a channel

A channel is what `stratus serve` starts and stops. Registering the nightly
clock as the `dreams` channel kind means it runs only under the daemon, never
in a one-shot `stratus run`, and the experimenter's key can be stored as that
channel's secret. It carries no messages, and nothing can be sent to it.

## Not in this version

- Prompt dreams (an agent turn from a dream file). Only `experiments` run.
- Running a night on demand.
- Linux.
- The experimenter's own `runner.py` ends with `from report import
  generate_report`, which looks broken when installed with pip. That's from
  reading the source, not from running it. The plugin runs `overnight report`
  itself, so a non-zero `exitCode` after a full run may be just that.

## Develop

```sh
npm test
```

The real-sandbox test runs only where `sandbox-exec` can be applied. It can't
be applied inside another sandbox, so there it's skipped and says why.
