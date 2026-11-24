---
"@rivi-software/agentic-seo-check": minor
---

The hosted server has two new tools for a large or slow site, whose crawl can outlast a client's wait for an answer (issue #209). `seo_start_crawl` takes `seo_crawl_site`'s options, starts the crawl in the background with the same caps and answers at once with an `id`. `seo_crawl_result` takes the `id` and answers `running` while the crawl runs, then the SEO audit (`audit: "seo"`, the default) or the AEO audit (`audit: "aeo"`) of the same crawl, or the crawl's failure, such as a site's refusal. The server keeps a result for 7 days, and anyone with the `id` can read it, so treat it as a secret. `seo_crawl_site` is unchanged. The local server and the CLI are unchanged.
