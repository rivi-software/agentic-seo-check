# The hosted MCP server and the website

The MCP server of agentic-seo-check as a Cloudflare Worker, at `https://mcp.agentic-seo.rivi.software/mcp`, run by RIVI Software and free to use ([issue #35](https://github.com/rivi-software/agentic-seo-check/issues/35)). The same Worker serves the project's website at `https://agentic-seo.rivi.software`, with a page audit to run in the browser ([issue #39](https://github.com/rivi-software/agentic-seo-check/issues/39)). The README's [Hosted server](../README.md#hosted-server) section is for its users; this page is for running it. It is not part of the npm package: `hosted/` is outside `files`.

## How it works

Each POST to `/mcp` builds an MCP server with `createMcpServer({ hosted })` (`src/mcp-hosted.ts`) and answers it with the SDK's `WebStandardStreamableHTTPServerTransport`, stateless and in JSON. Wrangler bundles `src/` from the same commit; `playwright`, `lighthouse` and `chrome-launcher` resolve to `src/unavailable.ts`, so the bundle leaves them out.

- `wrangler.jsonc`: the Custom Domains, the rate limits, the Durable Object, the Analytics Engine dataset, the daily Cron Trigger and the variables `MODE`, `DAILY_REQUESTS` and `OPENAI_APPS_CHALLENGE`.
- `src/index.ts`: the routes (`/mcp`, `/`, `/crawler`, `/robots.txt`, `/favicon.svg`, `/.well-known/openai-apps-challenge`), CORS, and the Cron Trigger that fetches OpenAI's ChatGPT connector ranges. `mcp.agentic-seo-check.rivi.software`, the MCP server's hostname in 0.7.0, still answers at `/mcp`, so clients set up with it keep working, and sends every other path to `mcp.agentic-seo.rivi.software` with a 301.
- `src/limits.ts`: the limits per caller, per platform, per site and per day, and one Analytics Engine record per tool call. The URL rules, the caps and the answers that count as a site refusing the server are in the core, `src/core/hosted.ts`, so the npm package's tests cover them too.
- `src/callers.ts`: who is calling. claude.ai and ChatGPT call from their platforms' address ranges and count as one caller each, with ten times the limits.
- `src/state.ts`: the Durable Object that counts the day's requests and keeps OpenAI's ranges.
- `src/pages.ts`: the landing page and the page for site owners, which the User-Agent links to. Both state the limits from `wrangler.jsonc`.
- `src/site/`: the website, which the Worker serves when the request's hostname is `agentic-seo.rivi.software`. `routes.ts` has its routes (`/`, `/rules`, `/audit`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/site.js`, the font) and the Content-Security-Policy; `home.ts` and `rules-page.ts` the pages, in the frame of `layout.ts` and the styles of `style.ts`; `audit.ts` answers the audit form; `report.ts` renders the two audits as HTML, with everything quoted from the audited page escaped; `files.ts` holds robots.txt, the sitemap, llms.txt and the page's script. `assets/` holds the heading font, Bricolage Grotesque at weight 600 as a Latin subset, with its licence (SIL OFL 1.1).
- `scripts/wrangler.ts`: runs Wrangler in this directory with the defines a build needs (`scripts/defines.ts`): the npm package's version and the rate limits.

## Commands

From the repository's root:

```bash
pnpm run hosted:dev      # run it locally in workerd, at http://localhost:8787
pnpm run hosted:check    # generate the Worker's types (worker-configuration.d.ts), then typecheck
pnpm run hosted:build    # bundle it as a deploy does, into hosted/dist
pnpm run hosted:test     # its limits and pages in Node, and the bundle in workerd
pnpm run hosted:deploy   # deploy it (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)
```

`hosted:dev` answers as the MCP server's hostname, since Wrangler gives every local request the hostname of the first route. To see the website, run `pnpm run hosted:dev --host agentic-seo.rivi.software`. `.dev.vars` holds Cloudflare's public Turnstile test keys, which pass every check, so the form works locally.

`pnpm run verify` runs `hosted:check`, `hosted:build` and `hosted:test` after the package's own checks. Run Wrangler through these scripts, not on its own: a bundle without the defines does not start.

## The audit form

`POST /audit` on the website's hostname runs the SEO audit and the AEO audit of one URL and answers with the homepage and the report. It uses no model and stores nothing. Before it requests anything it checks, in this order: that the form came from the site's own page (the `Origin` header), that the address is one the hosted server may request (`hostedUrlProblem`), that Cloudflare Turnstile gave the form's token, and the limits of `src/limits.ts`, where a run counts as one call of its IP address. Its requests go through the hosted gate, as a tool call's do, and it writes the same Analytics Engine record, with `web_audit_page` as the tool. A GET never audits: `/?url=…` fills the field only.

The form is off, and says so, while `TURNSTILE_SITE_KEY` or `TURNSTILE_SECRET_KEY` is missing, and when `MODE` is `closed`.

## Deploys

The release workflow publishes a version to npm, then calls [`deploy-hosted.yml`](../.github/workflows/deploy-hosted.yml), so the server runs the latest release, the only version SECURITY.md supports. That job runs in the GitHub environment `hosted`, which holds the Cloudflare token; the publish job never sees it.

To change a limit or `MODE` before the next release, merge the change to `wrangler.jsonc`, then run **Deploy the hosted server** by hand on `main`. To roll back, run it on an earlier release tag that has `hosted/` (`gh workflow run deploy-hosted.yml --ref v0.7.0`). A run deploys the commit it runs on and refuses any ref but `main` and release tags, so no input can hand the token other code.

`MODE` is `open`, `no-crawls` (crawls are refused, single page audits work) or `closed` (every tool call is refused, with the local server as the way out).

## Setting it up

Once, before the first deploy:

1. **Workers Paid** on the Cloudflare account, for the CPU an audit needs (the Free plan stops a request at 10 ms).
2. **A Cloudflare API token** for deploys: start from the *Edit Cloudflare Workers* template, and limit it to the account and the `rivi.software` zone. Cloudflare cannot limit a token to one Worker; the GitHub environment keeps it from every other job.
3. **The GitHub environment `hosted`**, with the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`. Limit its deployment branches and tags to `main` and `v*`.
4. **The hostnames free:** a Custom Domain cannot be created where `mcp.agentic-seo.rivi.software` or `agentic-seo.rivi.software` already has a CNAME record. The first deploy creates the DNS records and the certificates.
5. **A billing notification** on the account, for usage past what Workers Paid includes.
6. **A privacy notice and terms of use** on rivi.software (#33 needs their URLs too). The landing page states what the server records and for how long; the privacy notice should say the same, and name Cloudflare as processor.

7. **A Turnstile widget** for the audit form, done on 2026-11-10: the widget "agentic-seo-check website audit form" for the hostname `agentic-seo.rivi.software` (its hostnames list it), with the mode *Invisible*. Its site key is `TURNSTILE_SITE_KEY` in `wrangler.jsonc`, and its secret key is the Worker secret `TURNSTILE_SECRET_KEY`, which stays through later deploys. To replace it, rotate the secret in the Cloudflare dashboard (Turnstile) and run `pnpm run hosted:secret TURNSTILE_SECRET_KEY`.

## Answering an abuse report

Every tool call writes one record to the Analytics Engine dataset `agentic_seo_check_calls`, kept for three months: `index1` and `blob3` the hostname audited, `blob1` the tool (`web_audit_page` for a run of the website's form), `blob2` the outcome (`ok`, `refused`, `error`, `limited`), `double1` the duration in ms, `double2` the requests sent and `double3` the pages audited. No path, query or caller address. To see what the server sent a site, with a token that has *Account Analytics: Read*:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  --header "Authorization: Bearer $TOKEN" \
  --data "SELECT timestamp, blob1 AS tool, blob2 AS outcome, double2 AS requests, double3 AS pages
          FROM agentic_seo_check_calls
          WHERE index1 = 'www.example.com' AND timestamp > NOW() - INTERVAL '7' DAY
          ORDER BY timestamp DESC"
```

Reports come in through [help.rivi.software/contact](https://help.rivi.software/contact).
