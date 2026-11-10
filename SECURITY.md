# Security

This policy covers the code in this repository: the `@rivi-software/agentic-seo-check` package on npm, its `agentic-seo-check` command line tool and `agentic-seo-check-mcp` MCP server, the hosted MCP server that RIVI Software runs at `https://mcp.agentic-seo.rivi.software/mcp` from [`hosted/`](hosted/), the `seo-audit` agent skill, and the workflows that test, review, release and deploy them.

Abuse of the hosted server, such as too many requests to one site or requests you did not expect, is not a vulnerability: report it through [help.rivi.software/contact](https://help.rivi.software/contact), with the hostname and the time in UTC. [The page for site owners](https://mcp.agentic-seo.rivi.software/crawler) says how to recognise and block its requests.

## Reporting a vulnerability

Report it privately, in either of two ways:

- [Report a vulnerability](https://github.com/rivi-software/agentic-seo-check/security/advisories/new) on GitHub, which opens a draft advisory only you and the maintainers see.
- Email **[oss-cybersecurity@rivi.software](mailto:oss-cybersecurity@rivi.software)**.

Do not open a public issue, pull request or discussion about it, and do not publish it before a fix is out.

Include what you can of:

- The version, or the commit
- What an attacker can do with it, and what they need first: a page they control, an option the user sets, the user's action
- How to reproduce it: steps, a proof of concept or a failing test
- A fix, if you have one in mind
- The name to credit, or that you would rather not be credited

Send one report per issue. If you are not sure whether something is a vulnerability, or whether it is in scope, report it anyway.

## What happens next

- We acknowledge your report within 3 working days.
- Within 10 working days, we tell you whether we can reproduce it, how serious we think it is and what we will do about it.
- We keep you posted until it is fixed, and agree with you when it goes public. We aim to release a fix within 90 days of your report, and sooner for a serious one.
- With the fix, we publish a [GitHub security advisory](https://github.com/rivi-software/agentic-seo-check/security/advisories), with a CVE where one applies, and credit you unless you would rather not be.

There is no bug bounty.

## Supported versions

Only the latest published version gets fixes. A fix comes out as a new version: upgrade to get it. The hosted server deploys with each release, so it always runs the latest version.

## Scope

The tool reads what it is pointed at: a URL and the pages it links to, a directory of built HTML, or HTML it is handed. Every audited page is untrusted input. In scope, for example:

- A page, a `robots.txt`, a sitemap or a response header that makes the tool do more than read and report: write a file, run a command, run code outside the headless browser's page, or reach a host the crawl's rules exclude.
- A page that makes an audit hang or use memory or CPU out of all proportion to its size, such as markup or a sitemap that sends a regular expression or a parser into a loop.
- A secret the user passes, such as a value in `headers`, that the tool sends to another origin than the one it audits, or writes into a report.
- A way to run code, read a secret or write to this repository through its workflows, for example from a pull request from a fork.
- A way to publish the package to npm, or to move or delete a release tag, without a maintainer.
- On the hosted server: a way past its URL rules (to `localhost`, a private network, an IP address, another scheme), a way to see or change another caller's input or results, or a way past its limits per site, per caller or per day that makes it send far more than they allow. The limits are approximate and counted per Cloudflare location, so a small overshoot is expected.
- A way to deploy to the hosted server, or to reach its Cloudflare token, without a maintainer.

Out of scope:

- Text from an audited page that shows up in a report. Findings quote the page (titles, descriptions, link text, structured data) on purpose, so an agent that reads a report reads text the page's author wrote. Treat a report as untrusted data, as you would the page itself.
- What a page's own JavaScript does in the headless browser with `--render` or `--lighthouse`. That is a browser running a web page, and the sandbox is Chromium's.
- Reading files the user points the tool at, such as a directory with `seo_audit_directory`. The MCP server runs with the rights of the user who starts it.
- A vulnerability in a dependency that the tool does not expose. Report it upstream; if the tool does expose it, tell us.
- An attack that first needs a maintainer's account, machine or credentials.
- Scanner output, a missing best practice or a version number on show, without a way to exploit it.

## Testing

Test against your own copy and your own sites: a fork, a local checkout, and pages and servers you control.

- Do not open pull requests or issues here to try an attack on the workflows. Reproduce it in a fork, with your own secrets.
- Do not point the crawler at sites you do not own or have permission to test, through the hosted server or otherwise.
- Do not load-test the hosted server or try its limits at scale: run your own copy of the Worker in `hosted/` (`pnpm run hosted:dev`) instead.
- Do not publish to, or tamper with, `@rivi-software/agentic-seo-check` on npm.
- No denial of service, spam or social engineering of maintainers.

## Safe harbor

If you research and report a vulnerability in good faith and follow this policy, we consider your research authorized, we will not take legal action against you over it, and if someone else does, we will make it known that you acted within this policy.

## Verifying a release

Versions after 0.1.0 are published by the release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)), from `main`, through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) with provenance. npm shows the commit and the workflow run each version was built from, and `npm audit signatures` checks the signatures and provenance of the packages you installed.

0.1.0 is the exception: a maintainer published it by hand, because npm adds a trusted publisher only to a package that already exists. It has no provenance.

Release tags (`v<version>`) are never moved or deleted. A version after 0.1.0 without provenance, or with provenance from another repository or workflow, did not come from us: report it.
