---
"@rivi-software/agentic-seo-check": minor
---

The CLI and the local MCP server send anonymous usage data to RIVI Software, in PostHog's EU cloud (issue #57): one `cli_command` event per run of `audit`, `crawl`, `aeo` and `rules` (the command, the names of the flags, the kind of target, the exit code, the duration, the counts and the ids of the rules that fired), and one `$mcp_tool_call` event per tool call of the local server (the tool, whether and how it failed, the duration, the MCP client). Never a URL, a hostname, a path, the HTML or anything from a page, and no id that outlives a run or a session. The first run says so on stderr. Turn it off with the new `agentic-seo-check telemetry disable`, or `DO_NOT_TRACK=1` or `AGENTIC_SEO_CHECK_TELEMETRY=0`; it is off wherever `CI` is set. The library sends nothing, and `startMcpServer` takes an optional `analytics` for those who want their own.
