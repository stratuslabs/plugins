# @stratusagent/plugin-a2ui

Lets an agent show a native screen. The screen is
[A2UI v1.0](https://github.com/a2ui-project/a2ui/tree/main/specification/v1_0)
JSON, built from component catalogs you configure and checked before it
leaves the agent.

| Tool | Risk | What it does |
| --- | --- | --- |
| `ui.catalog` | `safe` | Lists the configured catalogs, or returns one catalog's `instructions`, its component and function schemas, and the definitions those schemas refer to (`commonTypes`, `catalogDefs`). |
| `ui.render` | `safe` | Validates A2UI messages for one surface and hands them to the client. |

It also contributes one skill, `a2ui-screens`: when a screen beats a text
reply, how to build one, to prefer a server's ready-made screen, and never to
imitate an approval.

## How a client gets the screen

The plugin validates and does nothing else. The screen reaches a client the
way every tool call does, on the control API's event stream:

1. `tool.called` carries the call, and `call.input.messages` holds the A2UI
   messages.
2. `tool.completed` carries the result for the same `callId`. Render the
   messages only when `result.ok` is `true`.

On success the model gets `{ "surfaceId": "...", "accepted": true }` and
nothing else. Tool output is replayed to the model on every later turn, so the
screen is not repeated there; the client already has it from `call.input`.
`accepted` means the screen was valid and sent. It does not mean anyone saw
it.

On failure, `result.ok` is `false` and `result.error` is A2UI's standard
validation error as a JSON string, so the model can fix its own output:

```json
{ "code": "VALIDATION_FAILED", "surfaceId": "s1", "path": "/messages/1/updateComponents/components/0/text/@path", "message": "Text \"root\": Missing required property \"@path\"." }
```

`path` is a JSON Pointer into the tool input.

## What is checked

- Every message validates against A2UI v1.0 (JSON Schema 2020-12, via ajv),
  with the catalog's component schemas, plus `common_types.json`.
- Each component validates against its own catalog definition, so an error
  names the component and the field rather than a failed `oneOf`.
- One call is one surface. `createSurface` must come first and name the
  call's `catalogId`. Nothing may follow `deleteSurface`. A component may not
  name a different catalog.
- A surface created in the call must be a complete tree: one `root`, every
  child id defined (including list templates and nested slots such as
  `Tabs.tabs[].child`), and no cycles. Children are found by reading the
  catalog's schema for `Child` and `ChildList`, so this works for any catalog.
- An update to a surface an earlier call created is checked for cycles only.
  It may refer to components already on the device, and the plugin keeps no
  state between calls.
- `callRendererFunction` and `agentFunctionResponse` are refused. They need a
  round trip with the renderer that a tool call does not carry.
- The messages may be at most `maxMessagesBytes` (64 KB by default).

Not checked: `allowedParents` and `allowedChildren` (the renderer's
`UNALLOWED_PARENT` and `UNALLOWED_CHILD`), and whether data bindings resolve.

## Configure

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/plugin-a2ui": {
      "enabled": true,
      "catalogs": [
        { "url": "https://creatoros.work/a2ui/catalog/v1" },
        { "path": "~/catalogs/basic.json", "id": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json" }
      ],
      "maxMessagesBytes": 65536
    }
  }
}
```

```markdown
---
id: ava
tools: [ui.render, ui.catalog]
skills: [a2ui-screens]
---
```

- Each catalog is `{ path }` or `{ url }`. `id` is optional; when given, it
  must equal the catalog's own `catalogId`.
- A URL must be `https`, or `http` on localhost, and so must every redirect
  it follows (at most 5). It is fetched once, at startup, with a 15 second
  timeout and a 2 MB limit enforced while the body streams.
- Every catalog is loaded and compiled at setup. One that cannot be read,
  is not an A2UI v1.0 catalog, or does not compile refuses the plugin, so a
  bad catalog shows up at startup and not in the middle of a turn.

## Why `safe`

Neither tool acts on anything. `ui.catalog` reads the operator's own
configuration, and `ui.render` checks JSON and hands it to the person's own
client, which is the same reach as a text reply. A screen can't approve
anything. Approvals belong to whatever backend the screen is about.

`safe` holds only because the package is published under `@stratusagent/`.
Under any other name, Stratus floors both tools at `gated`.

## Test

```bash
npm install
npm test
```

The tests use A2UI's basic catalog and three of its examples, copied into
`test/fixtures/`.

## License

MIT. `schemas/v1_0/` and `test/fixtures/` hold files from A2UI under the
Apache License 2.0. See [NOTICE](./NOTICE).
