# @stratusagent/plugin-agui (spike)

**A spike for Post-V1 #36, "Should Stratus Agent speak AG-UI 1.0?"** Not
published, not for production. It exists so you can point an AG-UI client
at a Stratus agent and see what you get.

It registers an `agui` channel for one agent and serves
`POST http://127.0.0.1:<port>/` with an AG-UI `RunAgentInput`, answering
with a Server-Sent Events stream of AG-UI 1.0 events for one Stratus turn.

## Try it

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/plugin-agui": { "enabled": true, "agent": "blair", "port": 4319, "token": "pick-one" }
  }
}
```

```bash
curl -N http://127.0.0.1:4319/ \
  -H 'content-type: application/json' -H 'authorization: Bearer pick-one' \
  -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"hello"}],"tools":[],"context":[]}'
```

Any AG-UI client that speaks the HTTP + SSE transport (CopilotKit's
`HttpAgent`, for one) can use the same URL.

## What maps to what

| Stratus | AG-UI |
| --- | --- |
| a dispatch for the run | `RUN_STARTED`, then `RUN_FINISHED` (`outcome: success`) or `RUN_ERROR` |
| streamed text (`provider.delta`) | `TEXT_MESSAGE_START` / `_CONTENT` / `_END` |
| a non-streaming provider's reply | the same three, whole, one message per text part |
| `tool.called` | `TOOL_CALL_START`, `TOOL_CALL_ARGS` (the input as JSON), `TOOL_CALL_END` |
| `tool.completed` | `TOOL_CALL_RESULT` |
| the AG-UI `threadId` | one durable Stratus session, `agui:<agent>:<threadId>` |
| `tool.approval-requested` (a gated call parks) | the call's `TOOL_CALL_*` events, then `RUN_FINISHED` with `outcome: interrupt` (`reason: tool_approval`, `toolCallId`, `expiresAt`, a `responseSchema` for the answer) |
| a `RunAgentInput` with `resume` entries | `gateway.resolveApproval` for each, and the same turn streams on as the new run |
| `tool.denied` | `TOOL_CALL_RESULT` with `{"error":"denied"}` |

Stratus keeps the conversation, so only the newest user message in
`messages` is sent on. A client that hangs up cancels the turn.

## Interrupts (approvals)

Under `approvals.mode: remote`, a gated call parks the turn. The run ends
with an interrupt and the turn keeps waiting in the gateway, so closing
that response does not cancel it. Answer with a new run on the same thread:

```bash
curl -N http://127.0.0.1:4319/ \
  -H 'content-type: application/json' -H 'authorization: Bearer pick-one' \
  -d '{"threadId":"t1","runId":"r2","messages":[],"resume":[{"interruptId":"<id>","status":"resolved","payload":{"answer":"once"}}]}'
```

`payload.answer` is `once`, `always` or `deny` (`always` is left out of the
`responseSchema` for a one-shot call); `payload.approved: true|false` also
works. `status: cancelled` is a denial. Anything else is refused rather
than read as a yes. A resume for an interrupt that is no longer pending
(answered in Slack or the dashboard, expired, cancelled) gets a 409, and so
does a new message on a thread that is waiting.

Whoever holds the token is an approver here. Slack checks its approver
list; this spike has no equivalent, which is the main thing a real version
would need.

## A provider that starts over

When a provider abandons a response partway (a fallback provider takes
over mid-stream, or the same provider retries), Stratus sends a `reset`
delta. AG-UI has no event that deletes a message, but `@ag-ui/client`
1.0.3 applies a `MESSAGES_SNAPSHOT` by dropping every text and tool
message whose id the snapshot doesn't list. So on a reset the emitter
ends the partial text message, then sends a snapshot of the thread
without it: the run's `input.messages` as the client sent them, plus the
messages this run has completed (text, tool calls, tool results), built
the way the client builds them from the events. A reset before any text
was streamed sends nothing.

## Not in the spike

- Events while no run is attached are dropped: if an approval times out
  after its interrupt, the turn finishes unseen and the next run on the
  thread starts fresh.
- Client-supplied `tools` and `state` (ignored), reasoning events, usage,
  `editedArgs` on resume.
- Authentication beyond a static token on a loopback-only port.

## Verified

- Reset, not committed (`scratch/agui-client/smoke-reset.mjs`): a real
  `HttpAgent` (`@ag-ui/client` 1.0.3, verifier on) against a real gateway
  (agent 0.13.5) whose primary provider, a plugin, streams "abandoned half"
  and then throws, with a non-streaming plugin provider as the configured
  fallback. The client ends with the user message and "Fallback answer."
  only, and every event passes `EventSchemas`. On the previous head the
  same run left the client with "abandoned half" and no answer at all: the
  fallback's one-piece reply was skipped because the abandoned attempt had
  streamed.
- Reset after earlier messages in the same run, not committed
  (`scratch/agui-client/reset-client.mjs`): the emitter fed into a real
  `AbstractAgent` with three prior messages, a text message, a tool call
  and its result, then a reset mid-text. The client keeps all of those in
  order and ends with the fallback answer; on the previous head it ended
  with the partial.

- Real AG-UI client, not committed: `HttpAgent` from `@ag-ui/client`
  1.0.3 (its event verifier on) against a real gateway (agent main
  146b74b) with this plugin loaded through the plugin loader and the demo
  provider. Three runs on one thread: two text runs, then one with a tool
  call and its result. Every event passed `EventSchemas` from
  `@ag-ui/core/schemas` 1.0.3, the client built the expected message list
  (assistant text, assistant tool call, tool result, assistant text), and
  a wrong token got a 401. Not checked: a real model provider, a browser
  UI such as CopilotKit, and interrupts through `HttpAgent`.

- Unit: input validation; delta, tool call and result mapping; per-session
  filtering; reset retraction by snapshot; interrupt then resume (approved
  and cancelled) over real HTTP against a fake gateway, including the
  409s; strict resume parsing.
- Interrupt end to end, not committed: a real gateway (agent main 8c5ebb6)
  with `approvals.mode: remote`, this adapter, and a fake OpenAI endpoint
  that calls `schedule.every`. Run 1 ended with the interrupt while the
  call stayed parked; run 2 resumed it with `answer: once`, the schedule
  was created, and the run finished. All 11 events passed `EventSchema`.
- End to end, not committed: a real Stratus gateway with this plugin loaded
  through the plugin loader, a fake OpenAI endpoint, and an HTTP POST. The
  run streamed `RUN_STARTED`, a tool call with its result, a text message,
  and `RUN_FINISHED`. Every event passed `EventSchema` from `@ag-ui/core`
  1.0.2.
