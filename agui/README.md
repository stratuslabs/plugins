# stratus-plugin-agui (spike)

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
    "stratus-plugin-agui": { "enabled": true, "agent": "blair", "port": 4319, "token": "pick-one" }
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
| a non-streaming provider's reply | the same three, whole |
| `tool.called` | `TOOL_CALL_START`, `TOOL_CALL_ARGS` (the input as JSON), `TOOL_CALL_END` |
| `tool.completed` | `TOOL_CALL_RESULT` |
| the AG-UI `threadId` | one durable Stratus session, `agui:<agent>:<threadId>` |

Stratus keeps the conversation, so only the newest user message in
`messages` is sent on. A client that hangs up cancels the turn.

## Not in the spike

- **Interrupts.** A gated call under `approvals.mode: remote` parks the
  turn, and nothing here maps that to AG-UI's `RUN_FINISHED` interrupt
  outcome and `resume` entries. That mapping is the most interesting next
  step, since AG-UI's human-in-the-loop model and Stratus approvals line up.
- Client-supplied `tools` and `state` (ignored), reasoning events, usage.
- Authentication beyond a static token on a loopback-only port.

## Verified

- Unit: input validation; delta, tool call and result mapping; per-session filtering.
- End to end, not committed: a real Stratus gateway with this plugin loaded
  through the plugin loader, a fake OpenAI endpoint, and an HTTP POST. The
  run streamed `RUN_STARTED`, a tool call with its result, a text message,
  and `RUN_FINISHED`. Every event passed `EventSchema` from `@ag-ui/core`
  1.0.2.
