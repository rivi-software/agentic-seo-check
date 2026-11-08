# @rivi-software/agentic-seo-check

## 0.1.1

### Patch Changes

- de8e754: `--help` and Markdown reports end with one line naming RIVI Software, and the MCP server introduces itself with a title, a description, a website and the RIVI mark as icons. The JSON an audit returns is unchanged. An unknown rule id inside the tool now fails with an error that names it, and a render or Lighthouse failure that throws something other than an `Error` is reported with its text instead of `undefined`.
