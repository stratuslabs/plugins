# @stratusagent/plugin-budgets

Token budgets for model calls, per UTC day and month, for the whole install
and for each agent. Every call's usage goes into a ledger you can read. Once
a limit is spent, the agent's next model call is refused with a sentence
that says what ran out and when it resets.

It needs Stratus 0.13.7 or later, which asks plugins before every model
call. On an older Stratus the plugin refuses to load rather than load a
limit nothing enforces.

## Set it up

```bash
npm install -g @stratusagent/plugin-budgets
```

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/plugin-budgets": {
      "enabled": true,
      "home": { "daily": 5000000, "monthly": 100000000 },
      "daily": 1000000,
      "weights": { "cacheReadTokens": 0.1, "cacheWriteTokens": 1.25, "outputTokens": 5 },
      "agents": { "scout": { "daily": 200000 } }
    }
  }
}
```

Here the install may spend 5M weighted tokens a day and 100M a month across
all agents. Each agent may spend 1M a day, except `scout`, which gets 200k.

## Settings

| Key | Default | What |
| --- | --- | --- |
| `home.daily`, `home.monthly` | no limit | Weighted tokens the whole install may spend per UTC day or month. |
| `daily`, `monthly` | no limit | Weighted tokens each agent may spend per UTC day or month. |
| `agents.<id>.daily`, `agents.<id>.monthly` | the defaults above | One agent's own limit, replacing the default for that period. |
| `weights` | `1` for each bucket | Multipliers for `inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`. |
| `reservePerCall` | `50000` | What a call in flight counts until its usage arrives. See below. |

Limits are whole numbers, 1 or more. A misspelled key, a zero or a fraction
refuses the plugin at load, because a limit that's silently ignored is spend
you think is capped. An agent's entry takes only `daily` and `monthly`: the
install's total, the weights and the reserve are one setting each. Agent ids
match without regard to case, as they do everywhere in Stratus.

With no limits at all, the plugin keeps the ledger and refuses nothing.

## Weighted tokens, not money

A price table changes too often to build in, so you turn your plan into a
number once, here. The weights are what make that number mean something,
because the four kinds of token aren't priced alike. Under prompt caching
most of a long conversation's input is cache reads at about a tenth of the
input price. Counted one for one, cache reads would stop an agent at a
tenth of what you meant to allow. Set the weights to your provider's
relative prices: with input at `1`, Anthropic's cache reads are about `0.1`,
cache writes `1.25` and output `5`.

A bucket the provider didn't report counts nothing.

## When a limit is reached

A limit is checked before each model call, so the call that crosses it
still runs, and the one after it is refused. For a harness provider that
runs its own loop, such as Claude Code, one call is a whole turn. The
person in the conversation gets this, and no fallback model answers
instead:

> Agent scout has used its daily model budget (200,000 of 200,000 weighted
> tokens), so its model is not being called again until the budget resets at
> 2026-10-28 00:00 UTC. To continue sooner, the operator can raise
> plugins["@stratusagent/plugin-budgets"].agents.scout.daily in the trusted
> config.

The install's limits are checked first, so when both are spent the message
names the install's.

## The ledger

One file per UTC month in the plugin's state directory,
`~/.stratus/plugins/@stratusagent/plugin-budgets/usage-2026-10.jsonl`, one
JSON line per event, readable only by the daemon's user:

```json
{"v":1,"type":"usage","id":"…","at":"2026-10-27T03:00:00.000Z","agentId":"scout","sessionId":"…","turnId":"…","provider":"anthropic","model":"…","inputTokens":1200,"outputTokens":300,"cacheReadTokens":18000}
{"v":1,"type":"reserve","id":"…","at":"…","agentId":"scout","sessionId":"…","provider":"anthropic"}
{"v":1,"type":"settle","id":"<the reserve's id>","at":"…"}
```

A `usage` line is one model call, attributed, with the four kinds of token
kept apart. A call seen twice is counted once by its `id`. Tokens spent this
month by agent:

```bash
jq -s 'map(select(.type=="usage")) | group_by(.agentId)
  | map({agent: .[0].agentId, input: (map(.inputTokens // 0) | add), output: (map(.outputTokens // 0) | add)})' \
  ~/.stratus/plugins/@stratusagent/plugin-budgets/usage-$(date -u +%Y-%m).jsonl
```

The daemon and every `stratus run` that loads the plugin write to the same
file and read each other's lines before every check, so one limit holds
across them.

## Reserves, and what a crash costs

Before a call it allows, the plugin writes a `reserve` line. The reserve
counts `reservePerCall` against the limits until the call's usage arrives or
its turn stops, and then a `settle` line closes it. That does two things:

- Calls in flight count. Five sessions asking at once can't all slip in
  under a limit they'd cross together.
- A crash costs a known amount. If the process dies after a call was made
  but before its usage was written down, the reserve is never settled, and
  `reservePerCall` is what that call is charged for the rest of the day and
  month. Set it near what one of your calls usually costs.

If the ledger can't be written (a full disk, a permissions change), every
call an agent's limits cover is refused until it can, with an error naming
the directory. Usage that couldn't be written is kept in memory and written
before the next call. An agent no limit covers isn't stopped.

A line torn by a crash mid-write is skipped, the daemon log says so, and the
line written after it is still read.

## What it doesn't do

- Money. The ledger is tokens. Pricing them is yours.
- `stratus usage` or an API route. Read the ledger files.
- Usage from before the plugin was enabled, or from a Stratus that didn't
  load it.
- Credential leases. Those are planned separately.
