# @stratusagent/plugin-imessage (in progress, not published)

An iMessage channel for Stratus. You text your agent from your phone and it
answers, through Messages.app on a Mac signed in to the agent's own Apple
ID. No vendor, no account, no public URL.

**Not yet checked against a real Messages account.** Everything below is
built and tested against a stand-in `chat.db` and a real Stratus gateway.
The first live run on a Mac is still to come.

## Setup (as built so far)

1. **Give the agent its own Apple ID.** You can't text yourself: a message
   to your own Apple ID lands in your own notes-to-self thread on every one
   of your devices. Create an Apple ID for the agent (for example
   `ava.agent@icloud.com`).
2. **Sign it in to Messages on the Mac that runs `stratusd`,** under the
   macOS user the daemon runs as. Use a separate macOS user if you don't
   want your own Messages on that Mac. One macOS user runs one Messages
   account, so only one agent per macOS user can use iMessage. Without an
   iPhone attached to that Apple ID it is iMessage only: people reach the
   agent at its email address, from an iPhone, iPad or Mac.
3. **Grant Full Disk Access** to the Node binary that runs `stratusd`, in
   System Settings > Privacy & Security > Full Disk Access. The channel
   reads `~/Library/Messages/chat.db`, and without this grant it can't open
   it. The startup warning names the exact binary path. The grant is tied
   to that path, so after a Node upgrade (Homebrew, nvm) grant it again.
4. **Allow Automation** for Messages when macOS asks, the first time the
   agent sends something. It's under Privacy & Security > Automation.
5. **Enable the plugin.** Settings at the top of the block apply to every
   agent. `agents.<id>` replaces a key for one agent (lists are replaced,
   not merged), and only agents listed under `agents` are on iMessage:

```jsonc
"@stratusagent/plugin-imessage": {
  "enabled": true,
  "handle": "ava.agent@icloud.com",   // required: the Apple ID the agent sends as
  "approvers": ["+15551234567"],      // required: who can answer its approvals
  "principals": ["+15551234567", "you@example.com"], // trusted senders; default: the approvers
  "admit": "principals",              // default; "anyone" lets others in, labeled unknown
  "agents": { "ava": {} }
}
```

Handles are Apple ID emails or phone numbers in E.164 form
(`+15551234567`). There is nothing to store with `stratus channel set`:
local delivery has no secret.

## What it does

- **Reading.** The channel reads `chat.db` read-only, in ROWID order, scans
  every 3 seconds, and watches the WAL so messages arrive sooner. The first
  start begins at the end of `chat.db`, so old conversations are never
  answered. The channel skips its own replies, tapbacks, and group events.
- **Who it answers.** Someone counts as a principal only if they're on the
  `principals` list **and** Messages says the message came over iMessage.
  An SMS sender id can be forged, so SMS, RCS and unknown never count. With
  the default `admit: "principals"`, nobody else gets a turn. Group chats
  are refused for now.
- **Answers.** Each message becomes a turn in that person's session. The
  answer comes back as plain text: markdown removed, link URLs kept, and
  long answers split into several messages. If a turn fails, the person is
  told.
- **Approvals.** A tool call that needs approval is texted to the
  approver: `Reply Y K7QM2X to allow once, ALWAYS K7QM2X to always allow,
  or N K7QM2X to deny.`
  - The code is single use and expires with the request.
  - Only an approver writing over iMessage can answer.
  - A wrong code, a code sent over SMS, or a code from anyone else counts
    as a guess. Three guesses deny the request and tell the approvers.
- **Stop.** An approver who texts `stop` ends the turn running in their
  conversation.
- **Reaching out first.** `message.send` and schedules can text the agent's
  principals and approvers, and nobody else.
- **Restarts.** A message that arrives while the daemon is down is answered
  when it comes back. A message first read more than 24 hours after it was
  sent is skipped and counted, so a daemon that was off for a week doesn't
  act on a week of texts. Set `replayCapHours` to change that.
  - How far the channel has read is kept in the plugin's state directory
    (`watermarks.json`), written durably.
  - A message being answered when the daemon stops is read again at the
    next start, and the gateway's idempotency key keeps it from running
    twice. Messages already answered behind it are not answered again.
- **Logs.** The log names rows by number and masks handles
  (`+1•••••4567`). It never contains message text or approval codes.

## Not built yet

- Images and files sent to the agent: the text arrives, and the agent is
  told an attachment came with it (stratuslabs/plugins#24).
- Files the agent sends.
- Group chats.
- Recovery when `chat.db` is replaced (restored from a backup, or rebuilt
  by Messages). Today the agent stops reading and the log tells you to
  remove `watermarks.json`, which restarts reading from that moment
  (stratuslabs/plugins#23).
- The other delivery methods (`photon-local`, `photon`, `sendblue`).

## Risks

There is no official iMessage API. Apple can flag an Apple ID that
suddenly sends a lot, so this is for an agent talking to its own people at
human volume, with no delivery guarantee. If you point an agent at people
who didn't ask to hear from it, check the rules where you are on automated
texting and consent.

## Tests

```sh
npm install
npm test
```

The tests build a stand-in `chat.db` with the tables and columns Messages
uses. `test/fixtures/body*.bin` are `attributedBody` values written by
Foundation's `NSArchiver` on macOS 15.3.1 (`test/fixtures/make-bodies.swift`).
