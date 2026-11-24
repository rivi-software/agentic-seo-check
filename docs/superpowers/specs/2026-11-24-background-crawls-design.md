# Background crawls on the hosted server (issue #209)

## Why

A crawl on the hosted server runs inside one MCP request. Many MCP clients give up on a tool call after about 60 seconds, and in the week to 2026-11-24 the p95 of `seo_crawl_site` was 80 s: about 5% of crawls finish on the server after the client has stopped waiting, and the work is lost. A Worker restart during a deploy also ends a crawl in flight.

The maintainer wants a slow site's crawl to come back complete, not cut short.

## Goals

- An agent can start a crawl on the hosted server and fetch its full result later, however long the crawl takes within the hosted caps.
- The result is the same audit, in the same shape, that `seo_crawl_site` and `seo_aeo_audit` with `crawl` give today.
- The hosted server stays the well-behaved bot it is: robots.txt, `Crawl-delay`, signing, every limit.

## Non-goals

- No change to `seo_crawl_site`, `seo_aeo_audit` or `seo_share_report`. Their inputs and answers stay as they are.
- Nothing for the local server, the CLI or the library: they have no client timeout to beat.
- No background crawls for the website's form, whose crawls stream and stay under 42 s at p95.
- No resumable crawl: a crawl is not split into steps that pick up where a restart left off (see Durability).
- MCP's own `tasks` (call now, fetch later in the protocol): few clients support them yet. They may replace these tools later.

## Anti-goals

- A crawl that sends more requests to a site than `seo_crawl_site` would, or that slips past a limit because it runs outside a request.
- A result anyone can find without the id, or that outlives its retention.
- A breaking change to the published tools.

## Approaches

1. **New tools beside the current ones (chosen).** `seo_start_crawl` answers at once with an id; `seo_crawl_result` returns the result when it is ready. `seo_crawl_site` is unchanged. A `minor` changeset. The cost: an agent has to choose the background tool before it knows a site is slow, so the descriptions steer large or slow sites to it.
2. **The current crawl tools always run in the background.** Simple and consistent, but every crawl takes two calls and every client today breaks. A `major` changeset.
3. **Wait up to about 45 s, then hand off.** Saves slow crawls without the agent planning ahead, but changes what `seo_crawl_site` answers for clients that wait longer today. A `major` changeset.

A fourth path, a time budget that answers with the pages read so far, was set aside: the maintainer wants a slow site's crawl complete.

The maintainer chose approach 1.

## Design

### The tools (hosted server only, `src/mcp-hosted.ts`)

**`seo_start_crawl`** takes the inputs of `seo_crawl_site` (the same schema, `CRAWL_SITE_INPUT`, and the same caps from `HOSTED_LIMITS`), plus `conversation_id` as every hosted tool does. It checks the URL (`allowedHost`) and field data (`fieldDataOf`), admits the call through `profile.startCall` with `crawl: true`, starts a Workflow instance and answers at once with:

```json
{ "id": "<32 hex digits>", "status": "running", "next": "Call seo_crawl_result with this id ..." }
```

It is not read-only (it starts work that keeps a result), so its annotations say so, as `seo_share_report`'s do.

The filters in its input (`rules`, `disableRules`, `baseline`, `keyword`, `includeInfo`) apply to the SEO audit only, as they do in `seo_crawl_site`: SEO rule ids and finding ids mean nothing to the AEO audit. The AEO audit runs with its defaults, as `seo_aeo_audit` with `crawl` and no filters would. `auditSiteBoth` today takes none of these filters, so it gains them for its SEO half (an additive change to a function `src/index.ts` does not export). The AEO audit reads the crawl `auditSiteBoth` makes, so it follows that crawl's `delayMs`, patterns and link options, which `seo_aeo_audit` cannot set; its result is the same audit of the same pages, not a byte-for-byte match with a separate `seo_aeo_audit` call. (Builder check: settled by the author.)

**`seo_crawl_result`** takes `id`, `audit: "seo" | "aeo"` (default `"seo"`), `format` and `detail` (the same options as the crawl tools), and `conversation_id`. It is read-only and sends no request to any site. It answers:

- `running`: the crawl has not finished; with the time it started. A hint says to call again after a while.
- `done`: the audit, through `respond` (SEO) or `respondAeo` (AEO) as `seo_crawl_site` or `seo_aeo_audit` with `crawl` would answer, so `format` and `detail` mean what they mean there.
- `failed`: the crawl ended with an error or a refusal; the message is the one `seo_crawl_site` would have answered with (`fail(error)`), including a site's refusal, which says nothing more than the site's answer.
- An unknown or expired id: a tool error (`ExpectedError`, reason `crawl_not_found`) that says the id is unknown or past its 7 days.

It counts as a tool call against `CALLER_CALLS` / `PLATFORM_CALLS` (agents poll; the per-minute limit holds them back), but not as a crawl or a site of the day.

Both tools are added to `HOSTED_TOOLS` so the analytics know their arguments. `seo_crawl_site`'s description gains one sentence: for a large or slow site, use `seo_start_crawl` and `seo_crawl_result`, since a crawl can outlast a client's wait.

### Running the crawl (a Cloudflare Workflow in the MCP server's Worker)

