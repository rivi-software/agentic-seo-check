---
"@rivi-software/agentic-seo-check": patch
---

The MCP servers' `$mcp_initialize` event no longer carries `$session_id`, so PostHog counts a session only once a tool is called: most connections, such as a chat that loads the hosted server's connector, call none. The hosted server now answers `initialize` with an `Mcp-Session-Id` header, a token with the session's id and the client's name, version and protocol revision that the client sends back with each request, so the calls of one connection share a session and name their client. The server keeps nothing, and the tools and their answers are unchanged.
