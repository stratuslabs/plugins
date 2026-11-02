# @stratusagent/memory-upkeep

Lets an agent keep its memory up to date without being told to. Once a
conversation has gone quiet, this plugin asks core for a **save pass**: a
short model run, as the agent, that reads what was said since the last pass
and keeps any lasting facts. Once a night it asks for **tidy passes**, which
merge duplicate facts into one.

Core runs every pass and enforces every rule: which conversations a pass may
read, the trust label each fact carries, one pass per agent at a time, at
most once per slice of conversation, and the ledger that `stratus memory
undo-pass` reads. This plugin only decides **when** to ask. It works from
bus events and fleet metadata and never sees a message or a fact.

It needs a daemon (`stratus serve`) running `@stratusagent/core` 0.14.3 or
later, which has the memory pass seam. `stratus run` can't run passes.

## Install and enable

```bash
npm install -g @stratusagent/memory-upkeep
```

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/memory-upkeep": {
      "enabled": true,
      "model": "claude-haiku-4-5",
      "tidy": { "window": "03:00-05:00", "timeZone": "America/New_York" },
      "agents": {
        "atlas": {},
        "blair": { "save": { "quietMinutes": 45 } }
      }
    }
  }
}
```

Only the agents listed under `agents` are enrolled; with none listed the
plugin loads and does nothing. Settings at the top level are defaults for
every listed agent, and an agent's own block overrides them key by key,
inside `save` and `tidy` too. `{}` takes the defaults.

| Setting | Default | What it does |
| --- | --- | --- |
| `mode` | `"shadow"` | `"shadow"` writes what a pass would have saved to `memory-shadow.jsonl` beside the agent's memory, and changes no real fact. `"write"` saves for real. Run shadow first and read what it would save. |
| `model` | the agent's own | The model a pass runs on, exactly, with no fallback. A small model is enough. |
| `save.quietMinutes` | `30` | How long after a conversation's last turn ends before its save pass. A new turn restarts the wait. |
| `save.from` | `["public"]` (core's default) | Which conversations may be read: any of `public`, `private`, `group`, `direct`. The operator's own sessions (the CLI, the control API), which have no channel, always count. A fact saved from a DM would show up in every channel that agent is in, so think before adding `direct`. |
| `save.scheduled` | `false` | Also read the sessions of schedules and event triggers. |
| `tidy.window` | none, so no tidy | `"HH:MM-HH:MM"` on a 24-hour clock. A window may cross midnight. |
| `tidy.timeZone` | the host's | The window's time zone, as an IANA name. Set it on a server whose clock is UTC, such as Fly. |
| `tidy.maxGroupsPerNight` | `10` | The most tidy passes a night, per agent. `0` turns tidy off for that agent. |

The plugin checks the window, the time zone and the numbers when the daemon
starts, so a typo stops the start with the setting named.

## When it asks

- **A turn ends:** the session joins the due list, due `quietMinutes` later.
  A failed or cancelled turn counts too.
- **The floor rose:** when core trims a session's context during a turn, the
  session is due as soon as that turn ends, with no quiet wait, so a busy
  thread that never goes quiet is still saved, one slice at a time.
- **The answer:**
  - `done` with more to read: asked again at once.
  - `done` with nothing more, or `nothing-new`: leaves the list.
  - `skipped` because a turn is running: stays, and is asked again a quiet
    wait after that turn ends.
  - `skipped` because the daemon is still loading or another pass is
    running: asked again a minute later. Neither costs a model call.
  - `skipped` for a reason only a config change lifts (a DM or private
    channel not in `save.from`, a schedule's session, a sub-agent's, a
    store that can't take passes): leaves the list.
  - `failed`: asked again after 5, 10, 20 and 40 minutes, then hourly. After
    6 failures in a row the session leaves the list until its next turn ends,
    with a warning in the daemon log.
  - `interrupted` (the daemon is stopping): the restart picks it up. If the
    daemon is somehow still running, it is asked again a minute later.
- **A restart:** the list lives in memory. On start, every session of a
  listed agent updated in the last 7 days joins again, due a quiet wait after
  its last update. Core answers `nothing-new` for one already saved through
  its end, without a model call.
- **Tidy:** once a night inside the window, up to `maxGroupsPerNight` tidy
  passes per agent, one at a time, stopping when nothing more waits. A failed
  night is tried again the next night. What a night has spent is kept in
  `tidy.json` in the plugin's state directory, so a restart inside the window
  carries on under the same cap instead of starting it over. Tidy merges need a memory store that
  takes a list in `supersedes`: the built-in file store does. On one that
  doesn't, the daemon log says so once and save passes still run.

One pass runs at a time across the whole fleet.

## Seeing what it did

```bash
stratus memory passes atlas             # every pass: kind, mode, status, reason, counts
stratus memory list atlas --pass <id>   # what one pass wrote
stratus memory undo-pass atlas <id>     # forget it all; what it replaced is live again
```

Nothing is ever posted to a channel. Passes count against the agent's
budget like any other provider call.

## Turning it off

Remove the agent from `agents`, or remove the plugin, and restart the
daemon. What passes already wrote stays; `undo-pass` takes it back one pass
at a time.
