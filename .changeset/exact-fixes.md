---
"@rivi-software/agentic-seo-check": minor
---

Findings now carry a `fix`: the exact edits that resolve them on this page, each saying where (`html`, `http`, `robots.txt`, `sitemap`, `llms.txt` or `asset`), what to do (`add`, `replace`, `remove`), the code there now as the server sent it and the code to write instead, with `{{…}}` slots for words only the author can write. The title and meta description rules have theirs; the other rules follow.

Every finding also has a stable `id`, and the audits take two new options for checking a fix: `--rule` / `rules` runs only the named rules, and `--baseline` (an earlier audit's JSON) / `baseline` (its finding ids) adds `baseline` to the result with the findings since fixed, still open and new. A finding counts as fixed only when its rule ran again on its page. The Markdown report shows each edit and a Re-check section.
