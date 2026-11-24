---
"@rivi-software/agentic-seo-check": minor
---

Subscribers of the hosted server's premium tier can measure lab performance with `lighthouse: true` on `seo_audit_page`, and `formFactor` for mobile or desktop (issue #222). The server asks Google's PageSpeed Insights, which runs Lighthouse on its own servers, so the audited site gets no request from this server for it, and only when robots.txt lets `agentic-seo-check` fetch the page. The performance and SEO scores, the lab metrics and the opportunities come back as the local `lighthouse` gives them; PageSpeed Insights has no agentic-browsing category, so that score is empty. Without a subscription the option is an error that says so, and the server's free tier, the local server and the CLI are unchanged. A subscriber may ask for 5 runs a minute, named in the refusal as `lab_calls`.

In the library, `AuditOptions` has `lab`, a `LabRunner` that `lighthouse` calls instead of launching Lighthouse, and `FetchOptions` has `labGate`, which decides whether the lab may visit a page (URL rules and robots.txt, with no request to the page). `pageSpeedInsights` builds a `LabRunner` from a Google API key, with an optional cache, and `LabUnavailableError` is what it throws when the quota is used up or Google fails.
