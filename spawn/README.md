# @stratusagent/tool-spawn

`agent.spawn`: one tool call that runs several tasks at once, each in a
short-lived **sub-agent**, and returns their answers together.

A sub-agent runs as the agent that spawned it, on the same provider and
credentials, but with only the tools it is handed and nothing else of the
agent's: no persona, no memory, no skills, no conversation. It is for
work that would otherwise fill the agent's own context: reading five pages
to compare them, triaging thirty pull requests, checking a draft with a
deliberately critical eye.

Needs a Stratus host with `PluginContext.subAgents` (stratuslabs/agent#370);
on an older one, `setup` fails and says so.

## Enable it

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/tool-spawn": { "enabled": true, "maxTasks": 8 }
  }
}
```

```markdown
---
id: blair
tools: [agent.spawn, web.fetch]
---
```

`maxTasks` caps how many tasks one call may carry (default 8, at most 32).

## What the host enforces

Everything that is a trust boundary is the daemon's, not this plugin's:

- A sub-agent's tools are exact names its parent may call itself.
  `agent.spawn`, `agent.delegate`, `memory.*`, and `credential.request` are
  refused whatever the parent holds. A refusal names the tool.
- A sub-agent never asks a person. A call that needs approval and has no
  standing grant fails inside the sub-agent, and the parent gets that back.
  The parent's standing grants and command scopes do apply.
- At most four run at once per parent turn; the rest wait. Cancelling the
  parent's turn stops them all.
- Each sub-agent's session is kept, as a child of the parent's
  (`<parent>:subagent:<depth>:<n>`), so you can read what it did.

## What comes back

```json
{ "results": [
  { "task": 1, "status": "result", "answer": "…", "sessionId": "…" },
  { "task": 2, "status": "refused", "error": "memory.remember is never given to a sub-agent…" },
  { "task": 3, "status": "error", "error": "…", "sessionId": "…" },
  { "task": 4, "status": "empty", "sessionId": "…" }
] }
```

One task failing is a result next to the others, not a failed call. The
call carries the least trusted label of the sub-agents that ran, since an
answer may repeat what a sub-agent read.

`agent.spawn` is `safe`, as `agent.delegate` is: it acts on nothing outside
Stratus, each sub-agent's own calls face the approval policy again, and a
sub-agent can only do less than its parent.

## Not yet

Choosing a cheaper model per task (from a list you set), memory proposals
a sub-agent can hand back, and per-task notes. See roadmap 24.
