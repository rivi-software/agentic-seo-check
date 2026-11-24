# Background crawls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new hosted MCP tools, `seo_start_crawl` and `seo_crawl_result`, that run a crawl in a Cloudflare Workflow and keep its result in R2 for 7 days, so a client's timeout no longer loses a slow site's crawl (issue #209).

**Architecture:** The tools live in `src/mcp-hosted.ts` behind a new `HostedProfile.crawls` port (start, read), so `test/hosted.test.ts` drives them with an in-memory fake. The hosted Worker implements the port in a new `hosted/src/crawls.ts`: an R2 store under `crawls/<id>` in the EU bucket `SHARED_REPORTS`, and a `CrawlWorkflow` that runs `auditSiteBoth` as one step through a gate `hosted/src/limits.ts` builds for a background crawl. The Workflow's only param is the id; the options travel through R2.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, zod, Cloudflare Workflows (`WorkflowEntrypoint` from `cloudflare:workers`, `NonRetryableError` from `cloudflare:workflows`), R2, Vitest, Wrangler's `unstable_startWorker`.

**Spec:** `docs/superpowers/specs/2026-11-24-background-crawls-design.md`

## Global Constraints

- Read `AGENTS.md` first. Its rules on the contract, key order, telemetry, the well-behaved bot and plain English apply to every task.
- Tool names, exactly: `seo_start_crawl`, `seo_crawl_result`. No change to `seo_crawl_site`'s, `seo_aeo_audit`'s or `seo_share_report`'s inputs or answers, except one sentence added to `seo_crawl_site`'s description.
- Crawl id: 128 random bits as base64url, 22 characters, matching `/^[\w-]{22}$/u` (the same as `REPORT_ID` in `hosted/src/shared-reports.ts`).
- Results: R2 bucket binding `SHARED_REPORTS` (EU), key `crawls/<id>`, kept 7 days (`CRAWL_DAYS = 7`). Lifecycle rule: `wrangler r2 bucket lifecycle add agentic-seo-check-shared-reports expire-crawls crawls/ --expire-days 7 --jurisdiction eu`.
- The Workflow's params are `{ id }` only: no URL, no caller key, no IP address.
- The filters `rules`, `disableRules`, `baseline`, `keyword` and `includeInfo` apply to the SEO audit only; the AEO audit runs with its defaults.
- One Workflow step, retried at most once (`retries: { limit: 1, delay: "30 seconds", backoff: "constant" }`), never after a `RequestRefusedError`, a `CallLimitError` or any other `ExpectedError`.
- Each attempt of the step re-checks `MODE` (`closed` or `no-crawls` ends the crawl `failed`) and the day's cap (`DAILY_REQUESTS`) before it requests anything; it takes no crawl slot or site of the day again.
- `MODE: no-crawls` and `closed` refuse `seo_start_crawl`; `closed` also refuses `seo_crawl_result`.
- `seo_start_crawl` and `seo_crawl_result` both count against `CALLER_CALLS` / `PLATFORM_CALLS`. Only `seo_start_crawl` counts as a crawl and a site of the day.
- `seo_crawl_result` is read-only. `seo_start_crawl` is not: annotations as `SHARE_ANNOTATIONS`'s shape, `readOnlyHint: false`.
- The crawl id is never logged and never sent to the analytics.
- A `minor` changeset.

## Review Focus

- An id that is well-formed but unknown, malformed, or past 7 days while R2 still has it: `seo_crawl_result` answers the `crawl_not_found` tool error and never throws. Covered in Task 3 (store) and Task 2 (tool).
- A crawl the site refuses (robots.txt disallows the start URL): it ends `failed` with the site's answer, with no retry and no second request to the site. Covered in Task 4 (workerd).
- A `seo_crawl_result` call while the crawl is still running, including before the Workflow has started: it answers `running`. Covered in Task 2 and Task 4.
- `MODE` switched to `no-crawls` between the first attempt and a retry: the retry ends `failed` with the server's refusal, sending nothing. Covered in Task 3 (`readmit`).
- A result read with `audit: "aeo"` and `format: "markdown"`: the same text `seo_aeo_audit` with `crawl` would answer for that audit. Covered in Task 2.

---

### Task 1: `auditSiteBoth` takes the SEO filters

**Files:**
- Modify: `src/core/aeo/audit.ts` (the `SiteAuditsOptions` Pick, around line 766)
- Test: `test/aeo.test.ts`

