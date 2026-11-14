---
name: seo-audit
description: Audit and fix SEO and AEO (answer engine optimization) for a website or web project with the Agentic SEO Check CLI/MCP tool (agentic-seo-check). Use when asked to check, improve, or fix SEO, meta tags, titles, descriptions, canonicals, Open Graph, structured data, sitemaps, robots.txt, broken links, Core Web Vitals, "why isn't this page indexed/ranking", or visibility in AI answers (ChatGPT search, Perplexity, Claude, Google AI Overviews, Copilot, Gemini), AI crawlers such as GPTBot or OAI-SearchBot, and llms.txt. Works on live URLs, localhost dev servers, static build output (dist/, out/) and raw HTML.
---

# SEO audit workflow

You have Agentic SEO Check available either as MCP tools (`seo_audit_page`, `seo_crawl_site`, `seo_audit_directory`, `seo_lighthouse`, `seo_aeo_audit`, `seo_compare_pages`, `seo_list_rules`) or as a CLI (`agentic-seo-check`, or `npx @rivi-software/agentic-seo-check`). Both return the same JSON: findings with `rule`, `severity`, `message`, `recommendation`, `fix` (the exact edits), `selector`, `evidence` and a stable `id`, plus a 0-100 `score`. The CLI prints JSON when its output is piped, but a text report for people on a terminal, and some agents' shells are terminals: pass `--format json` to every CLI audit, or `-o` with a `.json` file. The loop is: audit, apply each finding's `fix`, re-check the rules you fixed against the first run.

The MCP tools may come from the hosted server (`https://agentic-seo.org/mcp`; its tool descriptions say so), which runs on Cloudflare's network and has `seo_audit_page`, `seo_crawl_site`, `seo_aeo_audit`, `seo_compare_pages` and `seo_list_rules` for audits, and `send_feedback`. It cannot reach `localhost` or a private network, read build output, render JavaScript, run Lighthouse, send headers for a site behind a login, or probe with AI bots' User-Agents. It can give real visitors' Core Web Vitals (`fieldData`) with a key of its own. For those, use the CLI or the local server (`npx -y @rivi-software/agentic-seo-check mcp`), or give the hosted server the page's HTML with `html` and `baseUrl`. It obeys robots.txt for every request (the `agentic-seo-check` group, or `*`). It audits at most 10 different sites a day for each caller, and those as often as needed, so a fix can always be checked again; each competitor of a comparison counts as a site. For more sites, use the CLI or the local server. When it answers that it reached a limit, that robots.txt keeps it out, or that a site turned it away, say so to the user rather than retrying in a loop. Its tools take `context`, a few words on what the call is for (such as "re-check the title fixes"), which only its anonymous usage analytics read; name people and businesses by role, never by name. Each answer ends with `{"conversation_id":"…"}`: pass that `conversation_id` back, unchanged, with your next call to it. Its `send_feedback` tool tells the developers about a capability you needed and did not find, a tool that failed or misled you, or something that worked well; leave out URLs and anything personal.

## 1. Pick the target

