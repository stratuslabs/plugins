`error-invalid-key.json` is a real response, captured from the live API on
Oct 27, 2026 with a made-up key: Brave answers a bad key with HTTP 422 and
`meta.component: "authentication"`, not 401.

The others are not captured. Each follows the response schema in Brave's
Web Search API reference
(https://api-dashboard.search.brave.com/api-reference/web/search/get), with
made-up values. The plugin reads only the HTTP status, the rate-limit
headers, `web.results[].title/url/description/page_age`, and the error's
`code`, `detail` and `meta.component`, so a field these files get wrong
can't change what it does beyond a message. The 200 fixture's description
keeps Brave's highlight markup on purpose, to show it is stripped if Brave
sends it despite `text_decorations=false`. Replace these with captured
responses after the first live check with a real key.
