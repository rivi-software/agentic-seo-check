---
"@rivi-software/agentic-seo-check": minor
---

Add five rules for how a page loads, read from the HTML and its headers without a browser: `loading.no-compression` (HTML sent without gzip or Brotli), `loading.render-blocking-script` (scripts in `<head>` without `async`, `defer` or `type="module"`), `img.lazy-above-fold` (`loading="lazy"` on the first large image, or together with `fetchpriority="high"`), `img.srcset-missing` (images 640 pixels wide or more without `srcset`) and `favicon.missing` (the home page links to no icon for Google's search results). The `Content-Encoding` response header now appears in `response.headers`.
