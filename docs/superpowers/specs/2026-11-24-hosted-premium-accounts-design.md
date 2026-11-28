# Premium accounts for the hosted server: design

Issue #229, step 2 of the plan in its decision comment. Date: 2026-11-24.

## Intent

Some features RIVI Software wants to offer on the hosted server cost real money to run:

- Rendering with Browser Run (#230).
- Lab performance from PageSpeed Insights (#222).
- Bigger crawls (#209).
- Search Console and Bing data (#226, #227).
- Watched sites (#228).

They have to be paid for without changing what makes people try the tool: a free, anonymous server with today's tools and limits. This step builds the seam those features will sit behind. It covers an account, a sign-in that MCP clients can complete, a subscription through Stripe, and one entitlement check that a tool asks. No paid feature ships in this step. Rendering (#230) is the first, in its own pull request, behind this check.

The waitlist (#232, PR #236) went live today to measure demand and price. This work does not wait for its answers: the price is a Stripe setting, not code.

## Goals

- A paying user adds `https://premium.agentic-seo.org/mcp` as a connector in claude.ai, ChatGPT or Claude Code. The client starts MCP OAuth there. The user signs in with their email address, and every tool call then carries the account.
- A user subscribes, manages and cancels on the website, through Stripe Checkout with Stripe Managed Payments. Stripe is the merchant of record and handles VAT, receipts, disputes and refunds.
- One function, `entitlement(call)`, answers whether a call is paid for: `"subscription"` or `null` now, and `"per_call"` later (MPP, step 4) with no tool changing.
- `$mcp_tool_call` gains a `paid` property (`subscription`, `per_call` or absent).

## Decisions from the maintainer

- **Live in Stripe test mode when it merges.** The premium host, `/account` and checkout are reachable in production with RIVI's Stripe sandbox keys, so nobody can pay real money yet. Real clients (claude.ai, ChatGPT, Claude Code) can try the OAuth flow.
  - Going live later means swapping the secrets and `STRIPE_PRICE` for live ones, with no code change, after #230 ships and the privacy policy is updated.
  - Until then, the README, the landing page and the skill don't advertise the premium host. The hosted README documents it as a test.
- **Anyone can create an account.** A code sent to a new address creates the account at its first successful sign-in, on the website and in the OAuth popup alike. There is no waitlist gate.
- **Limits per account on the premium host.**
  - A signed-in caller there is its own caller, a new caller kind beside IP and platform, with the per-IP limits: `CALLER_CALLS`, `CALLER_CRAWLS` and `CALLER_SITES`.
  - The Durable Object keeps that caller's sites for the day as keyed hashes, as it does for an IP address, under a key derived from the account id. They are gone when the day ends.
  - This is the only place an account touches site data, and it is limited to the day's cap.
  - The rate-limit key is the account id, never the IP, so a paying claude.ai user never draws from the shared platform pool.
- **Deleting an account with an active subscription cancels it immediately, with a prorated refund of the unused period.**
  - The order is: cancel at Stripe (`prorate=true`, `invoice_now=true`, so Stripe issues the credit), then refund the credit to the payment method, then delete the row and revoke the grants.
  - If any Stripe step fails, the account stays and the page says to try again, so no paid subscription is left without an account.
  - A webhook event for a customer or account that no longer exists is acknowledged with 2xx and ignored.
  - The builder confirms against Stripe's docs which call turns the proration credit into a refund under Managed Payments. If it can't be done automatically, they bring that back to the maintainer before building around it.

## Non-goals

- Any paid feature, and any change to a tool's options, schema or description. Those come with #230.
- Higher limits for subscribers than the per-IP limits. Per-account limits (see the decisions above) apply until a paid feature needs more.
- Per-call payment (MPP or x402), which is step 4.
- Teams, seats, several plans, or annual pricing in code. Stripe's catalogue can hold prices, but the code knows one price id.
- Google or GitHub sign-in. Search Console (#226) will add a Google connection to an existing account later. It is not a sign-in method.

## Anti-goals (failure even if it works)

- Anything changes for an anonymous caller of `agentic-seo.org/mcp`: a 401, a new prompt, sign-in metadata that makes claude.ai offer a sign-in, a new limit, or a slower answer.
- An account id, a Stripe customer id or an email address reaches PostHog, Analytics Engine or the Worker's logs. A paid account is an identity, so billing stays apart from analytics (AGENTS.md, Telemetry).
- An account records which sites its owner audited, beyond the day's sites cap above.
- A paying caller gets an exception to robots.txt, signing or `Crawl-delay` (#41).
- Personal data leaves the EU at rest.

## Constraints from the project

- Both Workers bundle `src/` from one commit and deploy MCP server first, website second (`deploy-hosted.yml`). Code the website calls on shared state must stay additive.
- Each new path or hostname of the MCP Worker needs a route in `wrangler.jsonc`, listed in `hosted/test/configs.test.ts`. Settings both Workers share are held equal there.
- Wrangler's dev server gives every request the first route's hostname (AGENTS.md, Gotchas). Local runs and workerd tests therefore cannot tell the premium host from `agentic-seo.org` by hostname alone.
- Each website page that shows an email address is wrapped in `PRIVATE` for session replay (`hosted/src/site/analytics-script.ts`), and `analytics-script.test.ts` must still find no leak.
- Page script lives in `files.ts` and is served at `/site.js`. There is no inline script (CSP).
- Everything from outside goes through `esc` before it is HTML.
- Forms answer `Origin: null` from no-referrer pages (memory #19, `hosted/src/site/forms.ts`). Reuse the waitlist's form handling.
- Stripe Managed Payments:
  - Subscriptions are created only through Checkout (`mode=subscription`, `managed_payments[enabled]=true`, API version `2025-03-31.basil` or later).
  - The product needs an eligible tax code. `txcd_10103001`, SaaS for business use, fits.
  - Customers manage subscriptions at link.com, and can also use Stripe's customer portal, which we may link.
  - When a customer asks Stripe to delete their data, Stripe cancels the subscription. Our webhook handles that cancellation like any other.
  - Checkout cannot run on our own domain.
- `@cloudflare/workers-oauth-provider` (1.3.0) stores grants, clients and tokens in KV only, bound as `OAUTH_KV`:
  - Tokens and secrets are kept as hashes, and `props` encrypted. The grant's `userId` and `metadata` are plain text.
  - KV has an EU jurisdiction (GA 2026-10-02), set when the namespace is created. Reads may still be cached outside the EU. This is acceptable only because nothing personal goes into plain fields (see Data).
- MCP authorization spec (2026-07-28): clients should prefer Client ID Metadata Documents (CIMD), and Dynamic Client Registration (DCR) is deprecated but still what many clients use. Turn on both. CIMD needs `global_fetch_strictly_public`, which `wrangler.jsonc` already sets.

## Approaches considered

Where paying users connect:

- **A. A separate hostname, `premium.agentic-seo.org/mcp`, which requires sign-in. (Chosen.)** All OAuth metadata lives on that hostname. `agentic-seo.org` serves none, so free connectors there cannot be pushed into a sign-in. claude.ai reportedly does that when it finds `/.well-known/oauth-*` on a connector's origin: anthropics/claude-ai-mcp #713 and #402. The cost is one more hostname, and two addresses to explain.
- **B. The same `/mcp` with an optional bearer token.** One address, but a client only starts OAuth on a 401, so claude.ai and ChatGPT would never offer the sign-in. The metadata on the origin risks the bug above for free users. Rejected.
- **C. `agentic-seo.org/mcp/premium`.** No new hostname, but free users carry B's metadata risk. Rejected.

Billing provider:

- **Stripe Managed Payments (chosen by the maintainer).** It is a merchant of record, the Netherlands is a supported business location, and subscriptions run through Checkout. It is also the same provider that MPP's card payments use in step 4.
- **Paddle.** Also a merchant of record, but it needs a manual domain and business verification, and step 4 would add Stripe beside it.
- **Lemon Squeezy.** Out: sign-ups closed on 2026-11-16, and it stops processing payments on 2027-03-31.
- **Stripe with Stripe Tax.** Leaves VAT filing with RIVI. The maintainer wanted a merchant of record.

## The design

### Hostnames and Workers

- `premium.agentic-seo.org` is a custom domain of the MCP server's Worker (`wrangler.jsonc`).
- The Worker sends a request for that host to an `OAuthProvider` from `@cloudflare/workers-oauth-provider`:
  - `apiRoute`: `/mcp`.
  - `apiHandler`: today's `handleMcp`, with the grant's props on the call.
  - The authorization server's endpoints: `/authorize`, `/token`, `/register` (DCR), and CIMD.
  - The `.well-known` documents, which the provider serves.
- Every other host takes today's path, unchanged.
- Locally and in workerd tests, the premium host is chosen by a path prefix or a header that only `.dev.vars` turns on. A deployed Worker never trusts either. Builder's call which; see the Gotcha about hostnames above.
- The website's Worker keeps `agentic-seo.org` and gains the account pages and the Stripe webhook.

### Accounts and data

- A new EU D1 database, `agentic-seo-check-accounts`, bound as `ACCOUNTS` to both Workers. Its migrations go in a new directory, so the waitlist's migrations stay their own.
- **`accounts` table:**
  - `id`: random, opaque.
  - `email`: unique, normalised as the waitlist normalises it.
  - `stripe_customer_id`: nullable.
  - `subscription_status`: Stripe's status, nullable.
  - `current_period_end`.
  - `created_at`, `updated_at`.
  - No record of audits or sites.
- **`sign_in_codes`:** one short-lived code per address, kept only as a hash, with an attempt count and an expiry. It serves both the website and the OAuth sign-in.
- **`OAUTH_KV`:** a KV namespace created with `--jurisdiction=eu`. The grant's plain `userId` is the opaque account id, and `metadata` stays empty. The email address goes only into the encrypted `props`, if anywhere.
- **Deleting an account:** from the account page. It cancels an active subscription at Stripe first, then deletes the row. Its OAuth grants live in the MCP Worker's KV, out of the website's reach, so a token whose account is gone is answered 401 at its next call, and the grants expire by their own TTL.

### Sign-in

- By email, with a six-digit code, sent from Email Service as the waitlist sends.
- A code works in the OAuth popup, where a link would open in another browser or tab.
- One module (`hosted/src/accounts/`, builder's call on the path) serves:
  - `/authorize` on the premium host, which completes the grant once the code checks.
  - `/account/sign-in` on the website, which sets a session cookie.
- The cookie is host-only on `agentic-seo.org`, `Secure`, `HttpOnly` and `SameSite=Lax`, signed with a new secret. It holds no email.
- Sending is limited by a new rate-limit namespace per IP address and by a minimum interval per address (as the waitlist's `sent_at` does). Turnstile guards the form, as on the waitlist.
- The consent page at `/authorize` names the client asking for access (from its CIMD or registration) and its redirect host. Its text escapes both.

### Billing

- **`/account`** (website, signed in) shows:
  - The address.
  - The subscription status.
  - **Subscribe**, which POSTs to `/account/checkout`. That creates a Checkout Session (`mode=subscription`, `managed_payments[enabled]=true`, the price from the var `STRIPE_PRICE`, `client_reference_id` = account id, `customer` when one exists, success and cancel URLs back to `/account`) and answers 303 to its URL.
  - **Manage**, which creates a customer portal session and answers 303 to it. A line also says the subscription can be managed at link.com.
  - **Delete my account**.
- **`POST /api/stripe`** (website) is the webhook:
  - It verifies `Stripe-Signature` with WebCrypto HMAC-SHA256 and a 5-minute tolerance, with the secret `STRIPE_WEBHOOK_SECRET`.
  - It handles `checkout.session.completed` (links the customer to the account through `client_reference_id`) and `customer.subscription.created`, `.updated` and `.deleted` (writes status and period end).
  - It is idempotent: it applies an event only if the event is newer than the row (`updated_at` against the event's `created`).
  - It answers 2xx for an event type it ignores.
- Stripe's API is called through `fetch` with form encoding, not the `stripe` package, to keep the bundle small and Worker-safe. Builder may change this if the package bundles cleanly.
- **New secrets on the website's Worker:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the cookie key, added to `secrets.required`.
  - `hosted/.dev.vars` is committed, so local Stripe keys never go there. They go in a git-ignored file that Wrangler reads for local runs, or the shell environment, and `.gitignore` covers it.
  - Production holds the sandbox keys as Worker secrets until going live.
- **What RIVI sets up in Stripe, and the README for the hosted server lists:**
  - Turn on Managed Payments.
  - Create the product with `txcd_10103001`, and its monthly price.
  - Create the webhook endpoint.
  - Add terms and privacy links in the Checkout settings.

### Entitlement

- `entitlement(call): Promise<"subscription" | "per_call" | null>` lives in the hosted code (`hosted/src/entitlement.ts`).
- In this step it reads the signed-in account from the grant's props and its row in D1. It answers `"subscription"` when the status is `active` or `trialing` and the period has not ended.
- It is computed once per tool call, never per request that calls no tool. `mayCallTool` already separates those.
- It is cached in the isolate for at most a minute, so a cancellation takes effect within a minute.
- Anonymous calls on `agentic-seo.org/mcp` never touch D1.
- `HostedProfile` gains the answer so that a tool can read it. No tool reads it yet.
- A signed-in user without a subscription gets the free tools and limits, as an anonymous caller does.

### Analytics and privacy

- `$mcp_tool_call` gains `paid`, from the entitlement. No account id, customer id or email. The hosted README's Telemetry section lists it.
- The account pages count pageviews as other pages do. Every element that shows an address is inside `PRIVATE`, and `analytics-script.test.ts` covers the new pages.
- No Analytics Engine record gains an account field.
- RIVI's privacy policy (`help.rivi.software`) needs a section on accounts and on Stripe as merchant of record before going live. That is a maintainer task outside the repository, noted in the pull request.

### Errors

- A sign-in or billing failure the user can act on (a wrong or expired code, too many codes, Stripe unavailable) is an `ExpectedError` or a page with a notice, never a tracked exception.
- A webhook with a bad signature answers 400, and error tracking does not record it.

### Tests

- Webhook signature verification: valid, tampered, stale, rotated secrets.
- Event application, including events that arrive out of order.
- The entitlement for each subscription status.
- The sign-in code's expiry, attempts and rate limit.
- That `agentic-seo.org` serves no `/.well-known/oauth-*` document and answers `/mcp` without a token as today.
- Per-account limits: a signed-in caller from a platform address is counted against its account, not the platform pool.
- Account deletion with an active subscription: cancel, refund and delete in order, and a Stripe failure leaves the account in place.
- That the premium host answers 401 with `WWW-Authenticate` without a token.
- A full OAuth round trip in workerd, against a mocked Stripe API (`fetch` stub).
- `configs.test.ts` gains the new route, binding and secrets.

## Left to the builder

- Module layout and names under `hosted/src/`.
- How local runs select the premium host.
- The exact page layouts, in the site's existing style.
- The isolate cache's mechanics.
- Whether to use the `stripe` package or `fetch`.
- Code length, expiry and attempt numbers, within: 6 digits, 10 minutes, 5 attempts.
