---
"@rivi-software/agentic-seo-check": patch
---

The local MCP server's analytics give a `reason` for input its tools refuse, as the hosted server's do ([issue #123](https://github.com/rivi-software/agentic-seo-check/issues/123)): `target` when a call names no `url`, `html` or `dir`, and `unknown_rules` or `other_audit_rules` when `rules` names no rule of the audit. Each value comes from a fixed list; the event still carries no argument's value.

In the library, `ExpectedError` takes an optional `reason` in its options, and `RequestRefusedError`, `CallLimitError` and `RuleNamesError` keep theirs there.
