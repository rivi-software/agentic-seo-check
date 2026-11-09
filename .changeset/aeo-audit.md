---
"@rivi-software/agentic-seo-check": minor
---

Add an AEO (answer engine optimization) audit: the `agentic-seo-check aeo <target>` command and the `seo_aeo_audit` MCP tool check whether AI answer engines can reach, quote and trust a page, a crawled site or build output, with a separate score and 30 `aeo.*` rules. It reads robots.txt per AI crawler (search crawlers, answer bots such as OAI-SearchBot and PerplexityBot, training bots such as GPTBot), Content-Signal lines, the shared `__usage_ai-training` opt-out and `/llms.txt`; snippet and AI opt-outs (nosnippet, max-snippet, Bing's noarchive and nocache for Copilot, noai, data-nosnippet); answer-ready content (empty JavaScript app shells, questions without a direct answer, FAQ/HowTo markup the page does not show); and article authors, dates and entities. `--ai-bots` also requests the page with each AI bot's User-Agent to catch CDN or firewall blocks. The SEO audit and its score are unchanged.
