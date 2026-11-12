---
"@rivi-software/agentic-seo-check": minor
---

`rules` and `disableRules` take a rule category as well as a rule id, on every surface: `--rule structured-data`, or `rules: ["structured-data"]` in an MCP tool, runs every `structured-data.*` rule, and `--disable social` skips the Open Graph and Twitter card rules ([issue #121](https://github.com/rivi-software/agentic-seo-check/issues/121)). Agents on the hosted server passed a category to check one area of a page, and the call failed before it requested the page. Before, `rules` refused a category as an unknown rule id, and `disableRules` ignored it without a word.

- A name that is neither a rule id nor a category is still refused, and the error now lists the categories the audit takes. A category of the other audit is refused as that audit's rule ids are: `aeo` in the SEO audit, `structured-data` in the AEO audit.
- The hosted server's analytics give a `reason` for the input it refuses: `target` (neither `url` nor `html`), `unknown_rules` and `other_audit_rules`.

In the library, `onlyRules` and `disableRules` take categories too, and the error for `onlyRules` that name no rule is a `RuleNamesError`, an `ExpectedError` with a `reason`.
