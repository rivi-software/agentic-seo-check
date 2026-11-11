---
"@rivi-software/agentic-seo-check": minor
---

The hosted MCP server asks agents what a call is for, and hears more of what they do ([#101](https://github.com/rivi-software/agentic-seo-check/issues/101)). Its audit tools list `context` as required, though a call without it still works, and every tool takes an optional `llm_model` and `conversation_id`. Each answer ends with a second text block, `{"conversation_id":"…"}`, which the agent sends back with its next call, so the calls of one conversation share a session in the analytics across connections; the audit and `structuredContent` are unchanged. A fifth tool, `send_feedback`, lets an agent tell the developers about a capability it missed, a tool that failed or misled it, or something that worked well. Its analytics also name the model, the tool's description and the argument names (`$mcp_input_keys`), and a call to a tool the server lacks. The local server and the CLI are unchanged.
