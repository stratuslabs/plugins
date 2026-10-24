# @stratusagent/plugin-fleet

`fleet.*`: read-only tools for an agent that tells you what in your Stratus
fleet needs a person: a session that has been running far too long, a
schedule whose last run failed, a tool call that has waited all afternoon for
an approval.

Needs Stratus 0.13.4 or later, which added `PluginContext.fleet`
(stratuslabs/agent#412). On an
older one, `setup` fails and says so.

## Tools

| Tool | Returns |
| --- | --- |
| `fleet.agents` | Every agent the daemon serves, when each was last active, how many of its sessions are running or waiting on a person, and stored sessions counted by status |
| `fleet.sessions` | Sessions newest first: id, agent, status, created, last updated, minutes since that update. `agentId`, `status` and `limit` filter it (50 rows by default, at most 500) |
| `fleet.schedules` | Every schedule: agent, cadence, where it reports, next and last firing, and the status of the last firing's session |
| `fleet.approvals` | Every call waiting on a person: tool, agent, session, risk, when it parked and expires, minutes waiting |

All four are `safe`: they read metadata and change nothing. Content never
crosses the host's seam: no messages, no schedule prompts, no approval inputs.
The daemon logs each read as `fleet read: <method> by plugin
@stratusagent/plugin-fleet`, so `stratus logs` shows when the fleet was read.

Usage and cost are not here yet, because Stratus does not aggregate usage.

## Enable it

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/plugin-fleet": { "enabled": true }
  }
}
```

Only an agent whose soul lists the tools can call them. Give them to one
watcher agent, not to every agent.

## A fleet-watcher agent

A starting soul. Edit what counts as worth saying; that judgement is yours, not
the plugin's.

```markdown
---
id: watcher
name: Watcher
tools: [fleet.*, message.send, schedule.every, schedule.list]
---

You report on this Stratus fleet to the people who run it.

When asked for a report, call fleet.agents, fleet.sessions with status
running, fleet.schedules and fleet.approvals. Say only what needs a person:

- a session running for more than 60 minutes
- a schedule whose lastSessionStatus is failed
- an approval waiting more than 30 minutes, or about to expire

Name the agent and the session or schedule id for each. If nothing needs
anyone, say so in one line. Never guess at what a session was doing; you
can't read its messages, and that's on purpose.
```

The schedule is a separate step you approve. Ask the watcher, for example:
"Every weekday at 9am, post a fleet report in #ops." It calls `schedule.every`
with that cadence, prompt and destination, and you approve it once.
