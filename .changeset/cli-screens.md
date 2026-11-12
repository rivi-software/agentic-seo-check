---
"@rivi-software/agentic-seo-check": minor
---

Everything else the CLI prints on a terminal now has the text report's style (issue #144):

- `--help` starts with the version, draws a rule after each heading, lists the commands in two groups and each audit's options in four (crawling, checks, output, requests), and dims choices and defaults. Before, it was commander's layout, with one list of 30 options for `audit`.
- A usage error is a red `✖` line, with commander's suggestion under it, then the usage and the command for the help. Before, the command's whole help followed, which pushed the error off the screen. Piped, the whole help still follows, for agents. The CLI's own errors start with `✖`, where they started `agentic-seo-check:`.
- `telemetry` says whether it is on and why, what is sent, where the choice is kept and the command that changes it, and `enable` says when the environment keeps it off. The first-run notice is wrapped to the terminal under a heading; piped, it is the one line it was.
- `install-browser` shows each download and its percentage on the progress line, and says when the browser is installed. With `--with-deps`, or piped, Playwright's own lines show as before.
- `mcp` and `agentic-seo-check-mcp`, started by hand in a terminal, say on stderr that they wait for an MCP client and how to add them to one. Started by a client, they print nothing new.
- `rules` names the categories when `--category` matches none, suggests the nearest rule id for a mistyped `--rule`, and ends one rule in full with the command that checks only that rule.

The JSON, the Markdown report, the flags and the exit codes are unchanged.
