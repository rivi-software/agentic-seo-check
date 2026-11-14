---
"@rivi-software/agentic-seo-check": patch
---

The hosted MCP server moved to `https://agentic-seo.org/mcp`, and the website to `https://agentic-seo.org`, one hostname for both (issue #168). The server's address is also its page: a browser that opens it gets the setup, the limits and the privacy notice. The former addresses, `https://mcp.agentic-seo.rivi.software/mcp` and `https://mcp.agentic-seo-check.rivi.software/mcp`, keep working, so clients set up with them need no change; the former pages, share links included, redirect to the same address on `agentic-seo.org`. The hosted server's requests keep their User-Agent and Signature-Agent for now. The MCP servers' instructions link the rules at `https://agentic-seo.org/rules`.
