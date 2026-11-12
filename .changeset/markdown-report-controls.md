---
"@rivi-software/agentic-seo-check": patch
---

The Markdown report leaves out the control characters a page's text holds, as the text report does (GHSA-f4fr-vv3h-fxwg). Before, an escape sequence in a page's title, description, headings, link text or structured data reached the terminal of whoever printed the report: with `-f md`, from a `-o` file printed with `cat`, or from an MCP tool called with `format: "markdown"`, local or hosted. It could clear the screen, set the window title, hide text, show a link to somewhere other than it says or, in some terminals, write to the clipboard. The JSON keeps the page's text as it is.

In the library, `renderMarkdown` and `renderAeoMarkdown` return the report without those characters.