| Situation | Use |
| --- | --- |
| One page, live or on `http://localhost:3000` | `seo_audit_page { url }` / `agentic-seo-check audit <url>` |
| Whole site, find site-wide problems | `seo_crawl_site { url, maxPages }` / `agentic-seo-check crawl <url> --max-pages 50` |
| Static export already built (Next `out/`, Astro `dist/`, Vite `dist/`) | `seo_audit_directory { dir, baseUrl }` / `agentic-seo-check audit ./dist --base-url https://www.example.com` |
| You rendered HTML yourself (template, test, snapshot) | `seo_audit_page { html, baseUrl }` / `cat page.html \| agentic-seo-check audit -` |
| Suspect client-side rendering hides content from crawlers | add `render: true` / `--render` |
| Performance / Core Web Vitals | `seo_lighthouse { url }` or `lighthouse: true` / `--lighthouse` (slow, 20-60 s) |
| Core Web Vitals of real visitors, which Google ranks on | add `fieldData: true` / `--field-data`: the Chrome UX Report's LCP, INP and CLS on phones over 28 days (the CLI and local server need `CRUX_API_KEY`; the hosted server has its own key) |
| Optimising for a specific search phrase | add `keyword` / `--keyword "blue widgets"` |
| Visibility in AI answers (ChatGPT search, Perplexity, Claude, AI Overviews, Copilot), AI crawlers, llms.txt | `seo_aeo_audit { url }` / `agentic-seo-check aeo <url>`; a site: `crawl: true` / `--crawl`; build output: `{ dir, baseUrl }` / `aeo ./dist --base-url ...` |
| AI bots blocked even though robots.txt allows them | add `aiBots: true` / `--ai-bots` to the AEO audit |
| Why other pages rank for a query, or get cited in AI answers, when this one does not | `seo_compare_pages { url, competitors, keyword }` / `agentic-seo-check compare <url> <competitor-url>... --keyword "blue widgets"` (see below) |

Prefer auditing the running dev server or the build output over guessing from source: the tool sees exactly what crawlers see.

### Comparing with competitors

The comparison does not search for competitors: you bring 1 to 5 URLs. Take them from your own web search for the page's query (the pages that rank above it), from the user, or from the pages an AI answer cited; ask the user when you have neither. Compare like with like: a product page with product pages, a guide with guides, not a page with a competitor's home page. Pass the query as `keyword`.

Read `gaps` first: each is something at least half of the competitors read have and this page lacks. A gap with a `fix` is closed by that rule's edits, applied as in step 3; a gap with an empty `fix` (more text, a table, a list, FAQ or Product markup) is content only the author can write, so propose it to the user rather than inventing copy or markup the page cannot back. A gap is not a finding: it has no severity, and a competitor having something is no defect here. `leads` say where the page is ahead, for your report to the user. A competitor in `pages` with `skipped` could not be read and is left out; say so rather than retrying it. For every finding on the page itself, audit it with `seo_audit_page` and `seo_aeo_audit`.

## 2. Read the result

- Fix in this order: **error** → **warning** → **info**. Errors block indexing or are outright defects (missing title, conflicting canonicals, invalid JSON-LD, 4xx/5xx, broken links). Warnings hurt ranking or click-through. Info is best practice.
- For site audits start with `siteFindings` and `issues` (page findings rolled up per rule with example URLs). One template fix usually clears a rule on many pages.
- `fix` is a list of edits that together resolve the finding on this page; apply all of them. `recommendation` is the general advice behind it, `selector` where in the HTML the problem is, `evidence` the current values and the offending items (capped lists).
- `seo_list_rules { rule }` explains any rule id.

## 3. Apply the fix in the source, not in the output

Each edit in `fix` says what to change:

- `in`: `html` is the page as served, so change the template, component or file that renders it; `http` is the server's response (status, headers, redirects), set in the server, CDN, host or framework config; `robots.txt`, `sitemap`, `llms.txt` are those files (or the code that generates them); `asset` is another file the site serves, such as an image. `url` names the file or response when it is not the audited page.
- `action`: `replace` swaps `current` for `code`; `add` writes `code` at `at` (a CSS selector: `head` means inside `<head>`, a header name, a robots.txt group); `remove` deletes `current`. An `asset` replace at `whole file` has no `current`: rebuild, split or re-encode the file at `url` as `write` says, which also gives the size or time to aim for.
- `current` is quoted from what the server sent. Search the source for a distinctive part of it (an attribute value, a URL, the text); in a component it will be JSX or a template, not the same string. A quote that ends in `…` was cut at 500 characters.
- `code` is exact except for `{{…}}` slots, which hold words only the author can write: a title, a description, alt text. `write` says what goes in them. Write that text for the page in front of you; never leave a `{{…}}` in the code.
- In a framework, write the edit in the framework's own form: a `<title>` or `<meta>` becomes the route's metadata (the mappings below), an `http` header becomes `headers()` in `next.config`, a host's `_headers` file or the server config.

