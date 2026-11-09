---
"@rivi-software/agentic-seo-check": minor
---

Every crawl and directory rule (`site.*`), every `--render` rule (`rendering.*`) and every `--lighthouse` rule now carries a `fix`. Site fixes name the file or response they change with `url`: the robots.txt line that blocks a page, the sitemap `<loc>` to remove or repoint, the `<a>` tag on the linking page with the final URL of a redirect, the response a redirect hop should send. A page blocked by robots.txt is taken out of the sitemap rather than unblocked, and a noindex page out of the sitemap rather than made indexable. Render fixes quote the tag the rendered page has, to send from the server; Lighthouse fixes name the LCP image, the unsized images and the blocking resources Lighthouse found. A file to rebuild (a script to split, an image to re-encode) is an `asset` replace at `whole file`, with no `current` and the size or time to aim for in `write`. `site.crawl-limit-reached` has no fix: it is about the audit.

`performance` (with `--lighthouse`) now also lists what those fixes are built from: `lcpElement`, `unsizedImages`, `layoutShifts`, `renderBlocking`, `scripts`, and up to 10 `items` per opportunity and failed audit.

`site.hreflang-no-return-link` no longer reports a page whose canonical names another URL (a parameter variant is folded into that URL, so nothing should link back to it), and counts a page whose `en` and `x-default` links name the same alternate once.

A crawl now keeps its pages in the order a one-at-a-time breadth-first crawl reaches them, whatever order parallel requests finish in, so `site.url-variant-duplicate` and the duplicate rules call the same URL the page (and the other the variant) on every run.
