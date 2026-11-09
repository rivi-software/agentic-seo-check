---
"@rivi-software/agentic-seo-check": minor
---

Every AEO rule now carries a `fix`. robots.txt fixes quote the lines that block a bot and give it its own group, without touching a training bot that shares the group (when only AI bots share it, the fix quotes the group's user-agent lines whole, so the answer and training fixes applied together cannot leave its rules without a user-agent line); training opt-outs, Content-Signal and `__usage_ai-training` fixes say it is the site owner's choice. Opt-out fixes rewrite the robots meta tag or `X-Robots-Tag` without the directive, llms.txt fixes give the file with a link line per audited page, and answer-ready fixes add the paragraph under a question heading or the JSON-LD author and dates. `aeo.bot-probe-inconclusive` has no fix: it is about the audit.
