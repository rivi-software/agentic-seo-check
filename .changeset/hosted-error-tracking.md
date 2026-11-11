---
"@rivi-software/agentic-seo-check": patch
---

Error tracking in the hosted MCP server now hears its own bugs (issue #93). Before, it missed most of them:

- A rule that throws, a page a crawl leaves out, and a request it could not sign are now reported, in one request with the call's `$mcp_tool_call`, one event per bug.
- When the server's own state fails, such as its Durable Object, the call is now an internal error that is reported. Before, the caller was told a limit had been hit.
- When a tool throws after its work is done, the call is now an internal error that is reported. Before, it was counted as arguments the caller got wrong.
- A day's count or a call's record that could not be kept, OpenAI's ranges that could not be fetched (on the daily schedule too), and signing keys that do not parse are now reported. Before, they reached the Worker's logs at most.

A call's `$exception` also carries its client, the names of the arguments it gave, its options and how far it got, as its `$mcp_tool_call` does. The Worker's 500 sits in the caller's session.
