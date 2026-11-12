---
"@rivi-software/agentic-seo-check": patch
---

Every MCP tool, on the local server and the hosted one, now sets all four annotation hints as explicit booleans: `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` ([issue #138](https://github.com/rivi-software/agentic-seo-check/issues/138)). OpenAI's plugin guidelines ask for the first three on every tool, and for a tool that is safe to retry to say so. Before, every tool but `send_feedback` left out `destructiveHint`, and `seo_crawl_site`, `seo_lighthouse` and `seo_aeo_audit` left out `idempotentHint` too. The tools only read, so each now says it deletes nothing (`destructiveHint: false`) and that a second call has no further effect (`idempotentHint: true`), as an HTTP GET does. `send_feedback` is unchanged.
