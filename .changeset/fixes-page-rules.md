---
"@rivi-software/agentic-seo-check": minor
---

Every page rule's finding now carries a `fix`: canonical, document, head, headings, hreflang, images, indexing, links, URL, loading, social, structured data, content, keyword and response rules, and `response.fetch-failed`. Edits quote the tag as the page writes it and give the rewritten tag: an absolute canonical or hreflang URL, `defer` on the blocking script, an `<h1>` turned into an `<h2>`, a price written as `19.99` with `priceCurrency`, a `301` in place of a meta refresh. Where a finding has two ways out, the fix takes the one that cannot hurt: it never deletes content, and indexing fixes say to keep a noindex that is deliberate. `structured-data.retired-type` has no fix, since the markup stays.
