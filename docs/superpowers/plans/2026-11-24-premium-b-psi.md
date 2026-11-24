# Premium B: lab performance from PageSpeed Insights, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subscribers on the premium server get `lighthouse: true` (with `formFactor`) on `seo_audit_page`. Google's PageSpeed Insights runs Lighthouse, and the same `performance-rules.ts` findings come back as the local Lighthouse gives.

**Architecture:**

- `src/core/psi.ts` calls PageSpeed Insights v5 and returns its `lighthouseResult`.
- `AuditOptions.lab` lets the audit take Lighthouse's result from a supplied runner instead of a local Chrome. Before the runner runs, the audit asks the fetch gate about the page's URL, so robots.txt for `agentic-seo-check` decides.
- The hosted server sets the runner for paying callers, with RIVI's key and a one-day Cache API cache, as `hosted/src/crux.ts` does for CrUX.

**Tech Stack:** PageSpeed Insights API v5 (`GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed`), Workers Cache API, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-premium-features-stack-design.md`. Read the "PR B" section, "Shared rules", the decisions (PSI is premium only and obeys robots), and "Calls made".

**Branch:** `feat/hosted-premium-psi`, off `feat/hosted-premium-render`. Its pull request is stacked on #241.

## Global Constraints

- **Free server unchanged.** Free `agentic-seo.org/mcp` keeps its tools, schemas and limits.
- **Option placement and paid check.** `lighthouse` and `formFactor` are on the premium `seo_audit_page` only. When `paid` is null, `lighthouse: true` throws the existing `SubscriptionNeededError`. Inline `html` never runs PSI, so it skips that check, as `render` does.
- **robots.txt.** Before PSI is called, the audit's `fetch.gate.beforeRequest(new URL(url))` decides. A refusal answers with the site's refusal, exactly as a refused fetch does, and PSI is never called.
- **API call.** The query sends `url`, `strategy` (`MOBILE` or `DESKTOP` from `formFactor`, mobile by default), `category=PERFORMANCE` and `category=SEO`, and `key`. The page's URL appears in the request only.
- **Missing categories.** PSI's result has no `agentic-browsing` category. `summarize()` must cope with a missing category or audit, giving `null` scores, and no rule may fire on missing data.
- **Cache.** Answers are cached for a day per sha256(url) and strategy in the Cache API (cache name `psi`). No URL in a cache key.
- **Secret.** `PSI_API_KEY` is an optional secret on the MCP Worker, like `CRUX_API_KEY`, not in `secrets.required`. Without it, a premium `lighthouse: true` gives the `tool.lighthouse-unavailable` finding with "Lab performance is not set up on this server."
- **Limit.** `LAB_CALLS` allows 5 a minute per account. It is a new rate-limit namespace `"35010"` in both configs, held equal by `configs.test.ts`. It gets the `LimitReason` `"lab_calls"`, and paid requests count against the paid budget.
- **PSI errors.**
  - 429 and quota errors are a `LabUnavailableError extends ExpectedError`, which gives the `tool.lighthouse-unavailable` finding.
  - Any other non-2xx answer also gives that finding.
  - A PSI `runtimeError` (the page failed to load for Google) is an `ExpectedError` with PSI's message, cleaned of the URL.
- **No URL anywhere it shouldn't be.** No URL reaches analytics or logs, and nothing from PSI is logged.
- **Carried rulings:**
  - Plain English, no em dashes.
  - No Co-Authored-By trailer.
  - Never push or deploy from a task.
  - `pnpm run verify` passes before the last commit.

## Review Focus

1. **robots.txt disallows `agentic-seo-check`:** PSI is never called, and the answer is the refusal. The test is in Task 1.
2. **PSI answers 429:** the audit still returns, with the `tool.lighthouse-unavailable` finding and no internal error. The test is in Task 1.
3. **No `agentic-browsing` category in PSI's result:** no agentic-browsing rule fires, and the score is `null`. The test is in Task 1.
4. **The same URL twice in a day:** the second call reads the cache and sends no PSI request. The test is in Task 2.
5. **Signed in but not subscribed, `lighthouse: true` with `html`:** the inline audit runs, with no subscription error. The test is in Task 2.

---

### Task 1: Core. A supplied lab runner, and the PSI client

**Files:**
- Create: `src/core/psi.ts`
- Modify:
  - `src/core/audit.ts` (`AuditOptions.lab`, `lighthouseFindings`)
  - `src/core/lighthouse.ts` (export `LhrLike`; `summarize` copes with missing data)
  - `src/index.ts` (export the new types)
- Test: `test/psi.test.ts`, `test/audit-lab.test.ts`

**Interfaces:**
- Produces:
  - `export type LabRunner = (url: string, formFactor: "mobile" | "desktop") => Promise<LhrLike>`
  - `AuditOptions.lab?: LabRunner`. When it is set, `lighthouseFindings` does three things. It asks `options.fetch?.gate?.beforeRequest(new URL(url))`, and on a refusal throws a `RequestRefusedError` as `fetchPage` would. It then calls `options.lab(url, formFactor)` instead of `runLighthouse`. Finally it builds the result with `summarize(lhr, url, formFactor)`.
  - In `psi.ts`:
    - `interface PsiOptions { apiKey: string; cache?: FieldDataCache; fetch?: typeof fetch }`
    - `pageSpeedInsights(url: string, formFactor: "mobile" | "desktop", options: PsiOptions): Promise<LhrLike>`
    - `class LabUnavailableError extends ExpectedError`
    - It reuses field-data.ts's `FieldDataCache` (`get`/`put`).

- [ ] **Step 1: Write failing tests.**
  - `pageSpeedInsights` with a stubbed `fetch`:
    - The query has `strategy=MOBILE`, `category=PERFORMANCE`, `category=SEO` and `key`.
    - A 429 throws `LabUnavailableError`.
    - A `lighthouseResult.runtimeError` throws an `ExpectedError` whose message has no URL.
    - A cache hit sends no request.
    - A miss puts an entry under a key that holds no URL.
  - `audit` with `lab` set:
    - A gate that refuses means the runner is never called, and the audit answers the refusal.
    - A runner that throws `LabUnavailableError` gives the `tool.lighthouse-unavailable` finding.
    - A recorded PSI-shaped LHR without `agentic-browsing`: the findings match `performanceFindings` for the same metrics, no agentic-browsing finding fires, and `agenticBrowsingScore` is `null`.
    - Use the fixture `test/fixtures/psi-lhr.json`, a trimmed real-shaped PSI result with the audits `summarize` reads.
- [ ] **Step 2:** Run `pnpm exec vitest run test/psi.test.ts test/audit-lab.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The local Lighthouse path, without `lab`, must stay unchanged.
- [ ] **Step 4:** Run the tests, then `pnpm run test` and `pnpm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lighthouse): lab results from a supplied runner, and a pagespeed insights client (#222)`

