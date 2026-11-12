---
"@rivi-software/agentic-seo-check": patch
---

A crawl of a large site now fits in the hosted server's memory, and a local crawl or directory audit uses far less of it ([issue #165](https://github.com/rivi-software/agentic-seo-check/issues/165)). Before, every page kept its whole HTML until the audit ended, through the tags its findings quote, and kept its own copy of the menu and footer links every page repeats. A crawl of 100 pages of 600 KB with an 800-link menu needed a 256 MB heap; it now runs in 72 MB. On the website, a crawl of such a site ran out of memory partway and stopped without a report. The findings, their fixes and the audit JSON are unchanged.
