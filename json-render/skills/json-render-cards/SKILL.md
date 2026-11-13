---
name: json-render-cards
description: When and how to post a native card with chat.card (a json-render spec), and when to answer in plain text instead.
---

# Posting a card with chat.card

`chat.card` posts a card in the conversation you are answering: a native
Slack message with a header, fields, a table, charts, text and link buttons.
Use it when the answer is mostly numbers or rows a person will scan: a
status rollup, a short list of items with their state, a comparison, a
trend. Everything else is a text reply, and so is anything a person needs
to copy, quote or reply to line by line.

The card goes in the thread with your reply, in order. Don't repeat its
contents in your reply: say in a line what it shows or what to look at.
Where blocks can't be shown (Discord, for one), the card is posted as its
text, so make that text read well too: give the Card a title and the
Fields and Table clear labels.

## The spec

Call `chat.card` with the spec itself: `root`, `elements`, and optional
`state`. `elements` is a flat map from a key you choose to an element:

```json
{
  "root": "card",
  "elements": {
    "card": { "type": "Card", "props": { "title": "Open PRs", "subtitle": "Nov 7, 09:00 ET" }, "children": ["counts", "table", "links"] },
    "counts": { "type": "Fields", "props": {}, "children": ["open", "review"] },
    "open": { "type": "Field", "props": { "label": "Open", "value": 13 }, "children": [] },
    "review": { "type": "Field", "props": { "label": "Waiting on review", "value": 4 }, "children": [] },
    "table": { "type": "Table", "props": { "headers": ["Repo", "Open"], "rows": [["agent", "4"], ["plugins", "6"], ["infra", "3"]], "align": ["left", "right"], "caption": "By repo" }, "children": [] },
    "links": { "type": "Actions", "props": {}, "children": ["agent"] },
    "agent": { "type": "LinkButton", "props": { "label": "Open agent PRs", "url": "https://github.com/stratuslabs/agent/pulls" }, "children": [] }
  }
}
```

## Components

- Card: { title?: string, subtitle?: string, imageUrl?: string } - Root of a message. Title renders as the card header, subtitle as secondary text. [accepts children]
- Section: {  } - Groups related elements. [accepts children]
- Text: { content: string, style?: "plain" | "bold" | "muted" } - A paragraph of markdown text. Use muted for footnotes.
- Fields: {  } - Grid of label and value pairs. Children are Field elements. [accepts children]
- Field: { label: string, value: unknown } - One label and value pair inside Fields. Good for KPIs.
- Table: { headers: Array<string>, rows: Array<Array<unknown>>, align?: Array<"left" | "center" | "right">, caption?: string } - Table for row data. Every row has one cell per header. Right-align numeric columns.
- Chart: { title: string, chart: { type: "pie", segments: Array<{ label: string, value: number }> } | { type: "bar" | "line" | "area", categories: Array<string>, series: Array<{ name: string, values: Array<number> }>, xLabel?: string, yLabel?: string } } - Chart. pie for shares of a whole, bar, line or area for series over categories.
- Divider: {  } - Separator between groups.
- Image: { url: string, alt: string } - Image from a public https URL.
- Actions: {  } - Row of LinkButton elements. [accepts children]
- LinkButton: { label: string, url: string } - Button that opens an http or https URL. The only kind of button a card can hold.

## Rules

- The root element is a Card. Every other element is a descendant of it.
  To group elements inside the card, use Section, not another Card.
- Every element has a `children` array. Leaf elements use `"children": []`.
- Field elements are children of a Fields element. LinkButton elements are
  children of an Actions element.
- There is no plain Button. A card can't take a click back: link buttons
  open their URL and nothing else.
- Text is markdown: `**bold**`, `_italic_`, `` `code` `` and
  `[label](https://url)`. No headings inside Text.
- Every series in a bar, line or area Chart has exactly one value per
  category, in category order. Pie values are above 0.
- A card is static once posted. `state` with `{ "$state": "/path" }`,
  `repeat`, `{ "$template": "..." }` and `visible` are resolved when the card
  is built. Leave out `on`, `$bindState` and `$bindItem`: there is nothing
  to press or fill in.
- Mentions in a card (`<@U123>`, `<!here>`) are shown as text and notify
  nobody. Mention people in your reply instead.

## Limits

Past these, Slack would show a table or chart as a code block or cut the
message short, so the card is refused instead and you are told why:

- 1 Table per card, at most 100 rows counting the header, 20 columns and
  10,000 characters across its cells.
- 2 Charts per card. A chart's title is at most 50 characters, each label
  at most 20, at most 12 series or segments and at most 20 categories.
- At most 10 Field elements in a Fields, and 25 LinkButtons in an Actions.
- At most 50 blocks in all. The title, the subtitle, and each Text, Fields,
  Table, Chart, Divider, Image and Actions is one block; a Section is the
  blocks of what it holds.
- Images and the Card's `imageUrl` are https URLs. LinkButton URLs are http
  or https. No spaces in either.

## When it's refused

A bad spec comes back as an error listing each problem with the element
key it is about, for example `f1.props.label: Invalid input: expected
string, received undefined`. Fix each one and call `chat.card` again. If
you can't make the card fit, answer in text.
