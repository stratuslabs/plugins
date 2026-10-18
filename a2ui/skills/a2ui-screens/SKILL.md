---
name: a2ui-screens
description: When and how to show the person a native screen with ui.render (A2UI v1.0), and when to answer in text instead.
---

# Showing a screen with ui.render

`ui.render` puts a native screen on the person's device. It is for the moments
a screen does better than a paragraph: a report with numbers to compare, a
preview of something about to go out, a checklist, a form. Everything else is
a text reply.

## When to show a screen, and when not to

- Answer in text when the answer is a sentence or two, when you are asking a
  question, or when nothing about the answer is visual.
- Show a screen when the person needs to look at structured content, or act on
  it, and text would make them read a wall of numbers or fields.
- Only show screens when the person is on a client that renders them. If you
  are talking in Slack, a terminal, or anywhere else that only shows text,
  answer in text.
- **Prefer a ready-made screen.** When a connected server offers a tool that
  returns a screen (for example a `screens_show` tool that returns A2UI in its
  structured content), use that tool, not one you build yourself. The server's
  screen shows its real data in the layout its designers chose.

## Never imitate an approval

Never build a screen that looks like, or stands in for, an approval, a
confirmation of a send, a payment, or a sign-in. Approvals come only from the
backend that owns the action, through its own screen. A button you render is
not an approval, and nothing you render can authorize anything. If something
needs approval, say so in text and use the backend's own flow.

## How to build one

1. Call `ui.catalog` with no arguments to see which catalogs you have, then with
   a `catalogId` to read that catalog's instructions and component schemas.
   Follow the catalog's instructions.
2. Call `ui.render` with that `catalogId` and the messages for **one surface**:
   - `createSurface` first, with a new `surfaceId` and the same `catalogId`.
   - Then `updateComponents` with the components. List `root` first, then
     parents before their children. Children are referred to by id, never
     nested inline.
   - `updateDataModel` for the data the components bind to.
   Every message is `{ "version": "v1.0", "<kind>": { ... } }`.
3. A new surface must be complete in one call: exactly one component with id
   `root`, every child id defined, and no cycles.
4. To change a screen already shown, send `updateComponents` or
   `updateDataModel` for its `surfaceId`. To remove it, send `deleteSurface`
   alone.

### Common value shapes

- A text or number property takes a literal (`"Hello"`, `3`), a data binding
  (`{ "@path": "/user/name" }`), or a function call from the catalog
  (`{ "@call": "formatString", "args": { ... } }`). It is `@path`, not `path`.
- A single child is an id string: `"child": "title"`.
- A list of children is an array of ids, `["title", "body"]`, or a template
  repeated over a data list: `{ "path": "/items", "componentId": "item_row" }`.

## When ui.render fails

A failure is `VALIDATION_FAILED` with a `path`, a JSON Pointer into your input
such as `/messages/1/updateComponents/components/0/text`, and a one-sentence
`message`. Fix that spot and call again with the whole corrected input. Do
not describe the error to the person unless you cannot fix it.

A successful call returns `{ surfaceId, accepted: true }`. Accepted means the
screen was valid and handed to the client. It does not mean the person has seen
it, so do not say they have.
