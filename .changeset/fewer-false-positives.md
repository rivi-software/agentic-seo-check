---
"@rivi-software/agentic-seo-check": patch
---

Three findings no longer fire on pages that are fine:

- `content.placeholder-text` looks for filler as templates write it ("Lorem ipsum dolor sit amet", "consectetur adipiscing"), or a paragraph, list item or heading that opens with "Lorem ipsum". A page that only mentions the words, such as an article about placeholder copy or the website's rules page, passes.
- `loading.no-compression` says nothing when the audit runs in a Cloudflare Worker, the hosted server included. There the site's `Content-Encoding` never reaches the audit, so the rule flagged every page, compressed or not.
- Cloudflare's HTTP 409 with `error code: 1001`, its answer for a name that does not resolve, is a DNS error, as Node's fetch reports one. The hosted server no longer reports `site.host-variant-not-redirected` for a www host that has no DNS record.
