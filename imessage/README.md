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

- `lib/intake.js` reads new rows for one agent in ROWID order and hands
  each received message on. The watermark only moves through messages
  that are fully dealt with, so a restart in the middle of an answer reads
  that message again (the gateway's idempotency key keeps it from running
  twice). Rows are recorded as read before they are handed on. A message
  first read more than 24 hours after it was sent is skipped and counted:
  after a long outage, or when Apple's servers replay a backlog. A row that
  can't be read yet holds the rows behind it and is retried a few times
  before it is skipped. A periodic scan is the guarantee; a watch on the
  WAL just makes delivery quicker.
- `lib/config.js`, `lib/admission.js` and `lib/handles.js` cover who the
  agent answers. Someone counts as a principal only if they're on the
  `principals` list **and** Messages says the message came over iMessage.
  An SMS sender id can be forged, so SMS, RCS and unknown never count. By
  default nobody else gets a turn. Group chats are refused for now. Only
  one agent per macOS login can use local delivery, and off macOS it is
  refused with the reason.

- `lib/adapter.js` and `index.js` are the channel. Each admitted message
  becomes a turn in that person's session, keyed so a repeat never runs
  twice, and the answer goes back as plain text through `osascript`
  (`lib/send.applescript`, with the handle and text passed as arguments,
  never as script). Long answers go as several messages. Turn failures and
  refusals are told to the person. A daemon on its way down says so and
  answers after it restarts. `resolveOutbound` (for `message.send` and
  schedules) only texts the agent's principals and approvers.

Approvals by text, attachments, `stratus doctor` checks, recovery after
chat.db is replaced, and the setup guide (the Apple ID, Full Disk Access
and Automation permissions) come next. Until approvals land, a tool call
that needs approval waits for one that can't be given over iMessage.

## Tests

```sh
npm install
npm test
```

The tests build a stand-in chat.db with the tables and columns Messages
uses. `test/fixtures/body*.bin` are `attributedBody` values written by
Foundation's `NSArchiver` on macOS 15.3.1 (`test/fixtures/make-bodies.swift`).
They have not yet been checked against rows from a real Messages database.
