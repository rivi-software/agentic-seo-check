<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/agentic-seo-check/main/assets/rivi-agentic-seo-check-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/agentic-seo-check/main/assets/rivi-agentic-seo-check.svg" alt="RIVI Agentic SEO Check" width="553">
    </picture>
  </a>
</p>

<p align="center">
  SEO and AEO analysis built for coding agents: a CLI and an MCP server that audit URLs,<br>
  static build output or raw HTML, and return findings an agent can act on.<br>
  Open source, from <a href="https://rivi.software">RIVI Software</a>.<br>
  <a href="https://agentic-seo.rivi.software">agentic-seo.rivi.software</a>: audit a page or a whole site in your browser, and read every rule.
</p>

<p align="center">
  <a href="https://github.com/rivi-software/agentic-seo-check/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rivi-software/agentic-seo-check/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@rivi-software/agentic-seo-check"><img src="https://img.shields.io/npm/v/@rivi-software/agentic-seo-check?color=0b6b3a" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@rivi-software/agentic-seo-check"><img src="https://img.shields.io/npm/dm/@rivi-software/agentic-seo-check?color=0b6b3a" alt="Monthly npm downloads"></a>
  <a href="https://github.com/rivi-software/agentic-seo-check/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-0b6b3a" alt="MIT License"></a>
  <a href="https://claude.ai/directory/agentic-seo-check"><img src="https://img.shields.io/badge/Claude_Directory-listed-0b6b3a" alt="Listed in the Claude Directory"></a>
</p>

<p align="center">
  <a href="#install">Install</a>
  ·
  <a href="#cli">CLI</a>
  ·
  <a href="#hosted-server">Hosted server</a>
  ·
  <a href="#mcp-server">MCP server</a>
  ·
  <a href="#agent-skill">Agent skill</a>
  ·
  <a href="https://github.com/rivi-software/agentic-seo-check/blob/main/CONTRIBUTING.md">Contributing</a>
  ·
  <a href="https://rivi.software">rivi.software</a>
</p>

<br>

Agentic SEO Check is one core with two interfaces:

