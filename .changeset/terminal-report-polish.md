---
"@rivi-software/agentic-seo-check": minor
---

The CLI's text report and progress are easier to follow on a terminal (issue #136):

- The progress line has a spinner and, after two seconds, the time taken. It shows from the moment an audit starts. Before, a single page's fetch and a Lighthouse run printed nothing until they finished.
- Each section's heading is followed by a rule to the terminal's width, so the parts of a long report stand out as it scrolls past.
- The report ends with a summary that gives the score, its band and the counts again, then what to fix first. The terminal leaves the end of a report in view, so the verdict is there without scrolling back up. The section was called "Next".
- `rules` sizes the id column for each category, so descriptions get the room at 80 columns.
- With `-o`, stderr says what the report found next to where it went. `--fail-on` says how many findings it counted and that the exit code is 1. Errors are red, and `--help` is coloured on a terminal that shows colour.

The JSON, the Markdown report, the flags and the exit codes are unchanged.
