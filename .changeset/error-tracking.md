---
"@rivi-software/agentic-seo-check": minor
---

The CLI and the local MCP server report unexpected errors to RIVI Software's PostHog project (EU) as `$exception` events, so bugs show up without anyone opening an issue (issue #60). An event carries the error's type, its message with every URL, path, quoted text, hostname and address taken out, and its stack with each file named by its place in the package or in `node_modules`, never the directories above it. Failures the tool expects and explains, such as a refused request, a missing browser or a bad argument, are not reported. The same switches turn it off as the rest of the telemetry, and the first-run notice, which now names errors, shows once more to those who saw the old one. Errors the core throws for such failures are now `ExpectedError`s, a new export that `RequestRefusedError`, `RenderUnavailableError` and `LighthouseUnavailableError` extend.
