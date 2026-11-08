<img src="assets/icon.svg" width="64" height="64" alt="">

# agentic-seo-check

SEO analysis built for coding agents. One core, two interfaces:

- **CLI** `agentic-seo-check` with JSON (default when piped) or Markdown output and CI-friendly exit codes.
- **MCP server** exposing five tools for Claude Code, Cursor, Codex and any other MCP client.

It audits **URLs** (production, staging, `localhost` dev servers), **static build output** (`dist/`, `out/`, `build/`) and **raw HTML**, and returns findings an agent can act on: a stable rule id, severity, what is wrong, the fix, a CSS selector for where it lives, and evidence with the current values.

## What it checks

| Area | Examples (123 rules in total, `agentic-seo-check rules` lists them) |
| --- | --- |
| On-page basics | title missing/long/short/placeholder ("React App"), meta description, H1 and heading outline, canonical (missing, conflicting, relative, pointing elsewhere), robots meta and `X-Robots-Tag`, `lang`, viewport, charset, doctype |
| Social | Open Graph completeness, absolute `og:image`, `og:url` vs canonical, Twitter card |
| Images and links | alt text, filename-style alt, missing dimensions (CLS), empty or generic anchor text, `href="#"`/`javascript:` anchors, http links on https pages, internal nofollow |
| International | hreflang syntax, absolute URLs, self reference, x-default, return links (crawl) |
| Structured data | JSON-LD parse errors, `@context`/`@type`, required and recommended properties for Article, Product, Offer, Organization, WebSite, BreadcrumbList, FAQPage, LocalBusiness, Event, Recipe, VideoObject, JobPosting, HowTo, Review, SoftwareApplication and more, ISO 8601 dates; microdata too |
| Content | empty or thin content, "lorem ipsum", readability, keyword presence in title/H1/body/description/URL and density |
| Response | 4xx/5xx, redirects and chains, slow HTML response, non-HTML content type, http instead of https |
| Site-level (crawl or directory) | robots.txt (missing, blocking, disallowed pages), sitemap (missing, invalid, noindex/non-canonical/broken/redirecting URLs, pages not in sitemap, orphan pages), broken internal links with their sources, redirected links and chains, duplicate titles/descriptions/H1s/content, deep pages, soft 404, http→https and www redirects, hreflang return links |
| Rendering (`--render`, Playwright) | title/description/canonical/H1/content/links/structured data that only exist after JavaScript runs; noindex injected or removed by JavaScript; console errors |
| Performance (`--lighthouse`, Chrome) | LCP, CLS, TBT, FCP, Speed Index, TTFB with Core Web Vitals thresholds, Lighthouse opportunities with estimated savings, failed Lighthouse SEO and agentic-browsing audits |

## Install

Requires Node 22.19 or newer.

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

Optional, only for `--render` and `--lighthouse`: Google Chrome installed, or `pnpm exec playwright install chromium`. The renderer uses a Playwright-managed Chromium when present and falls back to the installed Google Chrome or Edge.

Or straight from npm once published: `npx agentic-seo-check audit https://example.com`.

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

# CI: exit 1 when errors exist, smaller output
agentic-seo-check audit https://staging.example.com --crawl --fail-on error --compact --no-info

# rule reference
agentic-seo-check rules --category structured-data
agentic-seo-check rules --rule canonical.multiple
```

Exit codes: `0` success, `1` findings at or above `--fail-on`, `2` usage or runtime error. Progress goes to stderr, the report to stdout.

## MCP server

Add to a project `.mcp.json` (Claude Code reads it automatically; this repo ships one):

```json
{
  "mcpServers": {
    "agentic-seo-check": {
      "command": "node",
      "args": ["/absolute/path/to/agentic-seo-check/dist/mcp-bin.js"]
    }
  }
}
```

Or `claude mcp add agentic-seo-check -- node /absolute/path/to/agentic-seo-check/dist/mcp-bin.js`. Once published: `npx -y agentic-seo-check mcp`.

| Tool | Purpose |
| --- | --- |
| `seo_audit_page` | Audit one URL or an HTML string. Options: `keyword`, `render`, `lighthouse`, `formFactor`, `includeInfo`, `disableRules`, `headers`, `format` (json/markdown), `detail` (compact/full). |
| `seo_crawl_site` | Crawl and audit a site. Options: `maxPages`, `maxDepth`, `concurrency`, `delayMs`, `respectRobots`, `includeSubdomains`, `checkExternalLinks`, `includePatterns`, `excludePatterns`, `pageDetail`. |
| `seo_audit_directory` | Audit built HTML files in a directory. Options: `dir`, `baseUrl`, `maxPages`, `pageDetail`. |
| `seo_lighthouse` | Lighthouse performance + SEO + agentic-browsing for one URL. |
| `seo_list_rules` | Rule reference, filter by `category` or `rule`. |

All tools are read-only. Results are returned both as text (JSON or Markdown) and as `structuredContent`.

## Agent skill

`skills/seo-audit/SKILL.md` teaches an agent the audit → fix → re-audit loop, how to map rule ids to framework code (Next.js, Astro, Nuxt, SvelteKit, Remix, TanStack Start), and the caveats (preview-host noindex, localhost limits). Copy it to `.claude/skills/seo-audit/` in a project or `~/.claude/skills/` to make it available; this repo links it under `.claude/skills/`.

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
      "selector": "head > meta[name=\"description\"]",
      "url": "https://www.example.com/",
      "docs": "https://developers.google.com/search/docs/appearance/snippet"
    }
  ],
  "response": { "status": 200, "finalUrl": "…", "redirectChain": [], "timeMs": 142, "headers": { "content-type": "text/html" } },
  "performance": { "metrics": { "performanceScore": 99, "lcpMs": 848, "cls": 0, "...": "…" }, "opportunities": [] },   // with --lighthouse
  "rendering": { "raw": { "wordCount": 25 }, "rendered": { "wordCount": 137 }, "...": "…" }                         // with --render
}
```

Site audits add `crawl` stats, `robotsTxt`, `sitemaps`, `siteFindings`, `issues` (page findings rolled up per rule with example URLs) and `pages`.

## Library

```ts
import { auditUrl, auditSite, auditDirectory, auditHtml, renderMarkdown } from 'agentic-seo-check';

const page = await auditUrl('https://www.example.com/', { keyword: 'example', render: true });
const site = await auditSite('https://www.example.com/', { maxPages: 100 });
console.log(renderMarkdown(site));
```

## Development

```bash
pnpm test        # vitest: extractor, rules, crawler against a local fixture server, directory scan, MCP client
pnpm typecheck
pnpm dev audit https://example.com   # run from source with tsx
```

## Scope of this first version

- Crawls are breadth-first, same-site, HTML only, and obey robots.txt by default. `--render`/`--lighthouse` apply to the start page only during a crawl.
- Scores are indicative. Thresholds (title 30-60 chars, description 70-160, thin content 300 words, slow response 2 s, deep page depth 3) are configurable through the library `thresholds` option.
- Not included yet: gzip sitemaps, rendering every page in a crawl, field (CrUX) data, rank tracking, backlink data, AI-generated copy suggestions.

## License

MIT. See [LICENSE](LICENSE).

Created in [T3 Code](https://t3.codes).
