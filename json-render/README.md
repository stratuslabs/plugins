# @stratusagent/plugin-json-render

`chat.card`: the agent posts a native Slack card in its thread, built from a
[json-render](https://github.com/vercel-labs/json-render) spec. A card can
hold a header, fields, a table, up to two charts, text, images and link
buttons. The spec is checked before anything is posted, and a bad one comes
back to the model as a list of problems it can fix.

The plugin builds the card and sends nothing itself. Its result carries the
card as a **post**, and the channel the conversation is on posts it in the
thread, in order with the agent's reply:

| Where | What shows |
| --- | --- |
| Slack | The card, as Block Kit. If Slack refuses the blocks, the card's text. |
| A channel without blocks | The card's text, once that channel posts tool posts. |
| The CLI | Nothing, as it shows no file. |

The model sees only the card's text in its history, not the blocks. The spec
it wrote stays in the call's input.

## Needs

Stratus 0.14.10 or later, whose core reads tool posts and whose Slack channel
sends them ([stratuslabs/agent#626](https://github.com/stratuslabs/agent/pull/626)).
An older daemon runs the tool but posts nothing, and shows the model the whole
result, blocks included.

## Setup

Install it next to the daemon, then enable it in a config you trust:

```jsonc
// ~/.stratus/config.json
{
  "plugins": {
    "@stratusagent/plugin-json-render": { "enabled": true }
  }
}
```

and give an agent the tool and the skill in its soul:

```markdown
---
id: blair
tools: [chat.card]
skills: [json-render-cards]
---
```

There are no settings. Your Slack app needs nothing new: `chat:write` covers
a card.

## The skill

`json-render-cards` tells the agent when a card beats a text reply, the
spec's shape, every component with its props (taken from json-render's own
catalog prompt), the rules, and the limits. After a change to the catalog,
`npm run skill` prints the component lines the skill must carry, and a test
fails until it does.

## What a card can hold

json-render's standard chat components, less one: `Card`, `Section`, `Text`,
`Fields` and `Field`, `Table`, `Chart` (pie, bar, line, area), `Divider`,
`Image`, and `Actions` with `LinkButton`. There is no plain `Button`: a post
has no handler for a click, so a card's buttons open links and do nothing
else.

Slack shows a table or chart past its limits as a code block, and cuts a
message past 50 blocks. The plugin refuses those cards instead and says
what to change: one table (100 rows counting the header, 20 columns,
10,000 characters of cells), two charts, 10 fields in a group, 25 link
buttons in a row, 50 blocks in all. Images are https URLs and links http or
https, the same test the Slack channel applies before it sends a card.

## Trust

`chat.card` is `safe`. It builds a message for the conversation the reply
goes to anyway: the same reach as the reply's own words, and its links are
links the model could write in text. The Slack channel checks the blocks
again before sending them: only display blocks and link buttons, each
button renamed so it can't stand in for an approval, and mentions shown as
text so a card notifies nobody. A result labelled `external`, such as an
MCP server's, never posts.

## Dependencies

[`@json-render/chat`](https://www.npmjs.com/package/@json-render/chat) and
`@json-render/core` 0.22.0 (Apache-2.0) check the spec and build a Chat SDK
card. The converter from
[`@chat-adapter/slack`](https://www.npmjs.com/package/@chat-adapter/slack)
4.44.0 (MIT) turns it into Block Kit. Only that package's `blocks` entry is
loaded, which starts no Slack client, but npm installs the whole package and
its dependencies: about 120 packages, none with an install script. Versions
are pinned while json-render is below 1.0.
