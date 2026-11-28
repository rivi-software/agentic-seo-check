---
"@rivi-software/agentic-seo-check": minor
---

`HostedProfile`, the options `createMcpServer({ hosted })` takes, has an optional `paid` (`"subscription"` or `"per_call"`), which the hosted server sets on a call an account pays for (issue #229). No tool reads it yet, and a call without it behaves as before. The hosted server at https://agentic-seo.org/mcp is unchanged for anonymous callers. The local server and the CLI are unchanged.
