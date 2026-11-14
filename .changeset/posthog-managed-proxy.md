---
"@rivi-software/agentic-seo-check": patch
---

The CLI and the local MCP server send their usage analytics and error reports to `https://g.rivi.software`, the reverse proxy PostHog runs for RIVI Software, which forwards them to the same EU project. Before, they went to `https://eu.i.posthog.com`. What an event carries, and the ways to turn it off, are unchanged.
