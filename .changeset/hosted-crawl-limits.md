---
"@rivi-software/agentic-seo-check": patch
---

The hosted server and the website crawl up to 100 pages, 5 links deep, with 100 link checks, where they crawled 25 pages, 3 deep, with 50 (issue #73). `seo_crawl_site` and `seo_aeo_audit` with `crawl` take these as their default and their maximum. One site may get 600 requests a minute from the hosted server, from all callers together, where it got 300.

Each caller may now audit 10 different sites a day on the hosted server: an IP address, through the MCP server or the website's form. claude.ai's users together may audit 100, and ChatGPT's users 100. A site is its hostname, with `www.` counted as the same site. A caller may audit a site it already audited that day as often as it likes, so it can always check a fix again. The count starts again at 00:00 UTC. Audits of inline `html` and `seo_list_rules` count no site.

To count the sites, the server keeps a hash of the caller's address and of each hostname. It makes both hashes with a random key that is new each day, and deletes them, with the key, at 00:00 UTC. The README, the server's landing page and the skill now list these limits.
