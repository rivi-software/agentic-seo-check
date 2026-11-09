---
"@rivi-software/agentic-seo-check": minor
---

Add seven SEO rules for URLs and links: `url.uppercase` and `url.underscores` (info, and they say not to rename URLs that are already indexed), `url.session-id`, `links.tracking-parameters` (campaign parameters on internal links), `links.local-host` (a canonical, `og:image`, image or script on localhost or a private address; info when only `<a>` links point there), `links.missing-fragment` (same-page links to ids the page lacks) and `https.mixed-content` (resources browsers block on an https page, and the ones they upgrade, which is all of them under `upgrade-insecure-requests`). The `Content-Security-Policy` response header now appears in `response.headers`.
