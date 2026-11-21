---
"@rivi-software/agentic-seo-check": minor
---

Share a full report as a secret link on agentic-seo.org (issue #192): `agentic-seo-check share <url>` runs the SEO and the AEO audit, uploads them, and prints a link to the website's report, with every finding, its fix and the downloads, that anyone with the link can open for 30 days. It works on a page, a site with `--crawl`, `localhost`, a staging site behind `-H` headers and a build directory, since the audits run on your machine; the report says the website did not request the pages itself, and search engines do not index it. With `--format json`, or piped, it prints `{ url, expiresAt, kind, seo, aeo }`.

- `seo_share_report` on the local MCP server does the same for an agent, with `url` (and `crawl`) or `dir`.
- `seo_share_report` on the hosted MCP server audits a public `url` (and with `crawl` its site) and keeps the report itself; the report says the hosted server ran it.

Both tools say in their annotations that they are not read-only. The other tools are unchanged.

In the library, `shareTarget(target, options)` audits and uploads, and `auditForShare` and `shareAudits` do each half; a refused upload throws a `ShareError`.
