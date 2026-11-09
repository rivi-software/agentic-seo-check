---
name: seo-audit
description: Audit and fix SEO and AEO (answer engine optimization) for a website or web project with the agentic-seo-check CLI/MCP tool. Use when asked to check, improve, or fix SEO, meta tags, titles, descriptions, canonicals, Open Graph, structured data, sitemaps, robots.txt, broken links, Core Web Vitals, "why isn't this page indexed/ranking", or visibility in AI answers (ChatGPT search, Perplexity, Claude, Google AI Overviews, Copilot, Gemini), AI crawlers such as GPTBot or OAI-SearchBot, and llms.txt. Works on live URLs, localhost dev servers, static build output (dist/, out/) and raw HTML.
---

# SEO audit workflow

You have `agentic-seo-check` available either as MCP tools (`seo_audit_page`, `seo_crawl_site`, `seo_audit_directory`, `seo_lighthouse`, `seo_aeo_audit`, `seo_list_rules`) or as a CLI (`agentic-seo-check`, or `npx @rivi-software/agentic-seo-check`). Both return the same JSON: findings with `rule`, `severity`, `message`, `recommendation`, `selector`, `evidence`, plus a 0-100 `score`.

## 1. Pick the target

| Situation | Use |
| --- | --- |
| One page, live or on `http://localhost:3000` | `seo_audit_page { url }` / `agentic-seo-check audit <url>` |
| Whole site, find site-wide problems | `seo_crawl_site { url, maxPages }` / `agentic-seo-check crawl <url> --max-pages 50` |
| Static export already built (Next `out/`, Astro `dist/`, Vite `dist/`) | `seo_audit_directory { dir, baseUrl }` / `agentic-seo-check audit ./dist --base-url https://www.example.com` |
| You rendered HTML yourself (template, test, snapshot) | `seo_audit_page { html, baseUrl }` / `cat page.html \| agentic-seo-check audit -` |
| Suspect client-side rendering hides content from crawlers | add `render: true` / `--render` |
| Performance / Core Web Vitals | `seo_lighthouse { url }` or `lighthouse: true` / `--lighthouse` (slow, 20-60 s) |
| Optimising for a specific search phrase | add `keyword` / `--keyword "blue widgets"` |
| Visibility in AI answers (ChatGPT search, Perplexity, Claude, AI Overviews, Copilot), AI crawlers, llms.txt | `seo_aeo_audit { url }` / `agentic-seo-check aeo <url>`; a site: `crawl: true` / `--crawl`; build output: `{ dir, baseUrl }` / `aeo ./dist --base-url ...` |
| AI bots blocked even though robots.txt allows them | add `aiBots: true` / `--ai-bots` to the AEO audit |

Prefer auditing the running dev server or the build output over guessing from source: the tool sees exactly what crawlers see.

## 2. Read the result

- Fix in this order: **error** → **warning** → **info**. Errors block indexing or are outright defects (missing title, conflicting canonicals, invalid JSON-LD, 4xx/5xx, broken links). Warnings hurt ranking or click-through. Info is best practice.
- For site audits start with `siteFindings` and `issues` (page findings rolled up per rule with example URLs). One template fix usually clears a rule on many pages.
- `selector` tells you where in the HTML the problem is; `evidence` contains the current values and the offending items (capped lists). `recommendation` says what to change.
- `seo_list_rules { rule }` explains any rule id.

## 3. Fix in the source, not in the output

Find where the page's `<head>` is produced and change it there, per route:

- Next.js app router: `export const metadata` / `generateMetadata` (title, description, alternates.canonical, openGraph, robots). Pages router: `next/head`. Sitemap: `app/sitemap.ts`; robots: `app/robots.ts`.
- Astro: `<head>` in the layout, props per page; `@astrojs/sitemap`.
- Nuxt: `useSeoMeta` / `useHead`; `@nuxtjs/sitemap`.
- SvelteKit: `<svelte:head>`; Remix/React Router: `meta` export; TanStack Start: `head()` on the route.
- Plain HTML/static generators: the template partial that renders `<head>`.

AEO mappings: `aeo.robots-*` → `robots.txt` (Next.js `app/robots.ts`, Astro/static `public/robots.txt`); `aeo.server-blocks-*` → the CDN or firewall's bot settings, not the code; `aeo.nosnippet`/`aeo.noarchive`/`aeo.noindex` → the robots metadata or the `X-Robots-Tag` header in the host config; `aeo.text-needs-javascript` → render on the server (SSR/SSG); `aeo.question-not-answered-first` → put a one- or two-sentence answer right under the question heading; `aeo.schema-text-not-visible` → build the FAQ/HowTo JSON-LD from the same data the page renders; `aeo.article-*` → Article JSON-LD with author as a Person with url, datePublished and dateModified, and a visible `<time>`; `aeo.llms-txt-*` → `public/llms.txt`.

Typical mappings: `title.*`/`meta-description.*` → per-route metadata; `canonical.*` → absolute self-referencing canonical built from the site URL; `og.*`/`twitter.*` → social metadata with an absolute image URL; `structured-data.*` → JSON-LD emitted with `JSON.stringify`; `img.alt-missing` → alt props on image components; `site.broken-internal-links` → fix hrefs or add redirects; `site.sitemap-*` → generate the sitemap from the router so it stays in sync; `rendering.*` → move data fetching to the server (SSR/SSG) so the HTML carries the content.

## 4. Re-run and confirm

Run the same audit again. Report before/after score and the remaining findings. In CI, `agentic-seo-check audit <target> --fail-on error` exits 1 when errors remain.

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
- Lighthouse numbers are lab measurements from this machine; field data (CrUX) may differ.
- The AEO audit has its own score, separate from the SEO score. Blocked training bots (GPTBot, ClaudeBot, CCBot, ...) and a `__usage_ai-training` opt-out are info: opting out of training is the site owner's choice and does not keep the site out of AI answers. Ask before you "fix" one. Google-Extended blocks both Gemini training and Gemini Apps grounding; there is no token for one without the other.
- `aiBots`/`--ai-bots` requests come from this machine with each bot's User-Agent, not from the bots' IP ranges. A CDN that verifies bots may treat the real crawler differently, so tell the user to confirm a server block in the CDN's bot logs before changing firewall rules.
- `render` needs Playwright or an installed Google Chrome; `lighthouse` needs Chrome. If unavailable the audit still completes and adds a `tool.*` info finding with install instructions.