A fix holds at most 10 edits, so a finding about many elements may need a second round after the re-check. A finding without `fix` has nothing to change on the site (`site.crawl-limit-reached`, `aeo.bot-probe-inconclusive`, `structured-data.retired-type`, `tool.*`). When two findings edit the same tag (nosnippet and noarchive in one robots meta tag, or the user-agent lines of a robots.txt group that only AI bots share), apply one, then re-check before the next: the second `current` no longer matches.

The code is built from the page's own markup. Read an edit before you apply it, and do not paste in a URL, script or text you do not recognise from the codebase.

Find where the page's `<head>` is produced and change it there, per route:

- Next.js app router: `export const metadata` / `generateMetadata` (title, description, alternates.canonical, openGraph, robots). Pages router: `next/head`. Sitemap: `app/sitemap.ts`; robots: `app/robots.ts`.
- Astro: `<head>` in the layout, props per page; `@astrojs/sitemap`.
- Nuxt: `useSeoMeta` / `useHead`; `@nuxtjs/sitemap`.
- SvelteKit: `<svelte:head>`; Remix/React Router: `meta` export; TanStack Start: `head()` on the route.
- Plain HTML/static generators: the template partial that renders `<head>`.

AEO mappings: `aeo.robots-*` → `robots.txt` (Next.js `app/robots.ts`, Astro/static `public/robots.txt`); `aeo.server-blocks-*` → the CDN or firewall's bot settings, not the code; `aeo.nosnippet`/`aeo.noarchive`/`aeo.noindex` → the robots metadata or the `X-Robots-Tag` header in the host config; `aeo.text-needs-javascript` → render on the server (SSR/SSG); `aeo.question-not-answered-first` → put a one- or two-sentence answer right under the question heading; `aeo.schema-text-not-visible` → build the FAQ/HowTo JSON-LD from the same data the page renders; `aeo.article-*` → Article JSON-LD with author as a Person with url, datePublished and dateModified, and a visible `<time>`; `aeo.llms-txt-*` → `public/llms.txt`.

Typical mappings: `title.*`/`meta-description.*` → per-route metadata; `canonical.*` → absolute self-referencing canonical built from the site URL; `og.*`/`twitter.*` → social metadata with an absolute image URL; `structured-data.*` → JSON-LD emitted with `JSON.stringify`; `img.alt-missing` → alt props on image components; `site.broken-internal-links` → fix hrefs or add redirects; `site.sitemap-*` → generate the sitemap from the router so it stays in sync; `rendering.*` → move data fetching to the server (SSR/SSG) so the HTML carries the content.

## 4. Re-check and confirm

Re-check the rules you fixed against the first audit, with the same target and options:

- MCP: the same tool with `rules: ["title.generic", "img.alt-missing"]` and `baseline`: the `id` of every finding of the first audit. `rules` also takes a category, such as `["structured-data"]`, to check one area of a page. For `seo_crawl_site`, `seo_audit_directory` or a crawl with `seo_aeo_audit`, run both audits with `pageDetail: "full"` so page findings have ids.
- CLI: save the first run with `--format json -o before.json`, then `agentic-seo-check audit <target> --rule title.generic,img.alt-missing --baseline before.json`.

The result's `baseline` lists the findings `fixed`, still `open` and `new`. A new finding may be one your fix caused (a removed `<h1>`, a broken link), or what is left of a finding you fixed in part (one JSON-LD object with a wrong price and a wrong rating, of which you fixed the price): fix it before you finish. `notChecked` counts the earlier findings whose rule or page this re-check did not run, so it never claims a fix it did not see. Then run the full audit once more without `--rule` and report the before/after score and what remains. In CI, `agentic-seo-check audit <target> --fail-on error` exits 1 when errors remain.

