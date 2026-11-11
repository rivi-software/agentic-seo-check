---
"@rivi-software/agentic-seo-check": minor
---

The hosted server's tools take an optional `context`: a few words from the agent on what the call is for, such as "re-check the title fixes" (issue #84). No tool reads it, and the audit is the same with or without it. It goes to the hosted server's usage analytics in PostHog, as `$mcp_intent`, with every URL, path, quoted text, hostname, email and IP address replaced, cut to 300 characters. A `context` longer than 1,000 characters is refused, as every capped input is.

The hosted server's `$mcp_tool_call` event now also says what the call did:

- the audit's score, finding counts and the ids of the rules that fired, as the CLI's `cli_command` lists them
- for a re-check, the counts of fixed, open and new findings
- the names of the arguments the call gave and its `format`, `detail` and `page_detail`, never an argument's value
- from a fixed list, the limit or refusal that stopped it

Never the hostname or anything from a page. The local server and the CLI send what they sent before.

In the library, a `Refusal` and a `RequestRefusedError` have an optional `reason` from a fixed list (`robots_txt`, `http_403`, `http_429`, `challenge`, `address`, …), which the hosted gate sets.
