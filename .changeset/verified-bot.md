---
"@rivi-software/agentic-seo-check": minor
---

The CLI, the local MCP server and the library now send the product token `agentic-seo-check-local` in their User-Agent, and their crawls obey the robots.txt group for `agentic-seo-check-local`, or `*`. `agentic-seo-check` is the hosted server's token alone, so a robots.txt group for it no longer applies to crawls from your machine. The hosted server now obeys robots.txt for every request, an audit of one page included, waits between a crawl's requests as `Crawl-delay` asks, signs its requests with Web Bot Auth, and answers a site that turns it away with the site's answer alone (#41). For the library, `FetchOptions` gains `sign` and `RequestGate` gains `robotsTxt`.
