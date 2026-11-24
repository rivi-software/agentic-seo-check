# Premium features as a stack of pull requests: design

Issue #229, step 3. Date: 2026-11-24. Stacked on #239 (premium accounts), which supplies the accounts, `entitlement()`, `HostedProfile.paid` and `premium.agentic-seo.org`.

## Intent

The features in #229 cost money to run, so only paying subscribers get them:

- Rendering (#230)
- Lab performance (#222)
- Bigger crawls (#209)
- Watched sites (#228)
- Search Console (#226)
- Bing (#227)

Free callers on `agentic-seo.org/mcp` and the website keep today's tools, limits and anonymity, untouched. Each feature is its own pull request, stacked in the order below, so each can be reviewed and merged on its own.

## Decisions from the maintainer

- **All six features**, as a stack, built by subagents with a review per task.
- **PageSpeed Insights:** premium only. Before asking Google, it checks the site's robots.txt for `agentic-seo-check` and refuses when the site disallows us. The bot's promise (#41) holds even when Google does the fetching.
- **Bing:** the subscriber pastes their Bing Webmaster API key on `/account`. It is stored encrypted in the EU accounts database and never passes through a tool call or the conversation. It is deleted with the account.
- **Watched sites:** up to 5 per account, audited weekly. `seo_watch_report` returns what regressed, and an email goes out when something did.
- **500-page crawls keep every site rule:** the site rules are rewritten to read a slim, storable record per page instead of the full parsed page, so they run on all 500 pages and the audit says the same at any size.
- **A separate daily request budget for paid traffic:** var `PAID_DAILY_REQUESTS`, 100,000, counted in the Durable Object beside today's count. Free traffic keeps `DAILY_REQUESTS`, untouched, so neither tier can use up the other's day.
- **Search Console and Bing live in the core,** like field data: record types, options and rules in `src/core/`, so the CLI can add them later with the user's own credentials. On the hosted server, only subscribers get them. Shared reports drop this data, as they drop Lighthouse (`shared-schema.ts` lists the keys as dropped).
- **When a subscription ends:** watches stop running and connections go unused at once. If the subscription is not back within 30 days, the watches, their reports, the Google token and the Bing key are deleted. A daily cron does the deleting, and `/account` says so.
- Earlier decisions stand (#229, the accounts design):
  - one entitlement check
  - `paid` and nothing else in analytics
  - no exception to robots.txt, signing or `Crawl-delay` for a paying caller
  - Stripe in test mode until launch

## Shared rules for every pull request in the stack

- **Where premium options appear.** A premium option or tool is registered only on the premium host. When the entitlement is `null` (signed in, not subscribed), it answers an `ExpectedError` that says a subscription is needed and links `https://agentic-seo.org/account`. Free `/mcp` never lists premium options. `test/hosted.test.ts` pins the free tool list and schemas as today, and gains a premium variant.
- **What the tools receive.** `HostedProfile` gains what a feature needs (a renderer, a lab runner, the account's connections), set only when `paid`. The tools never read the account id. Only `hosted/src/premium/` and `entitlement.ts` know it.
- **The contract.** New options and tools are a `minor` changeset each. Tool descriptions name which options are premium.
- **Privacy.** No URL, query, number, key or token reaches analytics or logs. New stored data goes in the EU accounts database, encrypted where it is a credential. Account deletion removes it. The privacy section of `/account` says what each feature keeps.
- **Encryption at rest.** One AES-GCM key, the secret `ACCOUNT_DATA_KEY`, bound to both Workers, in `hosted/src/accounts/sealed.ts` (`seal(text)`, `open(sealed)`). It is used for the Google refresh token and the Bing key.
- **Copy.** Plain English, no em dashes. `pnpm run verify` passes on each pull request.

## Calls made in the design (the builder check's minor questions)

- **Who counts as paying:** a premium feature needs `paid !== null`, any payment, so pay-per-call (step 4) needs no change. The per-account limits apply to both kinds.
- **A watch run:** up to 100 pages, with no rendering, PSI, Search Console or Bing. "Regressed" means new finding ids since the last run, or a drop in the SEO or AEO score of 5 points or more. `watches` therefore also keeps `last_seo_score` and `last_aeo_score`.
- **What the rendering spike must prove:** at an origin we control, every request made while rendering a test page arrives with our User-Agent and our signature, and none with Browser Run's `cf-brapi-*` headers. That covers the navigation, a script, an image, a stylesheet, a redirect and a service worker registration (blocked). It is checked in a capture.
- **If the spike fails:** PR A stops and goes to the maintainer, and PRs B to F are rebased onto #239 without it and carry on.

## The stack

### PR A: Rendering (#230)

- `render: true` on the premium `seo_audit_page` and `seo_aeo_audit`. Crawls render the start page only, as locally.
- **Browser.** A Browser Run binding `BROWSER` on the MCP Worker, through `@cloudflare/playwright`, pinned. Check the package's current home, since the GitHub repository was archived on 2026-10-12 and the docs point to a fork. `render.ts` gains a `launch` option (`RenderOptions.launch?: () => Promise<Browser>`), so the core keeps one render path and the local server is unchanged.
- **The bot's promise.** Browser Run adds its own headers and its own Web Bot Auth signature to anything the browser fetches, and neither can be removed. So the browser never fetches anything itself:
  - every request (navigation, subresources, redirects) is routed and fulfilled from the Worker's own `hostedFetch`, which checks robots.txt, signs with our key and keeps `Crawl-delay`;
  - a request the gate refuses is aborted and never reported as broken;
  - service workers are blocked, and WebSockets and anything that cannot be routed are refused.
- **First task: a spike.** Confirm on Browser Run that routing fulfils the navigation, subresources and redirects, that `serviceWorkers: "block"` holds, and that nothing leaves with Browser Run's headers. **If it cannot be made to hold, the stack stops at this PR and asks the maintainer.** No fallback is built that lets Browser Run fetch on its own.
- **Limits.** A new rate-limit namespace `RENDER_CALLS` (per account, 10 a minute). A daily cap on rendered pages across all accounts (var `DAILY_RENDERS`, 2,000) in the Durable Object, additive. When Browser Run is out of capacity, the audit gives `RenderUnavailableError`'s finding.

### PR B: Lab performance from PageSpeed Insights (#222)

- **Where.** `lighthouse: true` and `formFactor` (mobile by default) on the premium `seo_audit_page`. PSI's `lighthouseResult` goes through the existing `summarize()` into the same `performance-rules.ts` findings. Where PSI lacks a category (`agentic-browsing`), the audit says so, and no rule fires on the missing data.
- **robots.txt.** Before the PSI call, the gate checks robots.txt for the page's URL. A refusal is the same `RequestRefusedError` answer as any refusal.
- **Key and cache.** The secret `PSI_API_KEY`, which may be the same Google key as `CRUX_API_KEY` with both APIs enabled. Answers are cached a day per URL hash and strategy in the Cache API, as `crux.ts` does.
- **Limits.** Per account through `RENDER_CALLS`'s sibling `LAB_CALLS` (5 a minute). A PSI 429 or quota error is an `ExpectedError`.

### PR C: Bigger crawls

- A subscriber's `seo_start_crawl` (background) takes `maxPages` up to 500. The synchronous `seo_crawl_site` stays at 100.
- **Slim records.** A `SitePageRecord`, the serialisable subset every site rule needs, built from the `ExtractedPage` when a page is read. The site rules (`src/core/site-rules.ts`, the `aeo/site-rules.ts` ones) read it instead of `PageRecord`. Local crawls use the same records, so one code path runs everywhere and the existing site-rule tests hold it. The AEO site rules cover all 500 pages too.
- **Memory.** The heap holds about 100 pages, so the Workflow crawls in chunks:
  - each step crawls up to 100 pages from a frontier it keeps in R2, and writes the pages' audits to R2;
  - a last step builds the site audit from the stored page audits and slim records.
- **Budget.** Paid crawls, renders and watch runs count against `PAID_DAILY_REQUESTS`. PR A adds that count, since it lands first.
- `crawlOptions` clamps by `paid`. The schema for the premium host uses a factory that takes the cap.

### PR D: Watched sites (#228)

- **Tools.** `seo_watch_site` (`url`, or `remove: true`), `seo_watched_sites` and `seo_watch_report` (`url`): the latest run and what regressed since the one before.
- **Storage.** Migration `0002_watches.sql`: `watches(account_id, site, url, created_at, last_run_at, last_ids, last_report_key)`. It keeps the finding ids only. The report itself lives in R2 under `watches/<account>/<hash>` (EU) for 30 days. At most 5 per account.
- **The run.** A weekly cron on the MCP Worker queues each due watch as a background crawl run (the `CrawlWorkflow`). It runs under the same robots.txt, signing, `Crawl-delay` and daily request cap, with the account as caller. It compares with `recheck.ts`'s baseline and emails the account through Email Service when there are new findings. The email holds counts and a link, never the page's text.
- **Retention.** This breaks "an account keeps no sites". The accounts migration comment, the `/account` privacy text and the hosted README say so. Deleting the account deletes its watches and their R2 reports.

### PR E: Search Console (#226)

- **Connecting.** `/account` gains "Connect Google Search Console": the OAuth web-server flow with `webmasters.readonly`, `access_type=offline` and `prompt=consent`. The refresh token is sealed in a new `connections(account_id, provider, sealed_token, created_at)` table (`0003_connections.sql`). "Disconnect" and account deletion revoke the token at Google and delete the row.
- **Secrets.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the website Worker. The MCP Worker only refreshes access tokens, so it needs both as well.
- **In the audit.** `searchConsole: true` on the premium audit and crawl tools, following the field-data pattern:
  - a `searchConsole` record per page (clicks, impressions, position over 28 days, and URL Inspection's index state for the audited page only);
  - new rules `indexing.not-indexed` and `indexing.google-canonical-differs`, written with the `add-rule` skill;
  - findings ordered by impressions when present.
- **New tool.** `seo_search_performance` (`site`): the top pages and queries that lost clicks over 28 days compared with the 28 before.
- **Google verification.** Until Google verifies the app, only up to 100 test users can connect, and their connection lapses after 7 days. The account page says so while the var `GOOGLE_APP_STATUS` is `"testing"`. Verification is a maintainer task.

### PR F: Bing Webmaster Tools (#227)

- **Connecting.** `/account` gains a Bing API key field, sealed in `connections` with provider `bing`. The key is checked once with a cheap call before it is kept, and never shown again ("connected" only).
- **In the audit.** `bing: true` on the premium audit and crawl tools:
  - `GetUrlInfo` gives the audited page's last crawl and HTTP status;
  - `GetCrawlIssues` gives the site's crawl issues as findings, under a new rule `indexing.bing-crawl-issue`;
  - `GetPageStats` gives clicks and impressions per page.
- **Answers.** `InvalidApiKey` is an `ExpectedError` that tells the user to reconnect. Throttling is an `ExpectedError` too.
- **IndexNow.** Left for a later issue; not in this stack.

## Approaches considered

- **A stack of six pull requests (chosen).** Each feature can be reviewed and merged alone, in dependency order. Rendering comes first because #229 names it the first paid feature.
- **One large pull request.** Rejected: too big to review, and one blocked feature would hold up the rest.
- **Rendering with Browser Run's own network.** Rejected: its requests carry Cloudflare's identity and signature, not ours, so robots.txt for `agentic-seo-check` would mean nothing to the request that reaches the site.

## Left to the builder

- Module names under `hosted/src/` and `src/core/`.
- Exact limits beyond the numbers above.
- Page layouts on `/account`, in its existing panel style.
- How chunked crawl state is laid out in R2.
- Whether the Search Console and Bing records share a type.

## Maintainer tasks this stack adds

- The secrets `ACCOUNT_DATA_KEY`, `PSI_API_KEY`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Browser Run on the account.
- A Google Cloud OAuth client, the consent screen, and verification.
- The new rate-limit namespaces.
- The privacy policy text for watched sites, Search Console and Bing.
