---
"@rivi-software/agentic-seo-check": minor
---

Site audits now follow canonicals and hreflang links to where they point. Six rules: `site.canonical-target-broken`, `site.canonical-target-redirects`, `site.canonical-target-noindex` and `site.canonical-chain` for canonicals that point to a 4xx/5xx, a redirect, a noindex page or a page that names yet another canonical; `site.hreflang-target-invalid` for alternates that are broken, redirect, are noindex or are not canonical (an `x-default` that redirects to the visitor's language is fine); and `site.links-to-noindex` (info) for noindex pages the site links to, cart, search and account pages aside. A crawl probes same-site canonical and hreflang targets no link led to, within `maxLinkChecks`, and a directory audit checks them against the files when `baseUrl` is the production host.
