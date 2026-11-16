---
"@rivi-software/agentic-seo-check": minor
---

`rules` and `disableRules`, and the CLI's `--rule` and `--disable`, take what a rule id has before its dot as well as a rule id or a category: `["robots", "og"]` runs every `robots.*` and `og.*` rule, though their categories are `indexing` and `social` (issue #187). Before, such a name failed as an unknown rule id. An unknown name still fails, and the error now names the rule ids close to it: `response.status` gets `response.error-status`, `noindex` gets `robots.noindex` and the other rules about noindex.
