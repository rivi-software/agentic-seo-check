---
"@rivi-software/agentic-seo-check": minor
---

Add seven SEO rules for the head of a page and its indexing signals: `head.closed-early` (an element that does not belong in `<head>`, such as a pixel `<img>` or stray text, ends it, and Google ignores the metadata after it), `head.metadata-in-body`, `meta-refresh.redirect`, `charset.late`, `robots.conflicting`, `robots.malformed-directive` and `canonical.header-conflict` (an HTTP `Link` canonical that disagrees with the HTML one). Metadata that Next.js (15.2+) or React streams into a hidden part of `<body>` is reported as info, since Google reads it after rendering. Fixes: an inline SVG icon's `<title>` no longer counts as a second page title (`title.multiple`); `canonical.missing` and `charset.missing` accept a canonical in the `Link` header and a charset in the `Content-Type` header; and an `X-Robots-Tag` for one other crawler (`GPTBot: noindex`) no longer makes the page noindex for search engines.
