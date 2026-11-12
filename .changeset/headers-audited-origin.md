---
"@rivi-software/agentic-seo-check": patch
---

Request headers given with `-H`/`--header` (`headers`), such as a staging password or a cookie, now go to the origin of the audited URL only. Before, a redirect to another host, the external links a crawl checks with `--check-external`, and every request a page makes under `--render` or `--lighthouse` (third-party scripts, fonts, images) carried them too. A site that redirects to another host, such as `example.com` to `www.example.com`, now needs the audit to start at the address it answers at. The hosted server takes no headers and is not affected.
