---
"@rivi-software/agentic-seo-check": minor
---

Find URLs that serve one page twice. `site.url-variant-duplicate` reports a page that also answers 200 with its trailing slash toggled or its path in another case, without a redirect or a canonical back (a crawl requests these variants for a few pages, outside localhost, and reads the ones its links reached); `site.parameter-duplicates` reports URLs that differ only in their query string and show the same text; `site.broken-images` reports images that answer 4xx/5xx, with the pages that show them (up to 100 image URLs per crawl, and as files in build output). Fixes: pages that name another URL as canonical no longer count in `site.duplicate-content`, `site.duplicate-titles`, `site.duplicate-descriptions` and `site.duplicate-h1`, and a crawl no longer records one page twice when a link and a redirect reach it at the same time.
