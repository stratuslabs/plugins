# @stratusagent/plugin-imessage-photon

Text a Stratus agent from your phone over iMessage, on a line
[Photon](https://photon.codes) hosts. You don't need a Mac, an Apple ID for
the agent, or a public URL. The daemon connects out to Photon, and texts
arrive over that connection.

The plugin is built on Photon's Stable platform (Spectrum) and talks to it
through Photon's Advanced iMessage SDK (`@photon-ai/advanced-imessage`)
over gRPC.

> Every message passes through Photon's servers. Read Photon's terms and
> privacy policy before you put anything sensitive on this channel.

## What it does

- **One-to-one chats.** The agent answers each person in the chat they
  texted from, with one ongoing session per person. It refuses group chats
  for now.
- **Only the people you list.** By default the agent answers only its
  `principals`. Photon must also say iMessage carried the text, because an
  SMS sender id can be forged. Set `admit: "anyone"` to answer strangers
  too; their turns are labeled `unknown`.
- **Approvals by text.** A gated tool call goes to the agent's approvers as
  a text with a six-character code. An approver answers `Y K7QM2X`,
  `N K7QM2X` or `ALWAYS K7QM2X`. A code only counts when an approver sends
  it over iMessage. Three wrong answers deny every request that's waiting,
  and the approvers are told someone may be guessing.
- **`stop`.** When an approver texts `stop` during a turn in their chat,
  the turn ends.
- **Nothing lost across a restart.** Photon keeps a numbered log of each
  line's events. The plugin stores how far it has read each line. At the
  next start it replays the log from there, so texts sent while the daemon
  was down are answered, and none is answered twice. Every text goes out
  with an id its retries reuse, and a reply keeps its id across a restart,
  so when Photon gets a text twice it keeps one copy. Catch-up
  skips texts older than `replayCapHours` (default 24) and logs them.
- **`message.send` and schedules.** The agent can text its principals and
  approvers first, and nobody else. On a shared-pool line the person has
  to have texted the agent first.
- **Files.** The agent is told the name and type of each photo or file it
  was sent. It can't open them yet.

## Set it up

1. Create a project at [app.photon.codes](https://app.photon.codes) and
   give it an iMessage line. On the Free and Pro plans the line comes from
   a shared pool: the number can differ per person, and there are no group
   chats. Business gives you one dedicated number. The project id is a
   UUID. A `pho_prj_` id is a Photon 2.0 (Beta) project, which this plugin
   doesn't use.
2. Install and enable the plugin in `~/.stratus/config.json`:

   ```jsonc
   {
     "plugins": {
       "@stratusagent/plugin-imessage-photon": {
         "enabled": true,
         "approvers": ["+15551234567"],
         "principals": ["+15551234567", "you@icloud.com"]
       }
     }
   }
   ```

3. Store the project id and secret for the agent that answers on the line.
   The command asks for each value and doesn't echo it:

   ```sh
   stratus channel set imessage-photon --agent ava projectId projectSecret
   ```

4. Restart the daemon (`stratus restart`), then text the line from a phone
   whose number or Apple ID is in `principals`.

Each agent has its own Photon project. The texts sent to a line before the
agent's first start are history and get no answer.

## Configuration

Settings at the top are every agent's defaults. An entry under
`agents.<id>` replaces a setting for one agent. Lists replace each other;
they aren't merged.

| Setting | Default | What it does |
| --- | --- | --- |
| `approvers` | required | Phone numbers (E.164, like `+15551234567`) or Apple ID emails that may answer approvals by text and send `stop`. An approver who isn't a principal gets approvals in the chat they last texted the line from, though the agent doesn't answer their texts. |
| `principals` | the approvers | Who the agent answers, and trusts as a user, when iMessage carries the text. |
| `admit` | `"principals"` | `"anyone"` also answers strangers, as `unknown`. |
| `replayCapHours` | `24` | Catch-up after an outage skips texts older than this. |

## Where it keeps state

The plugin writes `<agentId>.json` in its state directory under the Stratus
home. The file holds the read position for each of the agent's Photon
lines. Each write goes to a temporary file that is renamed into place, and
only you can read it. If the file can't be read, the agent stays off the
line and the log names the file. Remove it to start reading from now on.
Texts sent since it was last written won't be answered.

## Limits

- A line added to the project while the daemon runs is picked up at the
  next restart.
- No group chats, and no reading of photos or files yet.
- Photon's default quotas apply: 5,000 sent messages per server a day, and
  50 new conversations per line a day.
- If Photon refuses the stored read position, for example because the log
  no longer reaches back that far, the plugin starts again from the head of
  the log. It logs a warning that texts sent in between may go unanswered.
