---
"@rivi-software/agentic-seo-check": minor
---

The hosted server's `$mcp_tool_call` event now gives the `reason` when a refusal stops a crawl partway, such as `http_429`, `challenge`, `crawl_delay` or `site_requests` (issue #94). Such a crawl answers with the pages it read and `site.crawl-stopped` (`aeo.crawl-stopped` in the AEO audit), so its call is no error, and until now its event had no `reason`. In the library, `RequestGate` gains `crawlStopped`: a crawl calls it once with the refusal that stopped it.
