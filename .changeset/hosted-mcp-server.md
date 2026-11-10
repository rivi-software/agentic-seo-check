---
"@rivi-software/agentic-seo-check": minor
---

A hosted MCP server: RIVI Software runs the MCP server on Cloudflare at `https://mcp.agentic-seo-check.rivi.software/mcp`, free and with no install, account or key, for claude.ai, Cowork, ChatGPT and any client that connects over Streamable HTTP. It serves `seo_audit_page`, `seo_crawl_site`, `seo_aeo_audit` and `seo_list_rules` with the local server's names and options, less what needs your machine (`localhost`, build directories, rendering, Lighthouse, your headers and User-Agent, AI bot probes), and keeps each site and each caller to limits it states; the README's "Hosted server" section has each client's setup, the limits and what it cannot do. It deploys with every release.

What the package gains for it, and what changes for everyone:

- `createMcpServer({ hosted })` serves the hosted server's tools, through a profile that starts each call and gates its requests. `createMcpServer()` serves the local server's tools as before.
- `FetchOptions.gate` is asked before every request and every redirect, and shown each answer; `fetchPage` throws `RequestRefusedError` for what it refuses. A crawl leaves a link, image or sitemap it was refused unchecked, never broken or missing, and stops at a refusal for the whole site with `site.crawl-stopped` (`aeo.crawl-stopped` in the AEO audit), without reporting orphan pages it could not see.
- `response.truncated` and `aeo.page-truncated` (info) say when a page was larger than the audit reads (5 MB), so only its first part was audited; the audit's `response` then has `truncated: true`. The read now stops at the cap to the byte.
- Crawls obey a robots.txt group for `agentic-seo-check`, falling back to `*` as RFC 9309 says. robots-parser read the audit's User-Agent as `Mozilla`, so such a group never applied before. A group that keeps out this tool alone is not reported as `site.robots-blocked-pages`, and one that keeps it from the start URL ends the crawl with an error that says so. The soft-404, http and www probes, too, ask only for what robots.txt lets the crawl request, so a site that disallows `/` gets none of them.
- The `maxSitemaps` and `maxSitemapBytes` crawl options set how many sitemaps a crawl reads and how much of each; `site.sitemap-too-large` names the size the audit read up to.