- **CLI** `agentic-seo-check` with JSON (default when piped) or Markdown output and CI-friendly exit codes.
- **MCP server** exposing six tools for Claude Code, Cursor, Codex and any other MCP client. A [hosted server](#hosted-server) serves four of them at `https://mcp.agentic-seo.rivi.software/mcp`, free and without an install, for claude.ai, ChatGPT and any client that connects over HTTP. It is listed in the [Claude Directory](https://claude.ai/directory/agentic-seo-check).

It audits **URLs** (production, staging, `localhost` dev servers), **static build output** (`dist/`, `out/`, `build/`) and **raw HTML**, and returns findings an agent can act on: a stable rule id, severity, what is wrong, the fix, a CSS selector for where it lives, and evidence with the current values. Each finding carries the exact edits that fix it, quoting the code to replace, and an id, so an agent can re-check only the rules it fixed and see which findings are gone, still open or new.

Two audits share that core: the **SEO audit** (`audit`, `crawl`) for search engines, and the **AEO audit** (`aeo`, answer engine optimization) for AI answer engines such as ChatGPT search, Claude, Perplexity, Google AI Overviews and AI Mode, Copilot and Gemini. Each has its own rules and its own score, so adding one never changes the other.

## What it checks

### SEO audit

| Area | Examples (165 rules, `agentic-seo-check rules` lists them) |
| --- | --- |
| On-page basics | title missing/long/short/placeholder ("React App"), meta description, H1 and heading outline, canonical (missing, conflicting, relative, pointing elsewhere), robots meta and `X-Robots-Tag`, `lang`, viewport, charset, doctype |
| Head and indexing | an element that ends `<head>` early (a pixel `<img>`, an `<iframe>`, stray text) so Google ignores the metadata after it, canonical, description or hreflang in `<body>`, meta refresh redirects, a charset declared past the first 1024 bytes, contradicting (`index` and `noindex`) or misspelled (`no-index`) robots directives, an HTTP `Link` canonical that disagrees with the HTML one |
| Social | Open Graph completeness, absolute `og:image`, `og:url` vs canonical, Twitter card |
| Images and links | alt text, filename-style alt, missing dimensions (CLS), empty or generic anchor text, `href="#"`/`javascript:` anchors, http links on https pages, internal nofollow |
| URLs | uppercase letters or underscores in the page's path (locale segments such as `en-US` aside), session ids in the URL or internal links, campaign parameters (`utm_*`, `gclid`) on internal links, canonical, `og:image`, images or scripts on `localhost` or a private address, same-page `#links` to ids the page lacks, mixed content (blocked scripts, stylesheets and frames apart from images browsers upgrade) |
| International | hreflang syntax, absolute URLs, self reference, x-default, return links (crawl) |
| Structured data | JSON-LD parse errors, `@context`/`@type`, required and recommended properties for Article, Product, Offer, Organization, WebSite, BreadcrumbList, LocalBusiness, Event, Recipe, VideoObject, JobPosting, QAPage, Review, SoftwareApplication and more, ISO 8601 dates; values Google cannot use (a price with a currency symbol or decimal comma, a currency that is not ISO 4217, a rating outside its scale, breadcrumb positions and crumbs without a URL); relative URLs; `@id` references the page does not define; markup for rich results Google retired (FAQPage, HowTo, SpecialAnnouncement, ClaimReview, the sitelinks search box); microdata too |
| Content | empty or thin content, "lorem ipsum", readability, keyword presence in title/H1/body/description/URL and density |
| Response | 4xx/5xx, redirects and chains, slow HTML response, non-HTML content type, http instead of https, a page larger than the audit reads (5 MB) |
| Loading (no browser needed) | HTML sent without gzip or Brotli, scripts in `<head>` without `async`/`defer`, `loading="lazy"` on the first large image (or with `fetchpriority="high"`), wide images without `srcset`, a home page without an icon link for Google's search results |
| Site-level (crawl or directory) | robots.txt (missing, blocking, disallowed pages, over 500 KiB, `noindex:` and `crawl-delay` lines Google ignores, CSS and JavaScript kept from Googlebot), sitemap (missing, invalid, noindex/non-canonical/broken/redirecting URLs, pages not in sitemap, orphan pages, over 50,000 URLs or 50 MB, an index inside an index, `lastmod` that is not W3C Datetime or lies in the future, URLs on another host; gzip sitemaps are read), broken internal links and images with their sources, redirected links and chains, duplicate titles/descriptions/H1s/content among canonical pages (language versions that name each other in hreflang may share a title, description or H1, not untranslated text), URLs that answer under a second spelling (`/page` and `/page/`, or another case) or a query string that changes nothing, deep pages, soft 404, http→https and www redirects, hreflang return links; canonicals that point to a broken, redirecting or noindex URL or to a page that names another canonical, hreflang alternates that are broken, redirect, noindex or not canonical, noindex pages the site links to |
| Rendering (`--render`, Playwright) | title/description/canonical/H1/content/links/structured data that only exist after JavaScript runs; noindex injected or removed by JavaScript; console errors |
| Performance (`--lighthouse`, Chrome) | LCP, CLS, TBT, FCP, Speed Index, TTFB with Core Web Vitals thresholds, Lighthouse opportunities with estimated savings, failed Lighthouse SEO and agentic-browsing audits |

### AEO audit

| Area | Examples (32 rules, `agentic-seo-check rules --category aeo` lists them) |
| --- | --- |
| AI crawler access | robots.txt checked per bot: search crawlers whose index AI answers draw on (Googlebot, Bingbot, Applebot; blocked is an error), answer bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, DuckAssistBot, MistralAI-User; a warning) and training bots (GPTBot, ClaudeBot, Applebot-Extended, CCBot, meta-externalagent; info, since opting out of training is a legitimate choice). Also an unreachable robots.txt, `Content-Signal` lines (`ai-input=no`, invalid values), the shared training opt-out `User-Agent: __usage_ai-training`, and `/llms.txt` (missing, no H1 title, no links) |
| Server blocks (`--ai-bots`) | requests the page with each AI bot's User-Agent and reports 403s, 429s and challenge pages that a CDN or firewall serves while robots.txt allows the bot |
| Snippet and AI opt-outs | noindex, `nosnippet` and `max-snippet` (Google AI Overviews and AI Mode), `noarchive` and `nocache` (Bing's controls for Copilot), `noai`/`noimageai`, `data-nosnippet` over a large share of the text; meta tags per crawler and scoped `X-Robots-Tag` values |
| Answer-ready content | an empty JavaScript app shell (most AI crawlers do not run JavaScript), question headings without a short direct answer, long text without subheadings, lists or tables, FAQPage/QAPage/HowTo markup whose questions, answers or steps the page does not show |
| Entity and freshness | article author missing or a bare name without url/sameAs, missing datePublished/dateModified, a structured-data date the page does not show, a home page without Organization or Person markup, entities without sameAs links |

## Install

Requires Node 22.19 or newer. Published on npm as [`@rivi-software/agentic-seo-check`](https://www.npmjs.com/package/@rivi-software/agentic-seo-check); the commands it installs are `agentic-seo-check` and `agentic-seo-check-mcp`.

```bash
npx @rivi-software/agentic-seo-check audit https://example.com   # no install
npm install -g @rivi-software/agentic-seo-check                  # or pnpm add -D / npm i -D in a project
agentic-seo-check --help
```

`--render` needs nothing extra on a machine with Google Chrome or Edge: Playwright installs with the tool as an optional dependency (left out by `--omit=optional`), and the renderer launches a Playwright-managed Chromium when present, else the installed Chrome or Edge. Without either, download the Chromium build the bundled Playwright expects (about 300 MB, into Playwright's shared browser cache):

```bash
npx @rivi-software/agentic-seo-check install-browser   # or: agentic-seo-check install-browser [--with-deps]
```

`--lighthouse` also needs Lighthouse, an optional peer kept out of the install because it adds some 180 MB. Install it next to the tool:

```bash
npm i -D lighthouse@13 chrome-launcher@1                                              # in a project
npm i -g @rivi-software/agentic-seo-check lighthouse@13 chrome-launcher@1             # global
npx -y -p @rivi-software/agentic-seo-check -p lighthouse@13 -p chrome-launcher@1 \
  agentic-seo-check audit https://example.com --lighthouse                           # npx
```

Lighthouse runs in Google Chrome, or in the Chromium `install-browser` downloads.

From source: `pnpm install && pnpm build && node dist/cli.js --help`.

## CLI

```bash
# one page (Markdown on a terminal, JSON when piped or with --format json)
agentic-seo-check audit https://www.example.com/pricing

# whole site
agentic-seo-check crawl https://www.example.com --max-pages 100 --max-depth 4

# local dev server, ignore the dev robots.txt, include JS rendering comparison
agentic-seo-check audit http://localhost:3000 --crawl --ignore-robots --render

# static export, with the production origin for canonical/sitemap comparison
agentic-seo-check audit ./out --base-url https://www.example.com

# raw HTML from stdin
cat page.html | agentic-seo-check audit - --base-url https://www.example.com/page

# keyword focus, Lighthouse, Markdown report to a file
agentic-seo-check audit https://www.example.com/widgets --keyword "blue widgets" --lighthouse -o report.md

# fix, then re-check only the rules you fixed, compared with the first run
agentic-seo-check audit ./out --base-url https://www.example.com --format json -o before.json
agentic-seo-check audit ./out --base-url https://www.example.com --rule title.generic,img.alt-missing --baseline before.json

# CI: exit 1 when errors exist, smaller output
agentic-seo-check audit https://staging.example.com --crawl --fail-on error --compact --no-info

# AEO: AI crawler access, opt-outs and answer-ready content, with its own score
agentic-seo-check aeo https://www.example.com/guide
agentic-seo-check aeo https://www.example.com --crawl --max-pages 50
agentic-seo-check aeo https://www.example.com --ai-bots          # also catch CDN/firewall blocks
agentic-seo-check aeo ./dist --base-url https://www.example.com  # reads dist/robots.txt and dist/llms.txt

# rule reference
agentic-seo-check rules --category structured-data
agentic-seo-check rules --category aeo
agentic-seo-check rules --rule canonical.multiple

# the Chromium for --render and --lighthouse, where there is no Google Chrome
agentic-seo-check install-browser

# anonymous usage data: whether it is on, and turning it off
agentic-seo-check telemetry
agentic-seo-check telemetry disable
```

`aeo` takes the same targets and output, crawl and request options as `audit`, plus `--ai-bots`; it has no `--keyword`, `--render`, `--lighthouse` or `--check-external`. With `--ai-bots`, the requests come from your machine with each bot's User-Agent, not from the bots' own IP ranges: a CDN that verifies bots may treat the real crawler differently, and the findings say so. Search crawlers and robots.txt-only tokens (Google-Extended, Applebot-Extended) are never impersonated.

`--rule` runs only the rules named (space- or comma-separated). `--baseline` reads an earlier audit's JSON and adds `baseline` to the result: the findings since fixed, still open and new. Re-check with the same target and options as the first run; a finding counts as fixed only when its rule ran again on its page, and the rest are counted as `notChecked`. A crawl or directory baseline needs `--page-detail full` (the CLI default), so its page findings have ids.

Requests from the CLI and the local server carry the User-Agent `Mozilla/5.0 (compatible; agentic-seo-check-local/<version>; +https://github.com/rivi-software/agentic-seo-check)` unless `--user-agent` (`userAgent`) sets another. A crawl obeys robots.txt for the product token `agentic-seo-check-local`, or `*` when robots.txt has no group for it, unless `--ignore-robots` (`respectRobots: false`). The hosted server's token is `agentic-seo-check`, so a site can tell the two apart.

Exit codes: `0` success, `1` findings at or above `--fail-on`, `2` usage or runtime error. Progress goes to stderr, the report to stdout.

## Hosted server

RIVI Software runs the MCP server on Cloudflare, free to use, with no account and no key:

```text
https://mcp.agentic-seo.rivi.software/mcp
```

It speaks MCP over Streamable HTTP, so it works where a local server cannot run: claude.ai, Cowork and the Claude apps, ChatGPT, and any machine without Node.

The same server is behind the form on [agentic-seo.rivi.software](https://agentic-seo.rivi.software): enter a URL and it shows the SEO and AEO audits of that page, with no assistant and no model in between. Enter a site's homepage, a URL with no path and no query, and it crawls the site as `seo_crawl_site` does, within the same caps, and shows both audits of the site: the findings across the site, the findings on the pages grouped by rule, the homepage's own findings with their edits, and every page's scores. Each run counts as a tool call in the limits below, and a crawl as one of the crawls. A report's Share button posts its scores to X, LinkedIn or Bluesky with a link to a page of its own, whose card shows the hostname and both scores: the link holds the scores, signed, so the site still keeps no report. [The site's rules page](https://agentic-seo.rivi.software/rules) lists every rule.

| Client | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http agentic-seo-check https://mcp.agentic-seo.rivi.software/mcp` |
| claude.ai, Cowork, the Claude apps | Connect it from [its listing in the Claude Directory](https://claude.ai/directory/agentic-seo-check), or in Settings, Connectors, add a custom connector with the URL above; no sign-in either way |
| ChatGPT | a custom app (connector) with the URL above and no authentication, which needs developer mode (Settings, Apps, Advanced settings) |
| Cursor | `{ "mcpServers": { "agentic-seo-check": { "url": "https://mcp.agentic-seo.rivi.software/mcp" } } }` in `.cursor/mcp.json` |
| VS Code | `{ "servers": { "agentic-seo-check": { "type": "http", "url": "https://mcp.agentic-seo.rivi.software/mcp" } } }` in `.vscode/mcp.json` |

It has `seo_audit_page`, `seo_crawl_site`, `seo_aeo_audit` and `seo_list_rules`, with the same names and options as the local server's, less what needs your machine. Its requests come from Cloudflare's network, so it cannot reach `localhost`, private networks or IP addresses, read a build directory (`seo_audit_directory`, `dir`), render JavaScript (`render`) or run Lighthouse (`lighthouse`, `seo_lighthouse`), send your headers or User-Agent to a site behind a login, or probe with AI bots' User-Agents (`aiBots`). For all of these, run the [local server](#mcp-server).

Every request it sends obeys robots.txt, an audit of one page included: the group for `agentic-seo-check`, or `*` when there is none. A crawl waits between requests to a site as its `Crawl-delay` asks, for 30 seconds at most in all. Each https request is signed with [Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/), so a site can tell it from others that send its User-Agent. When robots.txt keeps the server out, or a site turns it away (a challenge page, a 403 or a 429), the server says so and leaves it at that, rather than reporting the refusal as the page.

It is free for everyone, so it keeps each site and each caller to a fair share:

| What | Limit |
| --- | --- |
| Requests to one site, from every caller together | 300 a minute |
| Tool calls from one IP address (`seo_list_rules` not counted) | 30 a minute, 3 of them crawls |
| Tool calls from claude.ai or ChatGPT, each platform one caller | 300 a minute, 30 of them crawls |
| Requests to all sites together | 100,000 a day; past that, audits that request a site wait for 00:00 UTC |
| A crawl | 25 pages, 3 links deep, 4 requests at a time, 50 link checks, 10 sitemaps of up to 5 MB |
| A page | its first 2 MB (`response.truncated` says when a page was larger), within 15 seconds; inline `html` up to 2,000,000 characters |

A call past a limit gets an error that names the limit, says when to try again and points to the local server, which has no limits. A crawl that reaches a limit, that a site starts refusing, or whose `Crawl-delay` adds up to more than 30 seconds stops early with `site.crawl-stopped` (`aeo.crawl-stopped`) and leaves what it did not request unchecked, never broken.

The server keeps no HTML you send, no reports and no headers. It records each tool call: the tool, the outcome, the duration, the number of requests and pages, and the hostname audited (never the path, the query or your address), for three months, so a report about requests to a site can be checked against what the server sent. For usage analytics, each tool call also goes to PostHog, in the EU, as one event: the tool, whether it failed and how, the duration, the number of requests and pages, the MCP client, and whether the call came from claude.ai's or ChatGPT's addresses; never the hostname, the arguments, the answer or your address. An error that may be a bug of the server's goes to PostHog as well, cleaned as [the CLI's](#telemetry) are. The website counts visits and a short list of actions with PostHog too, without a cookie unless you accept one in its banner. [The server's page](https://mcp.agentic-seo.rivi.software/) has the setup, the limits and the privacy notice; [the page for site owners](https://mcp.agentic-seo.rivi.software/crawler), which its User-Agent links to, says how to recognise and block its requests. Report abuse of the hosted server, such as too many requests to one site, through [help.rivi.software/contact](https://help.rivi.software/contact); report a vulnerability as [SECURITY.md](SECURITY.md) says.

The Worker is in [`hosted/`](hosted/) and deploys with each npm release, so it runs the latest version.

## MCP server

Add to a project `.mcp.json` (Claude Code reads it automatically):

```json
{
  "mcpServers": {
    "agentic-seo-check": {
      "command": "npx",
      "args": ["-y", "@rivi-software/agentic-seo-check", "mcp"]
    }
  }
}
```

Or `claude mcp add agentic-seo-check -- npx -y @rivi-software/agentic-seo-check mcp`. For `lighthouse`/`seo_lighthouse`, start the server with Lighthouse beside it: `"args": ["-y", "-p", "@rivi-software/agentic-seo-check", "-p", "lighthouse@13", "-p", "chrome-launcher@1", "agentic-seo-check", "mcp"]`. From a source checkout, use `node /absolute/path/to/agentic-seo-check/dist/mcp-bin.js` instead (this repo's own `.mcp.json` does that).

| Tool | Purpose |
| --- | --- |
| `seo_audit_page` | Audit one URL or an HTML string. Options: `keyword`, `render`, `lighthouse`, `formFactor`, `includeInfo`, `disableRules`, `rules`, `baseline`, `headers`, `format` (json/markdown), `detail` (compact/full). |
| `seo_crawl_site` | Crawl and audit a site. Options: `maxPages`, `maxDepth`, `concurrency`, `delayMs`, `respectRobots`, `includeSubdomains`, `checkExternalLinks`, `includePatterns`, `excludePatterns`, `pageDetail`. |
| `seo_audit_directory` | Audit built HTML files in a directory. Options: `dir`, `baseUrl`, `maxPages`, `pageDetail`. |
| `seo_lighthouse` | Lighthouse performance + SEO + agentic-browsing for one URL. |
| `seo_aeo_audit` | AEO audit of one of `url` (with `crawl` for a site), `html` or `dir`. Options: `aiBots`, `baseUrl`, `maxPages`, `maxDepth`, `concurrency`, `respectRobots`, `includeSubdomains`, `pageDetail`, `includeInfo`, `disableRules`, `rules`, `baseline`, `headers`, `format`, `detail`. |
| `seo_list_rules` | Rule reference, filter by `category` or `rule`. |

Every audit tool also takes `rules` (run only these rule ids) and `baseline` (the `id` of each finding of the earlier audit) for a re-check, like `--rule` and `--baseline`. For a crawl or directory, run both audits with `pageDetail: "full"` so page findings have ids.

All tools are read-only. Results are returned both as text (JSON or Markdown) and as `structuredContent`.

## Agent skill

`skills/seo-audit/SKILL.md` teaches an agent the loop of audit, apply each finding's `fix`, then re-check the rules it fixed against the first run, how to map rule ids to framework code (Next.js, Astro, Nuxt, SvelteKit, Remix, TanStack Start), and the caveats (preview-host noindex, localhost limits). It also has the agent put the title, description or canonical the audit found next to the fixed one in its pull request, so a reviewer sees each mistake without opening the site. Copy it to `.claude/skills/seo-audit/` in a project or `~/.claude/skills/` to make it available; this repo links it under `.claude/skills/`.

## Telemetry

The CLI and the local MCP server send anonymous usage data to RIVI Software, in PostHog's EU cloud, so we can see which commands, flags and rules are used and where calls fail ([issue #57](https://github.com/rivi-software/agentic-seo-check/issues/57)). The first run says so on stderr.

- **The CLI** sends one `cli_command` event for each run of `audit`, `crawl`, `aeo` and `rules`: the command, the names of the flags you gave (never their values), the kind of target (`url`, `localhost`, `directory`, `file` or `stdin`), the exit code, the duration, the number of pages, the findings per severity, the ids of the rules that fired, the version, Node's major version and the OS. It waits a second at most for the event to go, after the report is written.
- **The local MCP server** sends one `$mcp_tool_call` event per tool call (the tool, whether it failed and the kind of failure, the duration, the MCP client and its version) and one `$mcp_initialize` per connection, in the shape [PostHog's MCP Analytics](https://posthog.com/docs/mcp-analytics) reads.
- **Errors** ([issue #60](https://github.com/rivi-software/agentic-seo-check/issues/60)): both send one `$exception` event, in the shape [PostHog's error tracking](https://posthog.com/docs/error-tracking) reads, for each error that may be a bug: one that ends a run or fails a tool call, one in `--render`'s or `--lighthouse`'s own code, and one nothing caught. The event has the error's type (`TypeError`), its message with every URL, path, quoted text, hostname, email and IP address replaced (`fetch failed for <url>`), and its stack, with each file named by its place in the package (`dist/core/audit.js`) or in `node_modules`, never the directories above it. It shares the run's or the session's id. A failure the tool expects and explains is not sent: a refused request, a missing browser or Lighthouse, an argument it cannot use, a timeout.
- **Never sent:** a URL, a hostname, a path, a header, the HTML, the arguments of a tool call, anything from a page or a report but the counts, an error's message as it was, or an id that lasts. Each CLI run gets a new id, and the server's lasts one session. No event asks PostHog for a location or a person profile, and the project discards IP addresses.

Turn it off with any of these:

```bash
agentic-seo-check telemetry disable   # kept in ~/.config/agentic-seo-check/telemetry.json (%APPDATA% on Windows)
DO_NOT_TRACK=1                        # for one run, or in your shell's profile
AGENTIC_SEO_CHECK_TELEMETRY=0
```

It is off wherever `CI` is set. `agentic-seo-check telemetry` says whether it is on and why, and `telemetry enable` turns it back on. The library sends nothing. The hosted server and the website have analytics of their own, described under [Hosted server](#hosted-server).

## Output shape

```jsonc
{
  "schemaVersion": 1,
  "kind": "page",                    // or "site"
  "url": "https://www.example.com/",
  "score": 67,                       // 100 - 15/error - 5/warning - 1/info, floored at 0
  "counts": { "error": 0, "warning": 6, "info": 3 },
  "summary": { "title": "…", "metaDescription": null, "canonical": null, "indexable": true, "h1": [], "wordCount": 25, "...": "…" },
  "findings": [
    {
      "rule": "meta-description.missing",
      "severity": "warning",
      "category": "meta",
      "message": "Page has no meta description.",
      "recommendation": "Add a unique meta description (about 70-160 characters) …",
      "fix": [                       // the exact edits that resolve this finding here; apply all of them
        {
          "in": "html",              // html, http (status, headers, redirects), robots.txt, sitemap, llms.txt or asset
          "action": "add",           // add `code` at `at`; replace swaps `current` for `code`; remove deletes `current`
          "at": "head",
          "code": "<meta name=\"description\" content=\"{{page description}}\">",
          "write": "A summary of this page in 70-160 characters …"   // what goes in the {{…}} slot
        }
      ],
      "selector": "head > meta[name=\"description\"]",
      "docs": "https://developers.google.com/search/docs/appearance/snippet",
      "url": "https://www.example.com/",
      "id": "meta-description.missing@1f2e3d4c"   // stable across audits of this page
    }
  ],
  "response": { "status": 200, "finalUrl": "…", "redirectChain": [], "timeMs": 142, "headers": { "content-type": "text/html" } },
  "performance": { "metrics": { "performanceScore": 99, "lcpMs": 848, "cls": 0, "...": "…" }, "opportunities": [] },   // with --lighthouse
  "rendering": { "raw": { "wordCount": 25 }, "rendered": { "wordCount": 137 }, "...": "…" }                         // with --render
}
```

A fix's `current` is quoted from the HTML the server sent, so an agent can find it in the template that renders it; a quote cut short at 500 characters ends in `…`. Text in `{{` `}}` is a slot for words only the author can write, such as a title or alt text; everything else in `code` is exact. An `asset` replace at `whole file` (a script to split, an image to re-encode) has no `current`, a slot for `code`, and the measurement and target in `write`. The code is built from the page's own markup, so review an edit like any other change before you commit it.

A fix holds at most 10 edits; a finding about more elements (23 skipped heading levels, 40 images without alt text) lists the first 10, and a re-check shows what is left. A few findings have no fix because there is nothing on the site to change: `site.crawl-limit-reached` and `aeo.bot-probe-inconclusive` describe the audit, `structured-data.retired-type` says Google stopped showing a rich result whose markup answer engines still read, and `tool.*` findings are about this machine.

With `baseline`, the result has `"baseline": { "fixed": [{ "id", "rule", "url", "message" }], "open": [ids], "new": [ids], "notChecked": 3 }` just before the findings. A new id is a problem the earlier audit did not have in that form: one a fix caused, or what is left of a finding fixed in part (a JSON-LD object's other wrong value). An earlier finding counts as fixed only when this audit ran its rule on its page and does not report it, also not as an info finding that `--no-info` hides; a finding whose id is numbered (`~1`, for findings a rule cannot tell apart) is never called fixed, and one the earlier audit had under another number is open, not new.

Site audits add `crawl` stats, `robotsTxt`, `sitemaps`, `siteFindings`, `issues` (page findings rolled up per rule with example URLs) and `pages`.

An AEO audit has `kind: "aeo"` and its own score:

```jsonc
{
  "schemaVersion": 1,
  "kind": "aeo",
  "target": "https://www.example.com/guide",
  "url": "https://www.example.com/guide",
  "source": "url",                   // or "crawl", "directory", "file", "html"
  "score": 89,                       // average page score minus weighted site-wide findings
  "counts": { "error": 0, "warning": 2, "info": 1 },
  "summary": {
    "pages": 1, "robotsTxt": "found", "llmsTxt": "missing",
    "searchCrawlersBlocked": [], "answerBotsBlocked": ["Google-Extended"], "trainingBotsBlocked": ["GPTBot"],
    "trainingPreference": "none",     // the __usage_ai-training group: "allowed", "disallowed" or "none"
    "blockedByServer": null,          // with --ai-bots: the bots the server refused
    "page": { "indexable": true, "googleSnippets": "allowed", "copilotAnswers": "allowed", "questions": 4, "...": "…" }
  },
  "findings": [ { "rule": "aeo.robots-blocks-answer-bot", "severity": "warning", "...": "…" } ],
  "crawlers": { "robotsTxt": "https://www.example.com/robots.txt", "status": "found", "contentSignals": [], "bots": [
    { "name": "OAI-SearchBot", "operator": "OpenAI", "purpose": "answer", "usedFor": "ChatGPT search results", "robotsGroup": "wildcard", "allowed": true, "blockedPages": 0 }
  ] },
  "llmsTxt": { "url": "https://www.example.com/llms.txt", "status": "missing", "...": "…" }
}
```

A crawl or directory adds `pages` (each page's score and summary) and `issues`. `findings` holds the site-wide findings plus every page finding, except for a site audited with `pageDetail: "summary"` (the MCP default), where page findings are only rolled up in `issues`.

## Library

```ts
import { auditUrl, auditSite, auditAeoUrl, renderMarkdown, renderAeoMarkdown } from '@rivi-software/agentic-seo-check';

const page = await auditUrl('https://www.example.com/', { keyword: 'example', render: true });
const site = await auditSite('https://www.example.com/', { maxPages: 100 });
console.log(renderMarkdown(site));

const aeo = await auditAeoUrl('https://www.example.com/guide', { aiBots: true });
console.log(renderAeoMarkdown(aeo));
```

## Scope of this first version

- Crawls are breadth-first, same-site, HTML only, and obey robots.txt by default. `--render`/`--lighthouse` apply to the start page only during a crawl.
- Scores are indicative. Thresholds (title 30-60 chars, description 70-160, thin content 300 words, slow response 2 s, deep page depth 3) are configurable through the library `thresholds` option.
- The AEO audit reads what answer engines document: robots.txt tokens, Content-Signal, snippet controls, structured data. Whether an engine cites a page also depends on things no audit can see from outside (its index, its ranking, the question asked), so the AEO score says how ready a site is, not how often it is cited. llms.txt is reported at info level: no major answer engine has said it reads one.
- Sitemaps are read up to 15 MB each (uncompressed), and at most 25 of them; a larger one is reported, not checked. A page is read up to 5 MB. The hosted server reads less: 2 MB of a page, 10 sitemaps of 5 MB.
- Not included yet: rendering every page in a crawl, field (CrUX) data, rank tracking, backlink data, AI-generated copy suggestions, tracking of citations in AI answers.

## Contributing

Bug reports, wrong findings, new rules and fixes are welcome from anyone. With Node 24 and pnpm 12:

```bash
pnpm install
pnpm run verify
```

`verify` runs what CI runs: format, lint, typecheck, tests, build, a check of the packed package, and the hosted server's typecheck, bundle and tests in workerd. `pnpm run dev audit https://example.com` runs the CLI from source. [CONTRIBUTING.md](https://github.com/rivi-software/agentic-seo-check/blob/main/CONTRIBUTING.md) covers proposing a change, what a pull request needs and how releases reach npm, and [AGENTS.md](https://github.com/rivi-software/agentic-seo-check/blob/main/AGENTS.md) is the brief for coding agents working on the tool itself. Everyone who takes part follows the [code of conduct](https://github.com/rivi-software/agentic-seo-check/blob/main/CODE_OF_CONDUCT.md). [SECURITY.md](https://github.com/rivi-software/agentic-seo-check/blob/main/SECURITY.md) says how to report a vulnerability privately.

## License

Licensed under the [MIT License](https://github.com/rivi-software/agentic-seo-check/blob/main/LICENSE). Copyright © 2026 RIVI Software.

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/agentic-seo-check/main/assets/rivi-mark-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/agentic-seo-check/main/assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>RIVI Agentic SEO Check is made by <a href="https://rivi.software">RIVI Software</a>, which builds software for radio stations. Created in <a href="https://t3.codes">T3 Code</a>.</sub>
</p>
