---
"@rivi-software/agentic-seo-check": minor
---

`seo_crawl_site` and `seo_aeo_audit` take `urls`, a list of pages on one site to audit instead of crawling from `url`, and the CLI takes `--urls <file>`, one URL or path a line (issue #231). An agent that changed five pages audits those five, with the site-wide checks over them, and requests no page it did not list. Every URL must be on the origin of `url`, and the list holds at most `maxPages`. Links are checked, robots.txt and `Crawl-delay` are obeyed and the hosted server's limits count the call as a crawl, as before. The orphan check, which needs every page's links, is left out. The audit's `crawl` gains `pagesListed`, the number of pages listed.

In the library, `auditSite` and `auditAeoSite` take `urls`.
