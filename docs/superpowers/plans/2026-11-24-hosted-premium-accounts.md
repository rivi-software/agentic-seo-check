# Premium accounts for the hosted server: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accounts, sign-in by emailed code, a Stripe Managed Payments subscription, and one entitlement check, with paying users connecting at `https://premium.agentic-seo.org/mcp` through MCP OAuth while `agentic-seo.org/mcp` stays exactly as it is.

**Architecture:**

- **Data:** a new EU D1 database `ACCOUNTS`, bound to both Workers, holds accounts and sign-in codes.
- **Website Worker:** gains `/account` (sign in, subscribe, manage, delete) and Stripe's webhook at `POST /api/stripe`.
- **MCP Worker:** gains a custom domain, `premium.agentic-seo.org`, whose requests go to an `OAuthProvider` from `@cloudflare/workers-oauth-provider` (grants in an EU KV namespace `OAUTH_KV`). Its `/mcp` runs today's `handleMcp` with the account as the caller.
- **Entitlement:** `entitlement()` reads the account's subscription from D1 per tool call. The answer reaches the tools through `HostedProfile.paid` and the analytics as `paid`.

**Tech Stack:**

- Cloudflare Workers, D1, KV, Email Service, Rate Limiting.
- `@cloudflare/workers-oauth-provider` 1.3.0.
- Stripe's REST API through `fetch` (API version `2025-03-31.basil` or later).
- Vitest in Node (with `node:sqlite` behind D1's API) and in workerd (`hosted/test/worker.test.ts`).

**Spec:** `docs/superpowers/specs/2026-11-24-hosted-premium-accounts-design.md`. Read it before any task; its "Decisions from the maintainer" and "Anti-goals" bind every task.

## Global Constraints

- An anonymous request to `agentic-seo.org/mcp` (or a former server host) takes today's code path: no D1 read, no KV read, no new header, no 401, and no new latency.
- `agentic-seo.org` serves no `/.well-known/oauth-authorization-server` and no `/.well-known/oauth-protected-resource*`. Only `premium.agentic-seo.org` does.
- No account id, Stripe customer id or email address reaches PostHog, Analytics Engine, `console.*` or an error report. `paid` (`"subscription"`, or absent) is the only new analytics property.
- An account keeps no record of audits or sites. The only exception is the Durable Object's existing day-scoped, keyed-hash sites cap under the account's caller key.
- Stripe keys never go in a tracked file. `hosted/.dev.vars` is committed. Local Stripe keys go in the git-ignored `hosted/.dev.secrets` (Task 8).
- Stripe calls: `managed_payments[enabled]=true`, `mode=subscription`, price from the var `STRIPE_PRICE`, `client_reference_id` = account id, `subscription_data[metadata][account_id]` = account id.
- Webhook: HMAC-SHA256 over `` `${t}.${rawBody}` ``, accept any `v1` in `Stripe-Signature`, tolerance 300 s.
- A sign-in code is 6 digits, valid for 10 minutes, with 5 attempts, kept as a SHA-256 hash only. A new code for the same address may go out once a minute.
- Session cookie `__Host-account`: `Secure; HttpOnly; SameSite=Lax; Path=/`, valid 30 days, value `` `${accountId}.${expiresMs}.${hmac}` ``, signed with the secret `ACCOUNT_SESSION_KEY`.
- Every value from outside (email, client name, redirect host) goes through `esc` (`hosted/src/site/html.ts`) before HTML. Each element showing an email address sits inside the `PRIVATE` marking of `hosted/src/site/analytics-script.ts`.
- A failure the user can act on is an `ExpectedError` or a page notice, never `reportError`. A bad webhook signature answers 400 and is not reported.
- Write prose, comments and copy without em dashes (the maintainer's preference). Name things in plain English. A comment says why.
- Imports name the emitted `.js` file. Nothing does Node-only work at module load (the code bundles for workerd).

## Review Focus

1. **A token whose account was deleted:** `premium.agentic-seo.org/mcp` answers 401 `invalid_token`, so the client signs in again. It never falls back to free, anonymous use. Test in Task 7.
2. **The same person types their address differently** (`Ann@Example.COM ` vs `ann@example.com`): it is one account. Reuse `normalEmail`. Test in Task 1.
3. **Subscribe twice** (an account already `active` POSTs `/account/checkout`): it is redirected to the portal, never a second subscription. Test in Task 5.
4. **A code is used twice, or guessed:** a used code fails, and the sixth wrong attempt fails even with the right code. Test in Task 2.
5. **The MCP Worker without the premium bindings** (`OAUTH_KV` or `ACCOUNTS` absent, as in older local setups): free `/mcp` still answers. Test in Task 7.

---

### Task 1: The accounts database and its store

**Files:**
- Create: `hosted/migrations-accounts/0001_accounts.sql`
- Create: `hosted/src/d1.ts` (the D1 subset type, moved out of `site/waitlist.ts`, which re-exports it under its old names)
- Create: `hosted/src/accounts/store.ts`
- Create: `hosted/test/helpers/d1.ts` (the `d1Of(db: DatabaseSync)` fake moved out of `waitlist.test.ts`, extended with `all()`)
- Modify: `hosted/test/waitlist.test.ts` (import `d1Of` from the helper)
- Test: `hosted/test/accounts-store.test.ts`

**Interfaces:**
- Produces, in `d1.ts`:
  - `interface D1Statement { bind(...v: unknown[]): D1Statement; run(): Promise<{ success: boolean }>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> }`
  - `interface D1Like { prepare(sql: string): D1Statement; batch?(s: D1Statement[]): Promise<unknown> }`
- Produces, in `store.ts`:
  - `interface Account { id: string; email: string; stripeCustomerId: string | null; subscriptionId: string | null; subscriptionStatus: string | null; currentPeriodEnd: number | null; stripeEventAt: number | null }`
  - `accountForSignIn(db: D1Like, email: string, now: number): Promise<Account>`: creates the account on first sign-in, or returns the existing one.
  - `accountById(db: D1Like, id: string): Promise<Account | null>`
  - `accountByCustomer(db: D1Like, customerId: string): Promise<Account | null>`
  - `linkCustomer(db: D1Like, id: string, customerId: string): Promise<void>`
  - `applySubscription(db: D1Like, update: { accountId: string; customerId: string; subscriptionId: string; status: string; currentPeriodEnd: number; eventAt: number }): Promise<boolean>`: writes only when `eventAt > stripe_event_at` or that column is null, and returns whether it wrote.
  - `deleteAccount(db: D1Like, id: string): Promise<void>`

- [ ] **Step 1: Write the migration.**
  - Table `accounts`: `id TEXT PRIMARY KEY NOT NULL`, `email TEXT NOT NULL UNIQUE`, `stripe_customer_id TEXT UNIQUE`, `subscription_id TEXT`, `subscription_status TEXT`, `current_period_end INTEGER`, `stripe_event_at INTEGER`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`.
  - Table `sign_in_codes`: `email TEXT PRIMARY KEY NOT NULL`, `code_hash TEXT NOT NULL`, `attempts INTEGER NOT NULL DEFAULT 0`, `expires_at INTEGER NOT NULL`, `sent_at INTEGER NOT NULL`.
  - Comment each column as `0001_waitlist.sql` does: what it holds and why, and that no sites are kept.
- [ ] **Step 2: Move the D1 type and the test fake.** Run `pnpm run hosted:test -- waitlist`. Expected: PASS, unchanged.
- [ ] **Step 3: Write failing tests** in `accounts-store.test.ts`, against the migration in `node:sqlite`:
  - `accountForSignIn` with `" Ann@Example.COM"` then `"Ann@example.com"` returns the same `id`, which matches `/^acc_[\w-]{22,}$/`.
  - `applySubscription` with `eventAt` 200 writes `active`. Then `eventAt` 100 with `canceled` returns `false`, and the status stays `active`.
  - `accountByCustomer("cus_x")` finds the account after `linkCustomer`.
  - After `deleteAccount`, `accountById` returns `null`.
- [ ] **Step 4:** Run `pnpm run hosted:test -- accounts-store`. Expected: FAIL (module missing).
- [ ] **Step 5: Implement `store.ts`.**
  - The id is `acc_` + `randomSecret(16)` (`hosted/src/secrets.ts`).
  - Email goes through `normalEmail` (`hosted/src/site/waitlist.ts`). Callers pass already-checked addresses, so a `null` from it throws.
  - `accountForSignIn` is one `INSERT … ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at RETURNING *`.
- [ ] **Step 6:** Run `pnpm run hosted:test -- accounts-store`. Expected: PASS.
- [ ] **Step 7: Commit:** `feat(hosted): an accounts database for the premium tier (#229)`.

### Task 2: Sign-in codes

**Files:**
- Create: `hosted/src/accounts/codes.ts`
- Modify: `hosted/src/site/forms.ts` (`FormAction` gains `"sign_in"`)
- Test: `hosted/test/accounts-codes.test.ts`

**Interfaces:**
- Consumes: `D1Like` and `accountForSignIn` (Task 1); `normalEmail` (waitlist); `sha256Hex` (secrets).
- Produces:
  - `interface CodeEnv { ACCOUNTS: D1Like; EMAIL?: Pick<SendEmail, "send">; ACCOUNTS_FROM?: string; SIGN_IN_CODES: RateLimit }`
  - `type SendResult = "sent" | "invalid_email" | "too_soon" | "limited" | "unavailable"`
  - `sendCode(env: CodeEnv, typed: string, ip: string | null, now: number): Promise<SendResult>`
  - `type CheckResult = { account: Account } | { error: "wrong" | "expired" | "locked" }`
  - `checkCode(env: CodeEnv, typed: string, code: string, now: number): Promise<CheckResult>`
  - `CODE_MINUTES = 10`, `CODE_ATTEMPTS = 5`, `RESEND_MS = 60_000`

- [ ] **Step 1: Write failing tests**, with Email Service in memory as `waitlist.test.ts` does:
  - `sendCode` sends one mail whose text contains a 6-digit code. The table holds only its hash: no row contains the code.
  - A second `sendCode` within 60 s answers `too_soon` and sends nothing.
  - `checkCode` with the right code returns the account. Using the same code again answers `expired`, because the row is gone after success.
  - Five wrong codes, then the right one, answers `locked`.
  - At `now + 10 min + 1`, the right code answers `expired`.
  - The rate limiter answering `{ success: false }` gives `limited`.
- [ ] **Step 2:** Run `pnpm run hosted:test -- accounts-codes`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The code comes from `crypto.getRandomValues`, uniform over 000000 to 999999 by rejection sampling.
  - The comparison hashes the typed code and compares the hashes.
  - The mail's subject is `Your ${PRODUCT_NAME} sign-in code`. Its text names the code, says it works for 10 minutes, and says to ignore the mail if they did not ask.
  - The limiter key is the IP, through `callerOf(ip, []).key`.
- [ ] **Step 4:** Run `pnpm run hosted:test -- accounts-codes`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(hosted): sign in to an account with an emailed code (#229)`.

### Task 3: Stripe: API calls, webhook signature, events, deletion

**Files:**
- Create: `hosted/src/accounts/stripe.ts`
- Test: `hosted/test/accounts-stripe.test.ts`

**Interfaces:**
- Consumes: the store (Task 1).
- Produces:
  - `interface StripeEnv { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; STRIPE_PRICE?: string }`
  - `billingOpen(env: StripeEnv): boolean`: all three are set.
  - `checkoutUrl(env: StripeEnv, account: Account, origin: string): Promise<string>`
  - `portalUrl(env: StripeEnv, account: Account, origin: string): Promise<string>`
  - `verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSeconds: number): Promise<boolean>`
  - `applyStripeEvent(db: D1Like, event: unknown): Promise<"applied" | "ignored">`
  - `cancelAndRefund(env: StripeEnv, account: Account): Promise<void>`: throws `BillingUnavailableError extends ExpectedError` on any non-2xx.

- [ ] **Step 1: Confirm the refund call before building on it.**
  - Read Stripe's docs on cancelling a subscription with proration under Managed Payments: `DELETE /v1/subscriptions/{id}` with `prorate=true&invoice_now=true`, and how the resulting credit becomes a refund (a refund on the latest invoice's charge for the prorated amount, or a credit note with `refund_amount`).
  - Write what you confirmed as a comment above `cancelAndRefund`, with the doc links.
  - **If Managed Payments allows no programmatic prorated refund, stop and report to the maintainer** (spec, Decisions) instead of building something else.
- [ ] **Step 2: Write failing tests,** with `fetch` stubbed by `vi.stubGlobal` and recording each request:
  - `verifyStripeSignature`:
    - True for a header built with the secret at `t = now`.
    - False with one byte of the body changed.
    - False at `t = now - 301`.
    - True when the header carries two `v1` values and the second matches (rotation).
    - False for a null header.
  - `checkoutUrl` posts form fields `mode=subscription`, `managed_payments[enabled]=true`, `line_items[0][price]=<STRIPE_PRICE>`, `line_items[0][quantity]=1`, `client_reference_id=<id>` and `subscription_data[metadata][account_id]=<id>`. It sends `customer` only when the account has one, and the `Stripe-Version` header. It returns the response's `url`.
  - `applyStripeEvent`:
    - `checkout.session.completed` links the customer.
    - `customer.subscription.updated`, with `metadata.account_id` and `created` 200, then a stale `.updated` with `created` 100: the status keeps the newer one.
    - `customer.subscription.deleted` sets `canceled`.
    - An event for an account id that does not exist answers `ignored` and throws nothing.
    - An unknown event type answers `ignored`.
  - `cancelAndRefund` sends the requests confirmed in Step 1, in order. A 500 on the first throws `BillingUnavailableError`.
- [ ] **Step 3:** Run `pnpm run hosted:test -- accounts-stripe`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Form encoding uses `URLSearchParams`.
  - Read events through a small zod schema of the fields used: `type`, `created`, `data.object.{id, customer, status, metadata.account_id, client_reference_id, items.data[0].current_period_end}`.
  - The HMAC uses WebCrypto, and the comparison is constant-time over the hex strings.
- [ ] **Step 5:** Run `pnpm run hosted:test -- accounts-stripe`. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(hosted): stripe managed payments checkout, webhook and cancellation (#229)`.

### Task 4: The session cookie

**Files:**
- Create: `hosted/src/accounts/session.ts`
- Test: `hosted/test/accounts-session.test.ts`

**Interfaces:**
- Produces:
  - `SESSION_DAYS = 30`
  - `sessionCookie(accountId: string, key: string, now: number): Promise<string>`: the whole `Set-Cookie` value.
  - `clearSessionCookie(): string`
  - `readSession(request: Request, key: string, now: number): Promise<string | null>`: the account id.

- [ ] **Step 1: Write failing tests:**
  - Round trip: the id comes back.
  - A changed id with the same signature gives `null`.
  - An expired cookie gives `null`.
  - A cookie signed with another key gives `null`.
  - `sessionCookie` contains `__Host-account=`, `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`, and no `Domain`.
- [ ] **Step 2:** Run `pnpm run hosted:test -- accounts-session`. Expected: FAIL. **Step 3:** Implement with HMAC-SHA256 from WebCrypto. **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(hosted): a signed session cookie for account pages (#229)`.

### Task 5: The website's account pages and webhook route

**Files:**
- Create: `hosted/src/site/account-page.ts` (HTML, in the style of `premium-page.ts`)
- Create: `hosted/src/site/account-routes.ts`
- Modify: `hosted/src/site/routes.ts` (call `accountRoute` beside `waitlistRoute`); the type `SiteEnv` gains `AccountSiteEnv`
- Modify: `hosted/src/site/files.ts` (only if the page needs script, for example the Turnstile widget, as on `/premium`)
- Modify: `hosted/wrangler.site.jsonc`:
  - The `d1_databases` entry `ACCOUNTS` (database `agentic-seo-check-accounts`, `migrations_dir: "migrations-accounts"`). The id is a placeholder until RIVI creates it (Task 8).
  - The `ratelimits` entry `SIGN_IN_CODES` (`namespace_id: "35008"`, `limit: 5, period: 60`).
  - Vars `ACCOUNTS_FROM: "premium@rivi.software"` and `STRIPE_PRICE: ""`.
  - `secrets.required` gains `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `ACCOUNT_SESSION_KEY`.
- Modify: `package.json` (`site:migrate-accounts`, as `site:migrate` is, for `agentic-seo-check-accounts`)
- Test: `hosted/test/accounts-site.test.ts`; `hosted/test/analytics-script.test.ts` (the account page leaks no email)

**Interfaces:**
- Consumes: Tasks 1 to 4; `personSent`, `readForm` and `fromThisSite` (`forms.ts`); `esc`; `PRIVATE`.
- Produces:
  - `type AccountSiteEnv = CodeEnv & StripeEnv & TurnstileEnv & AnalyticsEnv & { ACCOUNT_SESSION_KEY?: string }`
  - `accountRoute(request: Request, env: AccountSiteEnv, ctx: Pick<ExecutionContext, "waitUntil">, pathname: string): Promise<Response> | null`
  - Routes:
    - `GET /account`: signed in shows status and actions; signed out shows the email form.
    - `POST /account/sign-in`: sends the code, then shows the code form.
    - `POST /account/verify`: sets the cookie and answers 303 to `/account`.
    - `POST /account/checkout`: 303 to Stripe; an `active` or `trialing` account goes to the portal instead.
    - `POST /account/portal`: 303 to Stripe's portal.
    - `POST /account/delete`: `cancelAndRefund` when subscribed, then `deleteAccount`, clear the cookie, and show the "deleted" page.
    - `POST /account/sign-out`.
    - `POST /api/stripe`: the webhook.
  - Every POST except `/api/stripe` requires `fromThisSite`.

- [ ] **Step 1: Write failing tests,** in Node as `waitlist.test.ts` drives `waitlistRoute`:
  - The sign-in flow sets a `__Host-account` cookie and lands on `/account` showing the address inside `PRIVATE`.
  - `/account/checkout` for an `active` account answers 303 to the portal URL, and no `checkout/sessions` request is sent.
  - `/account/delete` with Stripe answering 500 keeps the row and shows a notice.
  - `/api/stripe` with a bad signature answers 400 and calls no `reportError`. With a good one and `customer.subscription.updated`, it answers 200 and updates the row.
  - Without `STRIPE_SECRET_KEY`, `/account` says billing is unavailable and offers no Subscribe button.
  - `analytics-script.test.ts`: add the signed-in `/account` page to its leak check.
- [ ] **Step 2:** Run `pnpm run hosted:test -- accounts-site analytics-script`. Expected: FAIL.
- [ ] **Step 3: Implement the routes and pages.**
  - The page says the account is in test mode while `STRIPE_SECRET_KEY` starts with `sk_test_`: "Payments are in test mode. No card is charged."
  - The page links link.com for managing the subscription, and the privacy policy.
- [ ] **Step 4:** Run the tests again. Expected: PASS. Run `pnpm run hosted:check`. Expected: no type errors.
- [ ] **Step 5: Commit:** `feat(site): an account page to sign in, subscribe and delete (#229)`.

### Task 6: The entitlement, the account caller, and `paid`

**Files:**
- Create: `hosted/src/entitlement.ts`
- Modify: `hosted/src/callers.ts` (`accountCaller`)
- Modify: `src/mcp-hosted.ts` (`HostedProfile.paid`)
- Modify: `hosted/src/limits.ts` (`hostedProfile` takes and passes `paid`)
- Modify: `hosted/src/analytics.ts` (`hostedAnalytics` takes `paid`, adds it to `context().properties`, and lists it in `CALL_PROPERTIES`)
- Modify: `hosted/README.md` (Telemetry: the `paid` property)
- Test: `hosted/test/entitlement.test.ts`; `hosted/test/analytics.test.ts`; `hosted/test/limits.test.ts`

**Interfaces:**
- Consumes: `accountById` (Task 1).
- Produces:
  - `type Paid = "subscription" | "per_call"`. `per_call` is declared now and produced by nothing until step 4 of #229.
  - `entitlement(env: { ACCOUNTS: D1Like }, accountId: string, now: number): Promise<{ account: Account | null; paid: Paid | null }>`
    - `paid` is `"subscription"` when the status is `active` or `trialing` and `currentPeriodEnd * 1000 > now`.
    - The answer is cached per isolate by account id for 60 s, at most 1,024 entries, oldest dropped first.
  - `accountCaller(accountId: string): Caller` returns `{ key: \`account:${accountId}\`, platform: null }`, so `CALLER_*` limits and the sites cap apply per account.
  - `HostedProfile.paid?: Paid`: documented as "set on the premium host when the call is paid for; no tool reads it yet".
  - `hostedAnalytics(env, ctx, caller, sessionHeader, paid?: Paid)`

- [ ] **Step 1: Write failing tests:**
  - `entitlement` for each status: `active`, `trialing` and `past_due`, then `canceled`, then `active` with an ended period.
  - A second call within 60 s sends no query (count `prepare` calls). At 61 s it queries again.
  - `analytics.test.ts`: a tool call with `paid: "subscription"` sends `paid: "subscription"`. Without it, `paid` is absent. No property value contains `acc_`.
  - `limits.test.ts`: two `accountCaller`s from the same IP are limited separately.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm run hosted:test -- entitlement analytics limits`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(hosted): one entitlement check, limits per account, and paid in the analytics (#229)`.

### Task 7: The premium host in the MCP Worker

**Files:**
- Create: `hosted/src/premium/provider.ts` (the `OAuthProvider`, built once at module scope)
- Create: `hosted/src/premium/authorize.ts` (`GET`/`POST /authorize`: email, then code, then consent)
- Create: `hosted/src/premium/pages.ts` (those pages, in the frame of `hosted/src/pages.ts`)
- Modify: `hosted/src/index.ts`:
  - `premiumRequest(request, env)` decides the host. It answers true for hostname `premium.agentic-seo.org`, or, only when `env.PREMIUM_DEV === "on"`, a request with the header `x-agentic-seo-premium: 1`.
  - Such a request goes to `provider.fetch`, and everything else to today's code.
  - `handleMcp` takes an optional `{ caller, paid }` override.
- Modify: `hosted/wrangler.jsonc`:
  - `routes` gains `{ "pattern": "premium.agentic-seo.org", "custom_domain": true }`.
  - `kv_namespaces`: `OAUTH_KV`, created with `--jurisdiction=eu`. The id is a placeholder until Task 8.
  - `d1_databases`: `ACCOUNTS`, the same database as in Task 5.
  - `send_email`: `EMAIL`, allowed sender `premium@rivi.software`.
  - `ratelimits`: `SIGN_IN_CODES`, 35008, the same as the website's.
  - Vars: `ACCOUNTS_FROM`, `PREMIUM_DEV: "off"`, `TURNSTILE_SITE_KEY`.
  - `secrets.required` gains `TURNSTILE_SECRET_KEY`.
- Modify: `hosted/.dev.vars` (`PREMIUM_DEV=on`)
- Modify: `hosted/test/configs.test.ts`: the new route; `ACCOUNTS` and `SIGN_IN_CODES` held equal across both configurations; `agentic-seo.org` routes gain no `/.well-known/oauth-*`.
- Modify: `package.json`: `@cloudflare/workers-oauth-provider` pinned to `1.3.0` in `dependencies` of the root (hosted has no package of its own); it must bundle.
- Test: `hosted/test/worker.test.ts` (workerd); `hosted/test/premium-authorize.test.ts` (Node)

**Provider settings (exact):**

```ts
new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler, // runs handleMcp with accountCaller(props.accountId) and entitlement().paid; 401 when the account is gone
  defaultHandler, // /authorize, and 404 for the rest
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["mcp"],
  requiredScopes: ["mcp"],
  resourceMetadata: {
    resource: "https://premium.agentic-seo.org/mcp",
    authorization_servers: ["https://premium.agentic-seo.org"],
  },
});
```

- `completeAuthorization` gets `userId: account.id`, `metadata: {}` and `props: { accountId: account.id }`. No email goes in the props.
- The consent page shows `details.clientName` and `details.redirectHost` through `esc`, and the loopback warning that `docs/consent-page.md` (in the package) shows.
- Errors follow the redirect-or-render table in that doc.

- [ ] **Step 1: Write failing workerd tests** in `worker.test.ts`:
  - `GET agentic-seo.org/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` answer 404 from both Workers.
  - An anonymous `initialize` POST to `/mcp` without the premium header answers 200 as before.
  - With the premium header and no token, `/mcp` answers 401, and its `WWW-Authenticate` names `resource_metadata`.
  - The full round trip: `POST /oauth/register` (DCR); `GET /authorize` with PKCE; POST the email (Email Service writes the code locally; read it from the stub or a test hook); POST the code; POST Allow; follow to the redirect with `code`; `POST /oauth/token`; then `tools/call seo_list_rules` with `Authorization: Bearer …` answers 200.
  - After the account row is deleted, the same token answers 401.
  - With `OAUTH_KV` and `ACCOUNTS` removed from the test config, an anonymous `/mcp` still answers 200.
- [ ] **Step 2: Write failing Node tests** in `premium-authorize.test.ts`:
  - A client name `<img src=x onerror=alert(1)>` renders escaped.
  - A wrong code shows the code form again with a notice, and no `completeAuthorization` is called.
- [ ] **Step 3:** Run `pnpm run hosted:test -- worker premium-authorize configs`. Expected: FAIL.
- [ ] **Step 4: Implement.** Read the package's `docs/consent-page.md`, `docs/resource-servers.md` and `docs/mcp-discovery.md` first.
- [ ] **Step 5:** Run `pnpm run hosted:verify`. Expected: PASS, the bundle builds.
- [ ] **Step 6: Commit:** `feat(hosted): premium.agentic-seo.org, the mcp server behind an account sign-in (#229)`.

### Task 8: Local secrets, setup docs, and the whole check

**Files:**
- Modify: `.gitignore` (`hosted/.dev.secrets`)
- Modify: `hosted/scripts/wrangler.ts`: for `dev`, read `hosted/.dev.secrets` (`KEY=value` lines) when it exists and pass each as `--var KEY:value`. Confirm `--var` is accepted by the installed Wrangler's `dev --help`; if it is not, pick Wrangler's documented way and note it in a comment.
- Modify: `hosted/README.md`:
  - A section "Premium accounts".
  - The Stripe dashboard setup, as spec Billing lists it: Managed Payments on, the product with `txcd_10103001` and its monthly price into `STRIPE_PRICE`, the webhook endpoint `https://agentic-seo.org/api/stripe` with the events from Task 3, and the terms and privacy links in the Checkout settings.
  - `wrangler d1 create agentic-seo-check-accounts --location weur --jurisdiction eu`, `wrangler kv namespace create OAUTH_KV --jurisdiction=eu`, `pnpm run site:migrate-accounts`, and the secrets per Worker.
  - The premium host is a test while the keys start with `sk_test_`.
- Modify: `AGENTS.md` (Layout): one sentence each for `hosted/src/accounts/`, `hosted/src/premium/`, `entitlement.ts` and `site/account-*.ts`; a Gotcha that `hosted/.dev.vars` is committed, so local secrets go in `hosted/.dev.secrets`.

- [ ] **Step 1:** Make the edits above.
- [ ] **Step 2:** Run `pnpm run verify`. Expected: every step passes.
- [ ] **Step 3:** Run `pnpm run hosted:dev` with test keys in `hosted/.dev.secrets`. Then run the MCP Inspector against `http://localhost:8787/mcp` with header `x-agentic-seo-premium: 1`. Expected: the sign-in opens, the code arrives in Wrangler's local mail file, and tools list after consent. Note what you saw in the pull request.
- [ ] **Step 4: Commit:** `docs(hosted): set up premium accounts and their local secrets (#229)`.
- [ ] **Step 5:** Open the pull request with the `open-pr` skill. Its body lists the maintainer's tasks:
  - Create the D1 database and the KV namespace, and put their ids in both configurations.
  - Set the secrets on both Workers. The sandbox secret key shared in chat should be rolled first.
  - Set up Stripe as the README says.
  - Add the custom domain.
  - Update the privacy policy before going live.
