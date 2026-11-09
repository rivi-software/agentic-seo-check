---
"@rivi-software/agentic-seo-check": minor
---

Findings now quote the text they are about, so an agent can show a reviewer the mistake it fixed. `meta-description.same-as-title` adds `description` to its evidence and `keyword.not-in-description` adds `description`. `site.duplicate-titles`, `site.duplicate-descriptions` and `site.duplicate-h1` quote the shared value as the first page writes it, not lowercased. The `seo-audit` skill now tells agents to put each title, description or canonical the audit found next to the value they changed it to in their pull request, with page text kept in code spans.
