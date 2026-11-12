---
"@rivi-software/agentic-seo-check": minor
---

Audits can now include what Google ranks on: the Core Web Vitals of real visits, from the Chrome UX Report ([issue #130](https://github.com/rivi-software/agentic-seo-check/issues/130)). `--field-data` on `audit` and `crawl`, and `fieldData` on `seo_audit_page` and `seo_crawl_site`, ask for the URL's record. That is Chrome's 75th percentile of LCP, INP, CLS, FCP and TTFB on phones over the last 28 days, or its origin's when the URL has too few visits. A crawl asks for its first 10 pages. Each page audit gets `fieldData`, and the text and Markdown reports show it.

- `perf.field-lcp-poor`, `perf.field-inp-poor`, `perf.field-cls-poor`: LCP over 4 s, INP over 500 ms or CLS over 0.25 at the 75th percentile, as a warning.
- `perf.field-lcp-needs-improvement`, `perf.field-inp-needs-improvement`, `perf.field-cls-needs-improvement`: LCP over 2.5 s, INP over 200 ms or CLS over 0.1, as info.

Each fix takes what on the page is known to slow that metric: a lazy first image, scripts in `<head>`, images without a size, a missing viewport, the page's scripts. When the page shows none of these, the fix says where to look. A page without a record gets `fieldData.reason: "no-data"` and no finding.

The CLI and the local MCP server need a free Google Cloud API key in `CRUX_API_KEY`, and fail with how to get one without it. The hosted server uses RIVI Software's own key and keeps each answer for a day. The query goes to Google, never to the audited site. A URL on `localhost`, a private network or an IP address is never sent, and neither is an audit with headers.

In the library, `auditUrl` and `auditSite` take `fieldData: true`, or `{ apiKey, cache }`, and `PageAudit` has `fieldData`. A `FieldDataKeyError` is an `ExpectedError`.