**Interfaces:**
- Produces: `SiteAuditsOptions` gains `"keyword" | "includeInfo" | "disableRules" | "onlyRules" | "baseline"` from `CrawlOptions` (`src/core/audit.ts`), applied to the SEO half only. `includeInfo` is already there; keep it applying to both, as today.

- [ ] **Step 1: Write the failing test** `it("applies the SEO filters to the SEO audit only (issue #209)")`, using `test/helpers/fixture-server.ts`: run `auditSiteBoth(start, { onlyRules: [<a rule id that fires on the fixture site>], maxPages: 5 })` and `auditSiteBoth(start, { maxPages: 5 })`. Assert every finding of `seo` (site findings and each page's) has that rule id, and that `aeo.findings` of both runs are equal.
- [ ] **Step 2: Run** `pnpm exec vitest run test/aeo.test.ts -t "SEO filters"`. Expected: a type error on `onlyRules`, or the SEO findings unfiltered.
- [ ] **Step 3: Add the keys to the Pick.** `auditCrawled` already reads them from `options`; `aeoOptions` is built field by field and must stay without them. Update the doc comment to say the filters are the SEO audit's.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): auditSiteBoth takes the SEO audit's filters (#209)`.

### Task 2: The two tools in `src/mcp-hosted.ts`

**Files:**
- Modify: `src/mcp-hosted.ts`
- Modify: `src/telemetry/mcp.ts` only if `HOSTED_TOOLS` needs nothing more than the two new entries (it should not)
- Test: `test/hosted.test.ts`

**Interfaces:**
- Consumes: `SiteAuditsOptions` (Task 1), `auditSiteBoth` from `src/core/aeo/audit.ts`.
- Produces (all exported from `src/mcp-hosted.ts`):

```ts
/** What seo_start_crawl keeps for the Workflow: the tool's input less format, detail and conversation_id. */
export type BackgroundCrawlOptions = Omit<
  z.output<z.ZodObject<typeof CRAWL_SITE_INPUT>>,
  "format" | "detail" | "conversation_id"
>;

/** How a background crawl failed: the text `fail(error)` answers, and whether the site refused it. */
export interface CrawlFailure { message: string; refused: boolean }

export type CrawlState =
  | { status: "running"; startedAt: string }
  | { status: "done"; startedAt: string; endedAt: string; seo: SiteAudit; aeo: AeoAudit }
  | { status: "failed"; startedAt: string; endedAt: string; failure: CrawlFailure };

/** The hosted server's background crawls (issue #209). */
export interface BackgroundCrawls {
  /** Keeps the options and starts the Workflow; answers the new crawl's id. */
  start: (options: BackgroundCrawlOptions) => Promise<{ id: string; startedAt: string }>;
  /** The crawl under `id`, or null for an unknown, malformed or expired id. */
  read: (id: string) => Promise<CrawlState | null>;
}

// HostedProfile gains:
  crawls?: BackgroundCrawls;

/** The crawl seo_start_crawl asked for, run as seo_crawl_site runs it, both audits from one crawl. */
export const runBackgroundCrawl: (
  options: BackgroundCrawlOptions,
  fetch: FetchOptions,
  fieldData: FieldDataOptions | undefined
) => Promise<{ seo: SiteAudit; aeo: AeoAudit }>;

/** The failure a background crawl's error ends it with: `fail(error)`'s text, and whether it was a refusal. */
export const crawlFailure: (error: unknown) => CrawlFailure;
```

- [ ] **Step 1: Write the failing tests** in a new `describe("its background crawls (issue #209)")` in `test/hosted.test.ts`. Give `profileWith` an option `crawls?: BackgroundCrawls`; a test fake keeps states in a `Map` and runs nothing. Tests:
  - `it("lists seo_start_crawl and seo_crawl_result, and seo_crawl_site points to them")`: both in `listTools()`; `seo_crawl_result`'s `annotations.readOnlyHint` is `true`, `seo_start_crawl`'s is `false`; `seo_crawl_site`'s description contains `seo_start_crawl`. Also assert the local server (`createMcpServer()`) lists neither.
  - `it("starts a crawl: admitted as a crawl, answered with its id at once")`: `startCall` was told `{ tool: "seo_start_crawl", fetches: true, crawl: true, host: "shop.example.com" }`; the fake's `start` got the options without `format`, `detail`, `conversation_id`; the answer's first text parses to `{ id, status: "running", ... }`.
  - `it("refuses to start when the limits refuse, and starts nothing")`: `profileWith({ refuse: "..." })`; `isError` true; fake `start` never called.
  - `it("answers running, then the SEO or the AEO audit as the crawl tools would")`: with a `done` state made by running `auditSiteBoth` on the fixture server, `seo_crawl_result` with `audit: "seo"` returns the same text as `respond(seo, "json", "compact")`, and with `audit: "aeo", format: "markdown"` the same as `respondAeo(aeo, "markdown", "compact")`. A `running` state answers `status: "running"` and `startedAt`.
  - `it("answers a failed crawl with its failure as a tool error")`: `isError` true, text is `failure.message`.
  - `it("answers an unknown id as a tool error, crawl_not_found")`: fake `read` returns null; `isError` true; the analytics event's reason is `crawl_not_found`.
  - `it("says background crawls are off on a server without them")`: profile without `crawls`; both tools answer a tool error (reason `crawls_off`).
  - `it("never puts the crawl id in the analytics")`: run start and result through `connectWatched`; `JSON.stringify(calls)` does not contain the id.
- [ ] **Step 2: Run** `pnpm exec vitest run test/hosted.test.ts -t "background crawls"`. Expected: FAIL, unknown tools.
- [ ] **Step 3: Implement.**
  - `runBackgroundCrawl`: the option mapping `registerCrawlSite` uses today (`auditOptions(input, fetch)`, the caps from `LIMITS`, `respectRobots: true`) passed to `auditSiteBoth`. Make `registerCrawlSite` build its options through the same helper, so the two cannot drift. Drop `start` from the result.
  - `crawlFailure`: `refused` is `error instanceof RequestRefusedError`; `message` is the text of `fail(error)`'s first content item.
  - `seo_start_crawl`: input `{ ...CRAWL_SITE_INPUT }` less `format` and `detail`. Annotations `{ title: "Start a crawl in the background", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`. Same `allowedHost` and `fieldDataOf` checks as `seo_crawl_site`, then `runCall(profile, { tool: "seo_start_crawl", fetches: true, crawl: true, host }, ...)`, whose work calls `profile.crawls.start(options)` and sends no request itself. Answer JSON keys in order: `id`, `status`, `startedAt`, `next` (one sentence: call `seo_crawl_result` with this id in a minute or two; results are kept 7 days).
  - `seo_crawl_result`: input `{ id: z.string().describe(...), audit: z.enum(["seo", "aeo"]).default("seo"), format, detail, ...agentArguments }`. `readOnlyTool("Fetch a background crawl's result", { openWorld: false })`. `runCall(profile, { tool: "seo_crawl_result", fetches: false, crawl: false, host: null }, ...)`. `done` answers through `respond` / `respondAeo` and passes the audit back as `audit` so the call's event gets its properties; `pages` is `pagesOf(audit)`. `running` answers `{ id, status, startedAt, next }`. `failed` answers `{ isError: true, content: [{ type: "text", text: failure.message }] }`. Unknown: `fail(new ExpectedError("<id unknown or past its 7 days>", { reason: "crawl_not_found" }))`.
  - Both tools without `profile.crawls`: `ExpectedError` with reason `crawls_off`, as `seo_share_report` does for `sharing_off`.
  - Add both to `HOSTED_TOOLS` and to `registerHostedTools`. Add the sentence to `CRAWL_SITE.description`: for a large or slow site, whose crawl can outlast a client's wait, use `seo_start_crawl` and `seo_crawl_result`.
- [ ] **Step 4: Run** `pnpm exec vitest run test/hosted.test.ts test/mcp.test.ts`. Expected: PASS, the existing tests too.
- [ ] **Step 5: Commit** `feat(hosted): seo_start_crawl and seo_crawl_result (#209)`.

### Task 3: The store and the background crawl's limits

**Files:**
- Create: `hosted/src/crawls.ts` (the store part)
- Modify: `hosted/src/limits.ts`
- Test: create `hosted/test/crawls.test.ts`; modify `hosted/test/limits.test.ts`

**Interfaces:**
- Consumes: `CrawlState`, `CrawlFailure`, `BackgroundCrawlOptions` (Task 2); `ReportBucket` from `hosted/src/shared-reports.ts`.
- Produces from `hosted/src/crawls.ts`:

```ts
export const CRAWL_DAYS = 7;
export const CRAWL_ID: RegExp; // /^[\w-]{22}$/u
export const newCrawlId: () => string;
/** Writes the running object with the options; startedAt and expiresAt as customMetadata. */
export const keepCrawl: (bucket: ReportBucket, id: string, options: BackgroundCrawlOptions, now?: Date) => Promise<string /* startedAt */>;
/** The options a running crawl was started with, or null. */
export const crawlOptions: (bucket: ReportBucket, id: string) => Promise<BackgroundCrawlOptions | null>;
/** Writes the end of a crawl, without its options. */
export const endCrawl: (bucket: ReportBucket, id: string, end: { seo: SiteAudit; aeo: AeoAudit } | { failure: CrawlFailure }, now?: Date) => Promise<void>;
export const readCrawl: (bucket: ReportBucket, id: string, now?: Date) => Promise<CrawlState | null>;
```

  The object's JSON: `{ status, startedAt, endedAt?, options?, seo?, aeo?, failure? }`, with `expiresAt` in `customMetadata` as `keepReport` writes it (`endCrawl` keeps the start's `startedAt` and `expiresAt`).

- Produces from `hosted/src/limits.ts`:

```ts
/** The limits of a background crawl's attempt: re-checked before it requests anything, then its gate. */
export const backgroundCrawl: (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  host: string,
  report?: ReportTask
) => {
  /** Throws a CallLimitError under MODE closed or no-crawls, or past the day's requests. */
  readmit: () => Promise<void>;
  gate: RequestGate;
  /** Writes the crawl's record (tool seo_start_crawl, role "background") and counts what it sent. */
  end: (outcome: HostedCallEnd["outcome"], pages: number, durationMs: number) => void;
};
```

  `HostRole` gains `"background"`. `admit`'s mode and daily checks move into a helper that `readmit` shares, so the refusals' texts stay the same.

- [ ] **Step 1: Write the failing tests.** In `hosted/test/crawls.test.ts`, with an in-memory `ReportBucket` (as `hosted/test/shared-report.test.ts` builds one):
  - `it("keeps a crawl's options while it runs, and drops them when it ends")`
  - `it("reads running, done and failed, each with its times")`
  - `it("reads an unknown id, a malformed id and one past 7 days as null")`: a malformed id never reaches the bucket.
  - `it("makes ids of 22 base64url characters, each new")`

  In `hosted/test/limits.test.ts`:
  - `it("re-check MODE and the day's requests before a background crawl's attempt, and take no crawl or site again (issue #209)")`: `readmit` throws `CallLimitError` with reason `no_crawls`, `paused` and `daily_requests` in turn; `CALLER_CRAWLS` and `admitSite` are not called.
  - `it("record a background crawl's end by tool, outcome and hostname, as background")`: blobs `["seo_start_crawl", "ok", "shop.example.com", "background"]`, doubles `[durationMs, requests, pages]`.
  - `it("hold a background crawl to the site's requests a minute")`: the gate refuses with reason `site_requests` when `SITE_REQUESTS` says no.
- [ ] **Step 2: Run** `pnpm exec vitest run hosted/test/crawls.test.ts hosted/test/limits.test.ts`. Expected: FAIL, missing modules and exports.
- [ ] **Step 3: Implement** the store (reuse the id making and `DAY_MS` from `shared-reports.ts` by exporting them there rather than copying) and `backgroundCrawl` (built from `siteGate` with no `reaches`, `countSent` and `record`).
- [ ] **Step 4: Run the tests again** and `pnpm run hosted:check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosted): keep background crawls in R2, with their limits (#209)`.

### Task 4: The Workflow, its binding and the server's wiring

**Files:**
- Modify: `hosted/src/crawls.ts` (add `CrawlWorkflow` and `backgroundCrawls`)
- Modify: `hosted/src/index.ts` (export `CrawlWorkflow`; give the profile `crawls`)
- Modify: `hosted/wrangler.jsonc` (the `workflows` binding; a comment on the `crawls/` lifecycle rule beside the bucket's)
- Modify: the `Env` type (wherever `wrangler types` output or the hand-written `Env` lives in `hosted/`) for `CRAWLS: Workflow<{ id: string }>`
- Test: `hosted/test/worker.test.ts`, `hosted/test/configs.test.ts`

**Interfaces:**
- Consumes: Task 2's `runBackgroundCrawl`, `crawlFailure`, `BackgroundCrawls`; Task 3's store and `backgroundCrawl`.
- Produces:

```ts
export class CrawlWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep): Promise<void>;
}
/** The port the MCP server's profile gets; null without SHARED_REPORTS or CRAWLS. */
export const backgroundCrawls: (env: Env) => BackgroundCrawls | undefined;
```

  Binding: `"workflows": [{ "name": "agentic-seo-check-crawls", "binding": "CRAWLS", "class_name": "CrawlWorkflow" }]` in `wrangler.jsonc` only; the website's config gets none.

- [ ] **Step 1: Write the failing tests.**
  - `hosted/test/configs.test.ts`: `it("bind background crawls on the MCP server only (issue #209)")`: the server config has the `CRAWLS` workflow with class `CrawlWorkflow`; the site config has no `workflows`.
  - `hosted/test/worker.test.ts`, in `describe("the hosted Worker")`:
    - `it("crawls a site in the background and answers its result by id (issue #209)")`: `seo_start_crawl` on the fixture shop; poll `seo_crawl_result` (every 200 ms, at most 30 s) until it is no longer `running`; the SEO answer's pages equal those `seo_crawl_site` finds on the same site in the same file's test; `audit: "aeo"` answers an AEO audit.
    - `it("ends a crawl the site refuses as failed, without asking again")`: a start URL robots.txt disallows; the result is a tool error naming the refusal; the fixture server saw exactly one robots.txt request and no page request for it.
- [ ] **Step 2: Run** `pnpm exec vitest run hosted/test/configs.test.ts` and `pnpm run hosted:test -- -t "background"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `backgroundCrawls(env).start`: `newCrawlId()`, `keepCrawl(...)` first, then `env.CRAWLS.create({ id, params: { id } })`. If `create` throws, end the crawl `failed` with an internal failure and rethrow, so the call answers an error.
  - `backgroundCrawls(env).read`: `readCrawl`.
  - `CrawlWorkflow.run`: one `step.do("crawl", { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "10 minutes" }, ...)`. Inside: read the options (none: return, the crawl is gone), `backgroundCrawl(...)`, `readmit()`, `hostedFetch({ userAgent: USER_AGENT, sign: requestSigner(...), limits: gate, crawl: true })`, the field data options as `hostedProfile` builds them (`cruxOptions`), `runBackgroundCrawl`, then `endCrawl` with the audits and `end("ok", pages, ms)`. On an `ExpectedError` (refusals and limits included): `endCrawl` with `crawlFailure(error)`, `end("refused" | "error", 0, ms)`, and return without throwing. Any other error: report it through `reportError`, then rethrow so the step retries. Wrap the `step.do` in a try/catch that, once the retry is spent, ends the crawl `failed` with `crawlFailure(error)`.
  - The step returns only `{ pages }`.
  - `hosted/src/index.ts`: `export { CrawlWorkflow } from "./crawls.js"`; `crawls: backgroundCrawls(env)` beside `share: reportKeeper(env)`.
- [ ] **Step 4: Run** `pnpm run hosted:verify`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosted): run background crawls in a Workflow (#209)`.

### Task 5: Docs, skill and changeset

**Files:**
- Modify: `README.md` (the hosted server's tools; the two new ones and when to use them)
- Modify: `skills/seo-audit/SKILL.md` (on the hosted server, start a large or slow site's crawl with `seo_start_crawl` and poll `seo_crawl_result`)
- Modify: `hosted/README.md` (the Workflow, the `crawls/` prefix and its lifecycle rule command, the `background` record, the two tools' analytics: argument names only)
- Modify: `AGENTS.md` (one clause in the `hosted/` layout entry naming `src/crawls.ts`)
- Create: a changeset via the `add-changeset` skill, `minor`

- [ ] **Step 1: Write the docs** in the voice of what is there, with no em dashes.
- [ ] **Step 2: Add the changeset** with the `add-changeset` skill.
- [ ] **Step 3: Run** `pnpm run verify`. Expected: every step passes.
- [ ] **Step 4: Commit** `docs: background crawls on the hosted server (#209)`.
- [ ] **Step 5: Tell the maintainer** the lifecycle rule must be added by hand before the deploy: `wrangler r2 bucket lifecycle add agentic-seo-check-shared-reports expire-crawls crawls/ --expire-days 7 --jurisdiction eu`.
