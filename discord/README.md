# @stratusagent/plugin-discord (in progress, not published)

A Discord channel for Stratus: each agent answers as its own Discord bot in
DMs and in guild channels you allowlist. The plan and its decisions are in
the private plans repo (roadmap/20, V1 section).

## Setup (as built so far)

1. Create one Discord application per agent. Under Bot, turn on
   "Message Content Intent".
2. Store its token as the channel's transport secret, never as an agent
   credential: `stratus channel set discord --agent <id> botToken`.
3. Enable the plugin. Settings at the top of the block apply to every agent;
   `agents.<id>` replaces a key for one agent (lists are replaced, not
   merged). Everything is a Discord id, never a name:

```jsonc
"@stratusagent/plugin-discord": {
  "enabled": true,
  "allowFrom": ["<your user id>"],   // who may DM the agent
  "approvers": ["<your user id>"],   // required: who may answer its approvals
  "guilds": { "<guild id>": {} },     // guilds it works in; mention needed by default
  "agents": { "ava": { "guilds": { "<guild id>": { "channels": { "<channel id>": { "requireMention": false } } } } } }
}
```

4. Invite each bot to its guilds with View Channels, Send Messages, Send
   Messages in Threads, Create Public Threads, Read Message History and
   Attach Files. Without Create Public Threads it answers a mention in the
   channel, as a reply. Replying to one of those answers (Discord's Reply)
   carries that conversation on, after a restart too; a new mention there
   starts a new one.

Every agent with a stored token is on Discord; one with no approvers in
either place fails the load with its name.

## Built

- Config, admission (who and where the bot answers), session routing (DM,
  thread, a top-level mention opening a thread) and chunking to Discord's
  2000-character limit.
- The Gateway connection (`@discordjs/ws`: heartbeats, resume, reconnect; a
  refused token or Message Content intent fails with what to fix) and REST
  sends (`@discordjs/rest`: posts that ping nobody and show no link
  previews, edits, deletes, typing, a thread per conversation).
- The plugin entry point and adapter: each admitted message is a turn on
  its session, with the sender's trust label (`user` for a principal,
  `unknown` for anyone else, including other bots).
- Streaming: the first words post at once, then edits at most every 1.5s.
  Words before a tool call stay as their own message, a running tool shows
  as `⚙ name…`, a long reply continues in new messages, and the final reply
  replaces the streamed text.

- Approvals: a gated call in a Discord conversation is asked there, with
  Allow once / Always allow / Deny buttons (no Always where nothing would be
  remembered). Only the agent's approvers can decide; anyone else is told
  privately and the request stays pending. Every ending rewrites the prompt
  without buttons. A request from another surface's conversation is left
  to that surface.
- Stop: an approver sending `stop` in a DM or thread, or as a reply to an
  answer in a channel, ends the running turn, which keeps what it said and
  adds who stopped it. With nothing running, `stop` is an ordinary message.

- Destinations and reads: `message.send` and schedules post to
  `discord:<channel id>` (with `thread` naming a thread in it, or a message
  to reply under), and `message.read` reads a channel or one thread in it.
  Both stop where admission stops: a server under `guilds`, only its listed
  channels when it lists them. A DM is a destination only when it is with
  someone in `allowFrom` or `approvers`, and is never read. Ids only.

- Restarts: a message sent while the daemon was down (or reconnecting
  after Discord dropped the session) is answered once it is back. Each
  conversation's read position is kept in the plugin's state directory
  (`positions.json`); a message being answered holds it until its answer
  is out, and one that reached a daemon on its way down is told so and
  kept. A turn still running when the channel stops gives up its reply
  there: nothing more is posted for it, and the next start answers it from
  the session. Only conversations the agent has answered in are read,
  back at most a day and 200 messages each.

- Attachments sent to the agent: an image the model can take (PNG, JPEG,
  GIF, WebP, within core's size, pixel and count limits) goes with the
  turn as an image, and a small UTF-8 text file (100 KB each, 200 KB a
  message) is read into it. Anything else is named, with why it wasn't
  read, so the agent says it has only the name. Files are fetched only once
  a message is admitted, only from Discord's CDN over https, without the
  bot token, within 30s a message.

- Files the agent sends: a file a tool made during a turn (an ok result's
  `file` or `files`) is uploaded into the conversation in its place, below
  what was said before the tool and above what comes after, and a
  `message.send` destination takes uploads too. Up to 10 MB a file, the
  most Discord takes from a bot in a server with no boosts; a failed upload
  is logged and the turn goes on.

## Not built yet

Saving a large text file someone sends to the agent's workspace instead of
naming it: that needs the host's tainted-write ledger, which plugins don't
get.

## Connecting

Each bot connects on its own when the daemon starts. One that can't reach
Discord, or gets no answer in a minute, tries again after 5s, 15s, 1m, then
every 5m, until it connects or the daemon stops; the warning log says when.
A refused token or intent isn't retried, since it would be refused again.
Once connected, `@discordjs/ws` resumes or reconnects after a drop.

`@discordjs/ws` is pinned to 2.0.4: stopping works around a reconnect loop
in it (stratuslabs/plugins#20) using library internals, and the "closing
while Discord is unreachable" test checks that still holds after a bump.
