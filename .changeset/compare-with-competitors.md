---
"@rivi-software/agentic-seo-check": minor
---

A page can now be compared with one to five competitors' pages, side by side, with what they have that it lacks ([issue #129](https://github.com/rivi-software/agentic-seo-check/issues/129)): `agentic-seo-check compare <url> <competitor-url>...`, and `seo_compare_pages` on the local and the hosted MCP server. The tool searches for no competitors: you, or your agent, bring them, from a search for the page's query, from the user, or from the pages an AI answer cited.

Each page is requested once and gets both audits, and each site's robots.txt and llms.txt are read once. The answer is a new kind, `comparison`, with each page's SEO and AEO score and its `signals`: words, `<h2>` subheadings, question headings and how many are answered right under them, tables, lists, structured data types, the Article's author and dates, the AI search crawlers and answer bots robots.txt keeps out, llms.txt, response time and HTML size. With `--keyword` (`keyword`) it adds whether the phrase is in the title, an H1, the description and the text, and with `--field-data` (`fieldData`) real visitors' LCP, INP and CLS.

- `gaps`: what at least half of the competitors read have and the page lacks, each with the competitors that have it and the `rules` and `fix` that close it on this page, such as `aeo.article-author-missing`, `aeo.question-not-answered-first`, `aeo.robots-blocks-answer-bot` or `keyword.not-in-title`. A gap no rule covers, such as more text or a table, gives the numbers and no edit.
- `leads`: where the page is ahead.

A gap is not a finding: it has no severity and changes no score. A competitor that cannot be read is listed with `skipped` and why, and left out of the gaps. Headers go to the page's own origin only, never to a competitor. On the hosted server a comparison is one tool call, each competitor's robots.txt is obeyed, and each competitor's site counts toward the sites a caller may audit in a day. The other tools and commands are unchanged.

In the library, `comparePages(url, competitors, options)` returns a `Comparison`, and `renderComparisonMarkdown`, `renderComparisonText` and `compactComparison` render and trim it.