### Task 2: Hosted. Premium `lighthouse` for subscribers

**Files:**
- Modify:
  - `src/mcp-hosted.ts`: the premium `seo_audit_page` gains `lighthouse` and `formFactor`, worded like the local tool's. `HostedProfile.lab?: LabRunner`. `auditOptions` sets `lab` only when it is asked for and `paid` is set. Add the subscription check, with inline html skipping it.
  - `hosted/src/index.ts`: set `lab` for premium from `PSI_API_KEY` with a `psi` cache. If the key is missing, set a runner that throws `LabUnavailableError("Lab performance is not set up on this server.")`.
  - `hosted/src/limits.ts`: `LAB_CALLS` per caller key for a call with `lighthouse`, with the reason `lab_calls`.
  - Both wrangler configs: the `LAB_CALLS` ratelimit.
  - `hosted/test/configs.test.ts`.
  - `src/mcp-hosted.ts` `LimitReason` gains `"lab_calls"`.
- Test: `test/hosted.test.ts` (premium listing has `lighthouse` and `formFactor`, free does not), `hosted/test/limits.test.ts`, and a workerd test in `hosted/test/worker.test.ts`.

- [ ] **Step 1: Write failing tests.**
  - The free schemas do not have `lighthouse`, and the premium ones do.
  - An unpaid premium call with `lighthouse: true` gets the subscription error. With `html` it does not.
  - A paid call calls `lab` once.
  - The 6th lab call in a minute is refused with `lab_calls`.
  - The same URL and strategy twice: one PSI request, through the `psi` cache stub.
  - workerd: a premium call with `lighthouse: true` and no `PSI_API_KEY` answers with the `tool.lighthouse-unavailable` finding.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm run hosted:verify` and `pnpm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosted): lab performance for subscribers from pagespeed insights (#222)`

### Task 3: Docs, changeset, verify

**Files:**
- Modify:
  - `README.md`
  - `hosted/README.md`: the "Lab performance for subscribers" section; `PSI_API_KEY` setup (enable the PageSpeed Insights API on the same Google Cloud project as CrUX, and restrict the key to both APIs); the limit and its reason in Telemetry
  - `skills/seo-audit/SKILL.md`
  - `AGENTS.md`: Layout gets one sentence for `psi.ts` and `AuditOptions.lab`
- Create: `.changeset/premium-psi.md` (minor; no premium host URL)

- [ ] **Step 1:** Write the edits. **Step 2:** Run `pnpm run verify`. Expected: exit 0. **Step 3: Commit** `docs(hosted): lab performance for subscribers (#222)`
