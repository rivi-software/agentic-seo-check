---
"@rivi-software/agentic-seo-check": minor
---

Playwright now installs with the tool as an optional dependency instead of being a peer, so `--render` works under `npx` and in a global install on any machine with Google Chrome or Edge. The new `install-browser` command downloads the Chromium build that the bundled Playwright expects, for a machine without Chrome (`npx @rivi-software/agentic-seo-check install-browser`; `--with-deps` also installs Chromium's system libraries on Linux).

Lighthouse and chrome-launcher stay optional peers, since they add some 180 MB to every install. `tool.lighthouse-unavailable` now gives the command that adds them in a project, in a global install and with `npx -p`, and both `tool.*` findings point to `install-browser` when no Chromium launches.
