# Premium A: rendering on the hosted server, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let subscribers on `premium.agentic-seo.org/mcp` use `render: true` on `seo_audit_page` and `seo_aeo_audit`, rendered by Cloudflare Browser Run. Every request the browser makes is answered by our own gated, signed fetch, so the page is never fetched with Browser Run's own identity.

**Architecture:**

- `src/core/render.ts` gains two options:
  - `launch`, which supplies the browser;
  - `fetchThrough`, which answers every paused request from our own fetch instead of letting the browser fetch it.
- The audit passes both when `AuditOptions.browser` is set.
- The hosted MCP Worker gets a Browser Run binding, a premium `render` option, per-account and daily limits, and a paid daily request budget in the Durable Object.

**Tech Stack:**

- `@cloudflare/playwright`: check its current home, since the GitHub repository was archived on 2026-10-12.
- Chrome DevTools Protocol `Fetch` domain.
- Workers, a Durable Object, Rate Limiting.
- Vitest, in Node and in workerd.

**Spec:** `docs/superpowers/specs/2026-11-24-premium-features-stack-design.md` (section "PR A", "Shared rules", "Calls made in the design", and the decisions). Earlier spec: `docs/superpowers/specs/2026-11-24-hosted-premium-accounts-design.md`.

**Branch:** `feat/hosted-premium-render`, off `feat/hosted-premium-accounts` (#239). The pull request is stacked on #239.

## Global Constraints

- Free `agentic-seo.org/mcp` is unchanged: same tools, schemas, limits and answers. `test/hosted.test.ts` keeps pinning them.
- `render` appears only on the premium host's `seo_audit_page` and `seo_aeo_audit`.
  - If the entitlement is `null`, `render: true` throws an `ExpectedError` that says a subscription is needed and links `https://agentic-seo.org/account`.
  - A feature needs `paid !== null`.
- The browser fetches nothing itself:
  - Every paused request is fulfilled from `fetchThrough`, or failed.
  - A request the gate refuses is failed with `BlockedByClient` and never reported as broken.
  - Service workers are blocked (`serviceWorkers: "block"`). WebSockets are closed.
- Each fulfilled request goes through the audit's `FetchOptions`: `gate.beforeRequest`, `sign`, and the hosted User-Agent. A redirect is fulfilled as the 3xx itself, so the browser asks again and the gate sees the next hop.
  - *Amended after the final review:* Playwright's `context.route` never sees a redirect's next request (it hands it to the browser's own network), so `fetchThrough` walks each redirect itself, asking the gate and signing each hop, and fulfils the last answer. Only GET and HEAD are sent; any other method is blocked (Ruling K). The page's navigation goes through the call's gate, its subresources through `subresourceGate`, which spends no site of the day. A render sends at most 200 requests and holds at most 16 MB of answers at once.
- Limits:
  - `RENDER_CALLS`, per account, 10 a minute, a new namespace in both configs, held equal by `configs.test.ts`.
  - `DAILY_RENDERS`, 2,000 rendered pages a day across all accounts.
  - `PAID_DAILY_REQUESTS`, 100,000 a day. Paid requests count against it, not against `DAILY_REQUESTS`.
  - All counts live in the Durable Object, and its methods stay additive.
- Out of Browser Run capacity, or no `BROWSER` binding: the audit gives the existing `tool.render-unavailable` finding (`RenderUnavailableError`).
- No URL, account id or page text reaches analytics. `paid` stays the only paid property.
- Rulings carried from #239:
  - New Worker dependencies go in root `devDependencies`, pinned exactly.
  - Plain English, no em dashes.
  - No Co-Authored-By trailer.
  - `pnpm run verify` passes before the last commit.
- The tests launch no browser (AGENTS.md). Browser behaviour is proven by the spike (Task 1) and by unit tests of the pure request-handling function.

## Review Focus

1. **A page whose subresource the robots.txt disallows:** the page still renders, that request is failed, and no `site.broken-*` finding names it. Test in Task 2.
2. **A redirect chain inside the browser:** each hop goes through the gate, so a redirect to a disallowed or private address is refused. Test in Task 2.
3. **A huge subresource:** `fetchThrough` respects `maxBodyBytes` and fails rather than buffering without limit. Test in Task 2.
4. **A signed-in account without a subscription calling `render: true`:** it gets the subscription `ExpectedError`, and no browser launches. Test in Task 4.
5. **The daily render cap reached:** the call gets a limit refusal that names the cap and its reset at 00:00 UTC, with no browser launched. Test in Task 4.

---

### Task 1: Spike. Prove Browser Run can be fully routed (throwaway, gate for the PR)

**Files:**
- Create: `hosted/spike/render-spike/` (its own `wrangler.jsonc` and `index.ts`, not bundled with either Worker). The task's last commit deletes it, and the findings go in `docs/superpowers/notes/2026-11-24-browser-run-spike.md`.

**Interfaces:** none produced. Its result decides whether Tasks 2 to 5 run.

- [ ] **Step 1: Build the spike Worker.**
  - It serves `/page`: HTML with a script, a stylesheet, an image, a link to `/redirect` (302 to `/target`), and `navigator.serviceWorker.register('/sw.js')`.
  - It records every request it receives in memory: path, user-agent, and every header whose name starts with `cf-brapi` or `cf-biso`, or is `signature`, `signature-input` or `signature-agent`.
  - `/render?mode=routed|plain` launches Browser Run (`launch(env.BROWSER)` from `@cloudflare/playwright`), opens a context with `userAgent: "agentic-seo-check-spike"` and `serviceWorkers: "block"`, and renders `/page`:
    - `plain`: no interception;
    - `routed`: a CDP `Fetch.enable` on `*`, where each `Fetch.requestPaused` is answered by the Worker's own `fetch` and `Fetch.fulfillRequest`, with redirects fulfilled as the 3xx.
  - `/log` returns the recorded requests.
- [ ] **Step 2: Run it remotely.** Run `pnpm exec wrangler dev --remote` in `hosted/spike/render-spike` on the RIVI account, with `CLOUDFLARE_ACCOUNT_ID=11cac7608b348e25e8e8bd377ff3e2fa`. Do not deploy anything. Call `/render?mode=plain`, then `/log`, then `/render?mode=routed`, then `/log`.
- [ ] **Step 3: Record the evidence.** Write the note with both logs, with secrets and tokens redacted. Expected for `routed`: every recorded request has the spike's user-agent and no `cf-brapi-*`, `cf-biso-*` or Browser Run `signature*` header. `/sw.js` is never fetched. `/target` is reached only through the fulfilled 302. Also record:
  - whether `serviceWorkers: "block"` and `page.routeWebSocket` exist in the package's Playwright;
  - the exact error `launch()` throws when no browser is free, if seen;
  - whether `@cloudflare/playwright` bundles with Wrangler 4.162.0.
- [ ] **Step 4: Verdict.**
  - If `routed` holds: delete the spike directory, commit the note (`docs(hosted): what the browser run spike showed (#230)`), and report PASS.
  - If not: report FAIL with the evidence, and do not continue. The controller stops PR A and goes to the maintainer.

### Task 2: Core. Route every browser request through our fetch

**Files:**
- Create: `src/core/render-fetch.ts`.
- Modify: `src/core/render.ts` (`RenderOptions`, `renderPage`).
- Test: `test/render-fetch.test.ts`.

**Interfaces:**
- Produces, in `render-fetch.ts`:
  - `interface BrowserRequest { url: string; method: string; headers: Record<string, string>; postData?: string; resourceType: string }`
  - `type BrowserAnswer = { kind: "fulfil"; status: number; headers: { name: string; value: string }[]; body: Uint8Array } | { kind: "fail"; reason: "BlockedByClient" | "Failed" | "TimedOut" }`
  - `type FetchThrough = (request: BrowserRequest) => Promise<BrowserAnswer>`
  - `fetchThroughOptions(options: FetchOptions, pageUrl: string): FetchThrough`. One hop, no redirect following (*amended: it walks redirects itself, and `postData` is gone, see Global Constraints*). It asks `gate.beforeRequest` (a refusal becomes `fail BlockedByClient`), adds `sign(url)` headers and the User-Agent, sends the user's `headers` to the audited origin only (`browserRequestHeaders`), caps the body at `maxBodyBytes` (over it: `fail Failed`), and times out at `timeoutMs` (`fail TimedOut`). Gate refusals go through the gate's own bookkeeping, as `fetchPage` does, so `Refusals` sees them.
- Produces, in `render.ts`:
  - `RenderOptions.launch?: () => Promise<Browser>`. When given, `renderPage` skips `import("playwright")` and the system-browser fallback.
  - `RenderOptions.fetchThrough?: FetchThrough`. When given:
    - every paused request is answered from it with `Fetch.fulfillRequest` (body base64) or `Fetch.failRequest`;
    - the context gets `serviceWorkers: "block"`;
    - WebSockets are closed with `page.routeWebSocket("**", (ws) => ws.close())` if Task 1 found it exists, or with `Fetch` patterns otherwise;
    - `sendHeadersToOrigin` is not used, since `fetchThrough` already applies the headers rule.
  - Without either option, `renderPage` behaves as today.

- [ ] **Step 1: Write failing tests** in `test/render-fetch.test.ts`, against `test/helpers/fixture-server.ts` and a gate stub:
  - A 200 script is fulfilled with its bytes and status, and the request carried the hosted User-Agent and the `sign()` headers.
  - A gate refusal gives `{kind:"fail", reason:"BlockedByClient"}`, and the server received nothing.
  - A 302 is fulfilled as the 302 with its `location`, and is not followed.
  - A body over `maxBodyBytes` gives `fail Failed`.
  - The user's `headers` go to the page's origin and not to a third-party origin.
  - A `POST` with `postData` sends the body. (*Amended: a POST is blocked, and sends nothing.*)
- [ ] **Step 2:** Run `pnpm exec vitest run test/render-fetch.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `render-fetch.ts`, and the `launch` and `fetchThrough` options in `render.ts`. Reuse `fetch.ts`'s helpers for the body cap and timeout, and don't duplicate them.
- [ ] **Step 4:** Run the test file and `pnpm run test`. Expected: PASS, and the existing render tests are unchanged.
- [ ] **Step 5:** Commit: `feat(render): route every browser request through the audit's fetch (#230)`.

### Task 3: Audit. A supplied browser renders with requests routed

**Files:**
- Modify: `src/core/audit.ts` (`AuditOptions`, `renderFindings`).
- Test: `test/audit-render-options.test.ts`, with `renderPage` mocked through `vi.mock("../src/core/render.js")`.

**Interfaces:**
- Consumes: `RenderOptions.launch`, `RenderOptions.fetchThrough` and `fetchThroughOptions` (Task 2).
- Produces: `AuditOptions.browser?: { launch: () => Promise<Browser> }`. When it is set, `renderFindings` calls `renderPage(url, { …today's options, launch: options.browser.launch, fetchThrough: fetchThroughOptions(options.fetch ?? {}, url) })`. When it is not set, today's call is unchanged. A crawl still renders only its start page.

- [ ] **Step 1: Write failing tests.**
  - With `browser` set, `renderPage` receives `launch` and a `fetchThrough` function.
  - Without it, `renderPage` receives neither.
  - A `RenderUnavailableError` from `launch` still gives the `tool.render-unavailable` finding.
- [ ] **Step 2:** Run the test. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the test and `pnpm run test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(render): an audit option for a supplied browser (#230)`.

### Task 4: Hosted. Browser Run, the premium `render` option, and its limits

**Files:**
- Modify:
  - `src/mcp-hosted.ts`:
    - `HostedProfile.browser?: { launch: () => Promise<Browser> }`;
    - a premium schema variant of `seo_audit_page` and `seo_aeo_audit` with `render: z.boolean().optional()`, registered only when `profile.premium` is true (a new `HostedProfile.premium?: boolean`, set on the premium host);
    - `HOSTED_NOTE` worded per host;
    - `auditOptions` copies `browser` into `AuditOptions.browser` only when `render` is asked for and `profile.paid` is set;
    - `render: true` with `paid` null throws `SubscriptionNeededError extends ExpectedError`, message: "Rendering needs a subscription. Subscribe at https://agentic-seo.org/account."
  - `hosted/src/index.ts` and `hosted/src/premium/provider.ts`: set `premium: true`, and set `browser` from `env.BROWSER` through `@cloudflare/playwright`'s `launch`.
  - `hosted/src/limits.ts`:
    - `admit` checks `RENDER_CALLS` (key: the caller key) and the daily render count for a call with `render`;
    - a paid call's requests count against `PAID_DAILY_REQUESTS`;
    - a new `LimitReason` for each: `"render_calls"`, `"daily_renders"` and `"paid_daily_requests"`.
  - `hosted/src/state.ts`: additive methods `renders(day)`, `addRenders(day, n)`, `paidRequests(day)` and `addPaidRequests(day, n)`.
  - `hosted/wrangler.jsonc`:
    - the `browser` binding `BROWSER`;
    - the ratelimit `RENDER_CALLS` (namespace `"35009"`, 10 per 60 s);
    - vars `DAILY_RENDERS: 2000` and `PAID_DAILY_REQUESTS: 100000`;
    - `compatibility_flags` gains `nodejs_compat` if Task 1 found it needed;
    - the `playwright` alias stays, since the core imports `playwright` only without `launch`.
  - `hosted/wrangler.site.jsonc`: `RENDER_CALLS` and `PAID_DAILY_REQUESTS`, which are shared.
  - `hosted/test/configs.test.ts`: holds them equal.
  - `package.json`: `@cloudflare/playwright`, pinned, in devDependencies.
- Test:
  - `test/hosted.test.ts`: the free list stays unchanged; add a premium list that has `render` on the two tools.
  - `hosted/test/limits.test.ts`.
  - `hosted/test/worker.test.ts`: workerd, with no real browser. Stub `env.BROWSER` absent and check the finding.

- [ ] **Step 1: Write failing tests.**
  - A free profile's schemas have no `render`.
  - A premium profile's do.
  - A premium profile without `paid`, called with `render: true`, gets the subscription error, and `browser.launch` is never called.
  - With `paid`, `browser.launch` is called once.
  - Limits:
    - the 11th render call in a minute is refused (`render_calls`);
    - at `DAILY_RENDERS` the call is refused (`daily_renders`), and the message names the cap and 00:00 UTC;
    - a paid call's requests go to `addPaidRequests`, not `addRequests`.
  - workerd: a premium call with `render: true` and no `BROWSER` binding answers with the `tool.render-unavailable` finding, not an error.
- [ ] **Step 2:** Run the focused tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm run hosted:verify` and `pnpm run test`. Expected: PASS, and the bundle builds with `@cloudflare/playwright`.
- [ ] **Step 5:** Commit: `feat(hosted): render javascript for subscribers with browser run (#230)`.

### Task 5: Docs, changeset, verify

**Files:**
- Modify:
  - `README.md` (the hosted server section: rendering is premium);
  - `hosted/README.md`: Browser Run, the limits and their numbers, the maintainer task "turn on Browser Run", and the Telemetry line for the new limit reasons;
  - `skills/seo-audit/SKILL.md`: on the premium server an agent may pass `render: true`;
  - `AGENTS.md`: one sentence each for `render-fetch.ts` and the hosted browser, in Layout.
- Create: `.changeset/premium-render.md` (`minor`): the core's `AuditOptions.browser` and `RenderOptions.launch`/`fetchThrough`. The premium server's `render` is described without advertising the premium host's URL.

- [ ] **Step 1:** Write the edits. **Step 2:** Run `pnpm run verify`. Expected: exit 0. **Step 3:** Commit: `docs(hosted): rendering for subscribers (#230)`.
