---
"@rivi-software/agentic-seo-check": patch
---

The hosted server keeps what it counts in the EU (issue #78): the hashes of each caller's address and of the sites it audited today, the day's count of requests, and ChatGPT's address ranges. They are in one Cloudflare Durable Object in the `eu` jurisdiction, which runs and stores its data in the EU only. The README and the server's privacy notice say so.