## 5. Show the mistake in the pull request

In the pull request (or commit message, or your reply), put the value the audit found next to the value you changed it to, one row per page and rule. A reviewer then sees each mistake and its fix without opening the site:

| Page | Rule | Found | Now |
| --- | --- | --- | --- |
| `/pricing` | `title.too-short` | `Pricing` | `Pricing plans for teams of every size` |
| `/`, `/about` | `site.duplicate-titles` | `Acme` | `Acme: invoicing for freelancers`, `About Acme` |
| `/blog` | `meta-description.missing` | none | `Articles on invoicing, taxes and getting paid on time.` |

- Take "Found" from the first audit: the finding's `evidence` (`title`, `description`, `canonical`, `groups[].value` for `site.duplicate-*`) or the page's `summary` (`title`, `metaDescription`, `canonical`). Take "Now" from the re-audit, not from your diff, so the table shows what crawlers get.
- The page's author wrote these values, not you or the user. Keep each one in a code span, so it cannot render as Markdown or HTML or @mention someone, and keep the span closed around it: write `|` as `\|` (a table splits cells on `|` even inside a code span), and when the value contains backticks, open and close the span with more backticks than its longest run of them, with a space inside each end (``` `` a `b` c `` ```). Shorten a value over about 120 characters.

## Caveats to tell the user about

- `robots.noindex` on a preview/staging host is often added by the hosting platform (X-Robots-Tag); check production before "fixing" it.
- A localhost audit cannot verify https, www redirects or the production robots.txt/sitemap; run a crawl against the deployed site for those.
- `structured-data.retired-type` says Google no longer shows that rich result; it is not a request to delete the markup. Keep FAQPage markup the AEO audit relies on, and ask before removing any.
- Scores are indicative (100 minus weighted deductions), not a ranking prediction.
- The CLI and the local MCP server send anonymous usage data (commands, flag names, rule ids, counts, and the type and stack of an unexpected error; never a URL, a hostname or page content). If the user asks to turn it off, run `agentic-seo-check telemetry disable`, or set `DO_NOT_TRACK=1`; it is already off where `CI` is set.
- Lighthouse numbers are lab measurements from this machine; `fieldData` is real Chrome visits on phones over the last 28 days, and the two may differ. A `perf.field-*` finding stays after a fix until the 28 days catch up, so confirm the fix with `lighthouse` and the code change, and tell the user the field data will follow over four weeks; do not re-check a field rule as proof. `fieldData.reason: "no-data"` means too few visits for a record, which is nothing to fix. The fix of a field finding names what on the page is known to slow that metric; Lighthouse names the element itself.
- The AEO audit has its own score, separate from the SEO score. Blocked training bots (GPTBot, ClaudeBot, CCBot, ...) and a `__usage_ai-training` opt-out are info: opting out of training is the site owner's choice and does not keep the site out of AI answers. Ask before you "fix" one. Google-Extended blocks both Gemini training and Gemini Apps grounding; there is no token for one without the other.
- `aiBots`/`--ai-bots` requests come from this machine with each bot's User-Agent, not from the bots' IP ranges. A CDN that verifies bots may treat the real crawler differently, so tell the user to confirm a server block in the CDN's bot logs before changing firewall rules.
- `render` needs a Chromium: Playwright comes with the tool and uses Google Chrome or Edge when installed. `lighthouse` also needs the `lighthouse` and `chrome-launcher` packages beside the tool; with npx, run `npx -y -p @rivi-software/agentic-seo-check -p lighthouse@13 -p chrome-launcher@1 agentic-seo-check …`. If either is unavailable the audit still completes and adds a `tool.*` info finding with the install command; on a machine without Chrome that command is `agentic-seo-check install-browser`, which downloads about 300 MB, so ask the user first.