- `hosted/wrangler.jsonc` binds a Workflow, `CRAWLS`, with a class `CrawlWorkflow` exported from `hosted/src/index.ts` (code in a new `hosted/src/crawls.ts`).
- The instance id is the crawl id: 128 random bits as hex, since an instance id may not start with `-`, as base64url may.
- The Workflow's only param is the crawl id. Workflows cannot be pinned to the EU, and a caller's key is an IP address, so nothing personal and no URL goes into the Workflow's own state. `seo_start_crawl` writes the `running` object to R2 (EU) with the crawl's options (the tool's input less `format`, `detail` and `conversation_id`) before it creates the instance, and the Workflow reads them from there. The caller's key is kept nowhere: the caller's limits were settled at admission, and a crawl's gate checks no caller (`siteGate` gets no caller for a crawl). The object's options are removed when the result is written.
- The crawl runs as one step: `auditSiteBoth(url, options)` with the hosted fetch (`hostedFetch` with `USER_AGENT`, `requestSigner`, and a gate built in the Workflow from `env` the way `hostedProfile` builds it: `siteGate`, the day's count, `SITE_REQUESTS`). The step writes the result to R2 and returns only a small summary (pages, outcome), well under a step's return limit.
- The step retries at most once, with a delay, and never after a `RequestRefusedError` or a `CallLimitError`: a refusal is the site's answer and is not asked again. A failure is written to R2 as `failed` with its message, so `seo_crawl_result` can answer it.
- `cpu_ms` stays at 120000, which a crawl at the caps fits (issue #73).

### Durability

One step means a restart during a crawl (a deploy, a retried step) runs the crawl again from the start. At a few deploys a day and crawls of a few minutes at most, the clash is rare, and a rerun sends no more than one crawl's requests again, all through the same gate. Splitting the crawl into resumable steps would need `src/core/crawl.ts` to save and restore its queue, which is left for later if the records show reruns matter.

### Where results live

- The R2 bucket `SHARED_REPORTS` (EU jurisdiction), under `crawls/<id>`, beside `reports/<id>`.
- One JSON object per crawl: `{ status, startedAt, endedAt, seo, aeo, error }`, with `seo` and `aeo` as `auditSiteBoth` gives them (the `start` page audits are dropped). `running` is the absence of `endedAt` in an object the start writes, or the Workflow's own status when there is no object yet.
- Kept 7 days: a lifecycle rule of its own on the `crawls/` prefix (`wrangler r2 bucket lifecycle add agentic-seo-check-shared-reports expire-crawls crawls/ --expire-days 7 --jurisdiction eu`), noted in `wrangler.jsonc` and `hosted/README.md`. Until the rule deletes it, a result past its 7 days reads as expired, as a shared report past its day does.
- Anyone with the id can read the result, as with a shared report's link; the id is never logged or sent to the analytics.

### Limits and modes

- A crawl counts when it starts: `startCall` with `crawl: true` takes a `CALLER_CRAWLS` or `PLATFORM_CRAWLS` slot and the site of the day, as `seo_crawl_site` does.
- Every request the Workflow sends goes through the gate: robots.txt and `Crawl-delay` (`hostedFetch`), `SITE_REQUESTS`, `DAILY_REQUESTS` (the day's count in the Durable Object, through `globalState`).
- The day's cap (`DAILY_REQUESTS`) is checked when the crawl is admitted, as for `seo_crawl_site`; the gate counts requests as they go and refuses none on the day's total, so a crawl admitted near the cap may pass it by one crawl's requests, as today.
- `MODE: no-crawls` or `closed` refuses `seo_start_crawl`. A crawl already running finishes. `closed` also refuses `seo_crawl_result`, as it refuses every call.
- A rerun (the one retry, or a restart during a deploy) checks `MODE` and the day's cap again before it requests anything: under `no-crawls` or `closed`, or past the cap, the crawl ends `failed` with the server's own refusal, so `MODE` stays a kill switch for crawls not yet past their first attempt's end. A rerun does not take a crawl slot or a site of the day again: the caller was admitted once.

### Records and analytics

- `seo_start_crawl` and `seo_crawl_result` are tool calls like any other: one Analytics Engine record each and one `$mcp_tool_call` event each, with the arguments' names, never their values.
- The Workflow writes one Analytics Engine record when the crawl ends, under the tool name `seo_start_crawl` and a new kind, `background`, with outcome, duration, requests, pages and the hostname, so the crawl duration data in issue #209 keeps working.
- Errors the Workflow catches reach error tracking through `reportError` / `hearCaughtError`, as the request path's do.
- Any new event property is listed in `hosted/README.md`.

## Tests

- `test/hosted.test.ts`: the two tools through the SDK's client with a fake profile: start answers an id; result answers running, done (SEO and AEO, in each format), failed, unknown id; refusals by mode and limits.
- `hosted/test/`: the Workflow in workerd against the fixture pages, a crawl to `done` and its R2 object; a refused robots.txt ending `failed` without a retry; the bindings in `configs.test.ts`.
- `test/mcp.test.ts` or wherever the tool lists are pinned: the hosted server lists the two new tools and the local server does not.

## Docs and release

- README (hosted server's tools), `skills/seo-audit/SKILL.md` (when to start a background crawl and how to poll), `hosted/README.md` (the Workflow, the bucket prefix and its rule, the record).
- A `minor` changeset: two new tools on the hosted server.

## Left to the builder

- The exact wording of the tools' descriptions and answers, in the voice of the other tools.
- How long `seo_crawl_result` suggests waiting before the next call (from the crawl's caps and `Crawl-delay`).
- Whether the Workflow writes the `running` object at start or `seo_crawl_result` asks the Workflow's status for an id with no object yet.
