---
"@rivi-software/agentic-seo-check": minor
---

Check robots.txt and sitemaps against what Google reads of them. Eight site rules: `site.robots-txt-too-large` (over 500 KiB), `site.robots-txt-unsupported-rule` (`noindex:` and `nofollow:` lines Google stopped reading in 2019, and `crawl-delay`, which it ignores), `site.robots-blocks-resources` (scripts and stylesheets the pages load that robots.txt keeps from Googlebot), `site.sitemap-too-large`, `site.sitemap-index-nested`, `site.sitemap-lastmod-invalid`, `site.sitemap-lastmod-future` and `site.sitemap-other-host`. Gzip sitemaps (`.xml.gz`) are now read instead of reported as an error, an empty `<urlset>` is a valid sitemap with no URLs, a sitemap larger than the 15 MB the audit reads (uncompressed) is reported as such instead of as unparsable or missing, and a directory audit no longer reads a sitemap path that leads outside the output directory. `robotsTxt.bytes` and `sitemaps.problems` are new in the site audit JSON.
