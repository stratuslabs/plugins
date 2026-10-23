# @stratusagent/plugin-peer

`peer.delegate` lets an agent on one Stratus daemon hand a task to an agent
on another daemon and get the answer back, the way `agent.delegate` works
within one daemon. The request goes over signed HTTP. Slack isn't involved,
so it works between machines that have no channel in common.

```text
home daemon                                 studio daemon
ava ── peer.delegate("studio/nova", …) ──▶  peer channel ──▶ nova's turn
    ◀──────────── nova's final reply ─────────────────────────┘
```

## Setup

On each daemon, install the plugin and enable it in `~/.stratus/config.json`
(a trusted config only):

```bash
npm install -g @stratusagent/plugin-peer
```

```jsonc
// on "home": it sends, so it names the peer it can reach
{
  "plugins": {
    "@stratusagent/plugin-peer": {
      "enabled": true,
      "self": "home",
      "peers": { "studio": { "url": "https://studio.internal:4180" } }
    }
  }
}
```

```jsonc
// on "studio": it receives, so it listens
{
  "plugins": {
    "@stratusagent/plugin-peer": {
      "enabled": true,
      "self": "studio",
      "listen": { "host": "0.0.0.0", "port": 4180 }
    }
  }
}
```

Then give each pair of agents a shared secret, stored on both sides under
the name of the *other* daemon:

```bash
# on home: ava's secret for studio
stratus channel set peer --agent ava studio
# on studio: nova's secret for home (the same value)
stratus channel set peer --agent nova home
```

`channel set` replaces everything that agent had on the `peer` channel, so
an agent paired with more than one daemon names them all in one command:
`stratus channel set peer --agent ava studio office`.

Last, grant the tool in the sending agent's soul with `tools: [peer.delegate]`
and restart both daemons.

| Key | Default | What it sets |
| --- | --- | --- |
| `self` | required | This daemon's name as its peers know it. Letters, digits, `.`, `_`, `-` |
| `peers` | none | Daemons this one may send to: `{ "<name>": { "url": "…" } }` |
| `listen` | off | `{ host, port }` to accept requests on. Default host `127.0.0.1`, port `4180`. The port is a whole number from 0 to 65535 |
| `maxDepth` | `3` | Hops allowed in a chain of delegations, across every daemon in the chain. A whole number from 1 to 100 |
| `timeoutMs` | 10 minutes | How long `peer.delegate` waits for an answer, in whole milliseconds (1 to 2147483647) |

## Who may reach whom

The secrets are the allowlist. Studio accepts a request for nova from home
only if nova holds a secret named `home` and the request was signed with
it. Home signs with the calling agent's own secret for studio, so an agent
with no secret for a peer can't reach it, and a daemon that claims another
daemon's name fails the signature check. A refusal reads `not allowed`
whether the agent doesn't exist or holds no secret, so the response reveals
nothing about the roster.

A request is also refused when:

- it's more than 10 minutes old, or more than a minute ahead of the
  receiver's clock (`stale`)
- its request id is already running or already answered (`already running`,
  `already answered`), so a retry never runs a turn twice
- it would exceed the hop budget (`depth limit`)

An answer from a peer is another agent's words. On the receiving daemon the
turn runs with sender trust `agent`, never as that daemon's principal. On
the sending side, `peer.delegate`'s output is labelled `agent`.

Use HTTPS, or plain HTTP on a private network only. The signatures cover
the bodies, but HTTP doesn't hide them. The answer is signed too, with the
same secret, and names the request it answers, so an answer that someone
on the path wrote or replayed comes back as `failed`, never as the agent's
words. Refusals sent before a request is admitted can't be signed, so
someone on the path can still make a call fail. They can't make it say
anything: an unsigned refusal or failure shows only fixed wording, never
text from the body. Answers over 4 MiB are dropped while they are read,
before the signature is checked.

## The hop budget spans daemons

Every request carries `depth` (hops taken so far) and `ceiling` (the lowest
`maxDepth` along the chain), both inside the signed body. The receiver runs
the turn at `depth + 1` under `min(ceiling, its own maxDepth)`, and refuses
when the depth has reached that limit. The budget is recorded in the
session id the turn runs under (`peer:<from>:<depth>.<limit>:…`). Stratus
copies that id as `rootSessionId` onto every session a turn delegates to,
so a local `agent.delegate` inside a remote turn draws from the same
budget. An A → B → A loop therefore stops once the budget is spent.

## What `peer.delegate` returns

| `status` | Meaning |
| --- | --- |
| `result` | `answer` holds the remote agent's final reply |
| `refused` | `reason` says why: the sender refused before sending, or the receiver refused |
| `failed` | The remote turn failed. No detail from the other daemon is passed on |
| `timed out` | No answer within `timeoutMs` |
| `unreachable` | The connection failed |
| `cancelled` | The caller's turn was stopped. The receiver aborts the remote turn when the connection closes, but the caller can't wait for confirmation, so the remote turn may still have finished |

## Not yet

- `message.send` to a peer, for a message that needs no answer
- A durable outbox, so a request interrupted by a restart is sent again
- Explicit cancel requests that the receiver confirms, including a cancel
  that arrives before its request

