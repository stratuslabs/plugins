# @stratusagent/plugin-brave-search

`web.search` through the [Brave Search API](https://brave.com/search/api/).
An agent gets titles, URLs and snippets back, and reads the pages with
`web.fetch`.

This is a backend for the shared
[`@stratusagent/search`](https://github.com/stratuslabs/agent/tree/main/packages/search)
contract. The tool name, its options, the result shape, the credential name
and the daily cap all come from that package, so another search backend can
replace this one without touching a soul or a skill.

## Set it up

```bash
npm install -g @stratusagent/plugin-brave-search
printf %s "$BRAVE_KEY" | stratus credential set search.apiKey
```

```jsonc
// ~/.stratus/config.json (a trusted config only)
{
  "plugins": {
    "@stratusagent/plugin-brave-search": { "enabled": true, "maxSearchesPerDay": 200 }
  }
}
```

Each agent that searches lists both the tool and the credential:

```markdown
---
id: blair
tools: [web.fetch, web.search]
credentials: [search.apiKey]
---
```

Without the `credentials:` line every call fails with "Agent blair is not
allowed to access credential: search.apiKey", and nothing is sent to Brave.

`web.search` is `safe`, so it runs without asking. What bounds spending is
the daily cap.

## Settings

All of them take a per-agent override under `agents`.

| Key | Default | What |
| --- | --- | --- |
| `maxSearchesPerDay` | `200` | Calls one agent may make in a UTC day. `0` turns that agent's search off. The count lives in the daemon's memory, so a restart resets it. |
| `allowedHosts` | none | Hosts exempt from the address check. Brave's API is public, so you won't need this. |
| `allowPrivateAddresses` | `false` | Turns the address check off. Don't. |

```jsonc
"@stratusagent/plugin-brave-search": {
  "enabled": true,
  "maxSearchesPerDay": 200,
  "agents": { "ava": { "maxSearchesPerDay": 0 } }
}
```

## How the options map to Brave

| Option | Sent to Brave | Notes |
| --- | --- | --- |
| `query` | `q`, with `operators=false` and `spellcheck=false` | Searched as literal text. Quotes, a leading `-` and `site:` aren't read as operators, and Brave doesn't swap in a spelling correction. |
| `count` | `count`, at most 20 | Brave's page size is 20, and one call is one Brave request, so a call returns at most 20 results whatever `count` says. |
| `site` | nothing; `count=20` | Brave has no site parameter, and `site:` in the query would be an operator. The shared tool keeps only that host and its subdomains from a full page, so a narrow site can come back with few or no results. |
| `freshness` | `freshness=<since day>to<today>` | Brave's range is in whole UTC days, so it can only be wider than asked. The shared tool then drops anything older than asked, and anything with no date. |

Results also carry `text_decorations=false` and `result_filter=web`, so
titles come back without highlight markup and the answer has only web
results.

Brave's `page_age` has no time zone. This plugin reads it as UTC. That
hasn't been checked against real pages yet (see below).

## When it fails

Every failure is an error the agent sees, with what to do next:

- **A bad key.** Brave answers a bad key with HTTP 422, not 401. The error
  names `search.apiKey` and the command to store it again, never the key.
- **The monthly quota is used up.** The error says how big the quota is and
  when it resets, from Brave's `X-RateLimit-*` headers. It isn't retried.
- **The per-second rate limit.** Some Brave plans allow one request a second,
  so two searches in one step can hit it. The plugin waits for the
  window (up to 2 seconds) and tries once more. If that fails too, it says so.
- **Anything else.** The HTTP status and Brave's own error code and reason.

A failed call still counts against `maxSearchesPerDay`. A cancelled turn
stops the request. The daemon's log records that a search ran, for which
agent, and how many results came back. It never records the query.

## What has been checked

- Tests run against a local stand-in for Brave's API. The response files in
  `test/fixtures` follow Brave's documented schema. One of them is a real
  response: the bad-key answer, captured from the live API on Oct 27, 2026.
  The rest have made-up values.
- Not checked yet, because that needs a real key: a successful live search;
  that Brave accepts `operators=false`, `text_decorations=false` and a date
  range together; that `page_age` is really UTC; and the real 429 headers.
