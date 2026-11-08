<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rivi-software/agentic-seo-check/main/assets/rivi-agentic-seo-check-on-dark.svg">
      <img src="https://raw.githubusercontent.com/rivi-software/agentic-seo-check/main/assets/rivi-agentic-seo-check.svg" alt="RIVI agentic-seo-check" width="545">
    </picture>
  </a>
</p>

<p align="center">
  SEO analysis built for coding agents: a CLI and an MCP server that audit URLs,<br>
  static build output or raw HTML, and return findings an agent can act on.<br>
  Open source, from <a href="https://rivi.software">RIVI Software</a>.
</p>

<p align="center">
  <a href="https://github.com/rivi-software/agentic-seo-check/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rivi-software/agentic-seo-check/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@rivi-software/agentic-seo-check"><img src="https://img.shields.io/npm/v/@rivi-software/agentic-seo-check?color=0b6b3a" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@rivi-software/agentic-seo-check"><img src="https://img.shields.io/npm/dm/@rivi-software/agentic-seo-check?color=0b6b3a" alt="Monthly npm downloads"></a>
  <a href="https://github.com/rivi-software/agentic-seo-check/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-0b6b3a" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#install">Install</a>
  ·
  <a href="#cli">CLI</a>
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

agentic-seo-check is one core with two interfaces:

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

Requires Node 22.19 or newer. Published on npm as [`@rivi-software/agentic-seo-check`](https://www.npmjs.com/package/@rivi-software/agentic-seo-check); the commands it installs are `agentic-seo-check` and `agentic-seo-check-mcp`.

```bash
npx @rivi-software/agentic-seo-check audit https://example.com   # no install
npm install -g @rivi-software/agentic-seo-check                  # or pnpm add -D / npm i -D in a project
agentic-seo-check --help
```

Optional, only for `--render` and `--lighthouse`: `playwright` and `lighthouse` (+ `chrome-launcher`) are optional peer dependencies, so install them next to the tool, plus Google Chrome or `npx playwright install chromium`. The renderer uses a Playwright-managed Chromium when present and falls back to the installed Google Chrome or Edge.

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

# CI: exit 1 when errors exist, smaller output
agentic-seo-check audit https://staging.example.com --crawl --fail-on error --compact --no-info

# rule reference
agentic-seo-check rules --category structured-data
agentic-seo-check rules --rule canonical.multiple
```

Exit codes: `0` success, `1` findings at or above `--fail-on`, `2` usage or runtime error. Progress goes to stderr, the report to stdout.

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

Or `claude mcp add agentic-seo-check -- npx -y @rivi-software/agentic-seo-check mcp`. From a source checkout, use `node /absolute/path/to/agentic-seo-check/dist/mcp-bin.js` instead (this repo's own `.mcp.json` does that).

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
import { auditUrl, auditSite, auditDirectory, auditHtml, renderMarkdown } from '@rivi-software/agentic-seo-check';

const page = await auditUrl('https://www.example.com/', { keyword: 'example', render: true });
const site = await auditSite('https://www.example.com/', { maxPages: 100 });
console.log(renderMarkdown(site));
```

## Scope of this first version

- Crawls are breadth-first, same-site, HTML only, and obey robots.txt by default. `--render`/`--lighthouse` apply to the start page only during a crawl.
- Scores are indicative. Thresholds (title 30-60 chars, description 70-160, thin content 300 words, slow response 2 s, deep page depth 3) are configurable through the library `thresholds` option.
- Not included yet: gzip sitemaps, rendering every page in a crawl, field (CrUX) data, rank tracking, backlink data, AI-generated copy suggestions.

## Contributing

Bug reports, wrong findings, new rules and fixes are welcome from anyone. With Node 24 and pnpm 12:

```bash
pnpm install
pnpm run verify
```

`verify` runs what CI runs: format, lint, typecheck, tests, build and a check of the packed package. `pnpm run dev audit https://example.com` runs the CLI from source. [CONTRIBUTING.md](https://github.com/rivi-software/agentic-seo-check/blob/main/CONTRIBUTING.md) covers proposing a change, what a pull request needs and how releases reach npm, and [AGENTS.md](https://github.com/rivi-software/agentic-seo-check/blob/main/AGENTS.md) is the brief for coding agents working on the tool itself. Everyone who takes part follows the [code of conduct](https://github.com/rivi-software/agentic-seo-check/blob/main/CODE_OF_CONDUCT.md). [SECURITY.md](https://github.com/rivi-software/agentic-seo-check/blob/main/SECURITY.md) says how to report a vulnerability privately.

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
  <sub>RIVI agentic-seo-check is made by <a href="https://rivi.software">RIVI Software</a>, which builds software for radio stations. Created in <a href="https://t3.codes">T3 Code</a>.</sub>
</p>
