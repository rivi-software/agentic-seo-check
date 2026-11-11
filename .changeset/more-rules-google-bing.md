---
"@rivi-software/agentic-seo-check": minor
---

Thirteen more SEO rules, each from a search engine's or a standard's own documentation: Google Search Central, Bing, the sitemaps protocol and RFC 9309 (issue #77).

- `canonical.paginated-to-first`: page 2 or later of a series names the first page as canonical.
- `hreflang.canonical-other-language`: the canonical names the page's version in another language.
- `links.hash-route`: links route through the URL fragment (`#/products`), which Google cannot read as pages. `links.missing-fragment` leaves these links to it.
- `robots.unavailable-after`: an `unavailable_after` date that has passed (warning) or cannot be read (info).
- `robots.max-image-preview-missing`: an article without `max-image-preview:large`, so Google Discover shows a small image.
- `img.unsupported-format`: images in a format Google Images does not index (HEIC, TIFF, JPEG XL, PSD).
- `structured-data.paywall-invalid`: paywalled content markup without a `.class` section Google can check.
- `structured-data.self-serving-review`: an organization's review stars about itself, on its own site, which Google does not show.
- `structured-data.site-name-missing`: a home page with structured data but no WebSite item for the site name.
- `site.robots-txt-invalid-rule`: robots.txt paths that match nothing, rules above the first `User-agent`, and relative `Sitemap:` lines.
- `site.sitemap-invalid-url`: sitemap `<loc>` values that are not full URLs, or are 2,048 characters or longer.
- `site.sitemap-lastmod-missing` and `site.sitemap-lastmod-uniform`: a sitemap without `lastmod`, or with the same build time on every URL.

`structured-data.invalid-value` now also checks `availability`, `itemCondition`, `eventStatus`, `eventAttendanceMode` and `employmentType` against the values Google lists, and `structured-data.retired-type` also reports Estimated Salary, Learning Video and Book Actions markup, which Google phased out in 2025.
