# @stratusagent/plugin-discord (in progress, not loadable yet)

A Discord channel for Stratus: each agent answers as its own Discord bot in
DMs and in guild channels you allowlist. The plan and its decisions are in
the private plans repo (roadmap/20, V1 section).

Built so far: config parsing, admission (who and where the bot answers),
session routing (DM, thread, a top-level mention opening a thread), and
splitting replies to Discord's 2000-character limit. Not built yet: the
Gateway connection, sending and streaming, approvals, restart backfill, and
the plugin entry point. The package stays private until then.
