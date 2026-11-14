---
"@rivi-software/agentic-seo-check": patch
---

`install-browser` sends a `cli_command` event like the other commands: the flags given (`--with-deps`), the exit code and the duration, so a download that fails shows up (issue #173). Turn it off as before, with `agentic-seo-check telemetry disable`, `DO_NOT_TRACK=1` or `AGENTIC_SEO_CHECK_TELEMETRY=0`.

On the hosted server, a tool call from a client that names itself neither in `initialize` nor in the call, such as claude.ai's, now has the product token of its headers as `$mcp_client_name` (`Claude-User`), and `$mcp_client_name_source` says where the name came from. Before, its calls had no client name. The local server is unchanged.
