---
"@rivi-software/agentic-seo-check": minor
---

Subscribers of the hosted server's premium tier can render a page's JavaScript with `render: true` on `seo_audit_page` (issue #230), in a browser that fetches nothing itself: every request it makes goes through the server's own fetch, which obeys robots.txt and signs the request, and anything else is denied. Without a subscription the option is an error that says so, and the server's free tier, the local server and the CLI are unchanged. A subscriber may ask for 10 renders a minute; the limits that hold subscribers' calls are named in the refusals as `render_calls`, `daily_renders` and `paid_daily_requests`.

In the library, `AuditOptions` has `browser`, a supplied browser to render with, and `RenderOptions` has `launch` and `fetchThrough`, which answer each request the browser makes from the audit's `FetchOptions`. Without them, `render` launches Playwright as before.
