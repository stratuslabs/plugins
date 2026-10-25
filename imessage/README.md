# @stratusagent/plugin-imessage

**Work in progress, not usable yet.** An iMessage channel for Stratus: you
text your agent from your phone and it answers, through Messages.app on a
Mac signed in to the agent's own Apple ID. No vendor, no account, no public
URL.

What is here so far is the part that reads `~/Library/Messages/chat.db`:

- `lib/chatdb.js` opens chat.db read-only and reads messages in ROWID
  order, each joined to its sender and chat. `classifyRow` says whether a
  row is a received message or something to skip: anything the account
  sent (the agent's own replies included), tapbacks, group membership and
  rename events, and empty rows. A row whose body can't be decoded is
  poison.
- `lib/body.js` reads a message body from `text`, or from
  `attributedBody` when `text` is empty, using `@parseaple/typedstream`.
- `lib/watermark.js` keeps how far each agent has read, durably. A first
  start begins at the end of chat.db, so old conversations are never
  replayed. A chat.db that was replaced or rebuilt is detected by its inode,
  its row count and the guid of the last row read. A watermark file that
  can't be read stops the agent rather than starting over and losing
  messages.

Sending, admission, approvals by text, `stratus doctor` checks and the
setup guide (the Apple ID, Full Disk Access and Automation permissions)
come next.

## Tests

```sh
npm install
npm test
```

The tests build a stand-in chat.db with the tables and columns Messages
uses. `test/fixtures/body*.bin` are `attributedBody` values written by
Foundation's `NSArchiver` on macOS 15.3.1 (`test/fixtures/make-bodies.swift`).
They have not yet been checked against rows from a real Messages database.
