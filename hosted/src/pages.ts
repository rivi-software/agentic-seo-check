/**
 * The pages the Worker serves besides /mcp: the landing page (how to add the server, its limits,
 * what it cannot do, privacy, abuse), the page the User-Agent links to (what the requests are and
 * how to stop them), robots.txt and the favicon. The pages state the limits from wrangler.jsonc,
 * so they cannot drift from what the Worker enforces, and they pass the server's own audit.
 */
import { MAKER, MAKER_URL, REPOSITORY_URL } from "../../src/brand.js";
import { LOCAL_PRODUCT_TOKEN } from "../../src/core/fetch.js";
import { HOSTED_LIMITS, LOCAL_SERVER } from "../../src/core/hosted.js";
import type {
  JsonObject,
  JsonValue,
} from "../../src/core/html/structured-data.js";
import { ORIGIN, rateLimit, SITE_ORIGIN, USER_AGENT } from "./limits.js";
import { DIRECTORY_PATH } from "./signing.js";

export const ABUSE_URL = "https://help.rivi.software/contact";

const MCP_URL = `${ORIGIN}/mcp`;

export { MARK_SVG as FAVICON_SVG } from "../../src/brand.js";

export const ROBOTS_TXT = "User-agent: *\nDisallow: /mcp\n";

/** How long Crawl-delay may hold up a hosted crawl, as the pages say it. */
const CRAWL_DELAY_BUDGET = `${HOSTED_LIMITS.crawlDelayBudgetMs / 1000} seconds`;

const STYLE = `
:root{color-scheme:light dark;--ink:#15171a;--paper:#fbfbfa;--muted:#5b6068;--line:#dcdfe3;--green:#0e9f55;--code:#f0f2f4}
@media (prefers-color-scheme:dark){:root{--ink:#eceef1;--paper:#111315;--muted:#a3a9b1;--line:#2c3036;--green:#3be08a;--code:#1b1e22}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main,footer{max-width:46rem;margin:0 auto;padding:0 1rem}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:1.25rem;padding-bottom:1.25rem}
header a.brand{display:flex;align-items:center;gap:.6rem;font-weight:650;color:var(--ink);text-decoration:none}
nav a{margin-left:1rem}
a{color:var(--green)}
h1{font-size:2rem;line-height:1.2;margin:1.5rem 0 .75rem}
h2{font-size:1.3rem;margin:2.5rem 0 .5rem;padding-top:1rem;border-top:1px solid var(--line)}
h3{font-size:1.05rem;margin:1.5rem 0 .25rem}
code,pre{font:15px/1.5 ui-monospace,"SF Mono",Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:.1rem .3rem}
pre{padding:.75rem 1rem;overflow-x:auto}
pre code{padding:0;background:none}
table{border-collapse:collapse;width:100%;margin:.5rem 0}
th,td{text-align:left;vertical-align:top;padding:.45rem .5rem;border-bottom:1px solid var(--line)}
.lead{font-size:1.15rem;color:var(--muted)}
footer{margin-top:3rem;padding-top:1.5rem;padding-bottom:2rem;border-top:1px solid var(--line);color:var(--muted);font-size:.95rem}
`;

/** JSON for a <script> element: "<" escaped, so no text in it can close the element. */
const scriptJson = (value: JsonValue): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

const PUBLISHER_ID = `${MAKER_URL}/#organization`;

const ORGANIZATION: JsonObject = {
  "@type": "Organization",
  "@id": PUBLISHER_ID,
  name: MAKER,
  url: MAKER_URL,
  logo: `${ORIGIN}/favicon.svg`,
  sameAs: ["https://github.com/rivi-software"],
};

interface Page {
  path: string;
  title: string;
  description: string;
  /** The page's own structured data, beside the publisher. */
  data: JsonObject;
  body: string;
}

const layout = (page: Page): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="canonical" href="${ORIGIN}${page.path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="agentic-seo-check">
<meta property="og:title" content="${page.title}">
<meta property="og:description" content="${page.description}">
<meta property="og:url" content="${ORIGIN}${page.path}">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${scriptJson({
  "@context": "https://schema.org",
  "@graph": [ORGANIZATION, page.data],
})}</script>
<style>${STYLE}</style>
</head>
<body>
<header>
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="28" height="28">agentic-seo-check</a>
<nav aria-label="Pages"><a href="/">Hosted server</a><a href="/crawler">For site owners</a></nav>
</header>
<main>
${page.body}
</main>
<footer>
<p>agentic-seo-check is open source (MIT) and made by <a href="${MAKER_URL}">${MAKER}</a>. Code, issues and the local server: <a href="${REPOSITORY_URL}">github.com/rivi-software/agentic-seo-check</a>. Report abuse of the hosted server through <a href="${ABUSE_URL}">help.rivi.software/contact</a>.</p>
</footer>
</body>
</html>
`;

const limitRow = (what: string, limit: string): string =>
  `<tr><td>${what}</td><td>${limit}</td></tr>`;

const perPeriod = (name: Parameters<typeof rateLimit>[0], noun: string) => {
  const { limit, period } = rateLimit(name);

  return `${limit} ${noun} a ${period}`;
};

const MB = (bytes: number): string => `${bytes / 1_000_000} MB`;

/** The landing page at /, with the limits of `dailyRequests` and wrangler.jsonc. */
export const landingPage = (dailyRequests: number): string =>
  layout({
    path: "/",
    title: "agentic-seo-check hosted MCP server | RIVI Software",
    description:
      "A free hosted MCP server that audits pages and sites for search engines and AI answer engines. Add it to Claude, ChatGPT, Cursor or VS Code, no account needed.",
    data: {
      "@type": "WebApplication",
      name: "agentic-seo-check hosted MCP server",
      url: `${ORIGIN}/`,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      isAccessibleForFree: true,
      publisher: { "@id": PUBLISHER_ID },
    },
    body: `<h1>SEO and AEO audits for your AI assistant, hosted</h1>
<p class="lead">agentic-seo-check audits pages and sites for search engines and AI answer engines, and gives every finding the exact fix. This is its MCP server, hosted by ${MAKER}: free to use, with no account and no key.</p>
<p>The server's address:</p>
<pre><code>${MCP_URL}</code></pre>
<p>To audit one page yourself, with no assistant, use the form on <a href="${SITE_ORIGIN}/">the agentic-seo-check website</a>, which also lists <a href="${SITE_ORIGIN}/rules">every rule</a>.</p>
<p>It speaks MCP over Streamable HTTP. Ask your assistant to audit a page, crawl a site or check how answer engines see it; it answers with findings it can act on, such as a missing canonical, a broken internal link or robots.txt keeping out an AI crawler, each with the edits that fix it.</p>

<h2>Add it to your assistant</h2>
<h3>Claude Code</h3>
<pre><code>claude mcp add --transport http agentic-seo-check ${MCP_URL}</code></pre>
<h3>claude.ai, Cowork and the Claude apps</h3>
<p>In claude.ai, open Settings, then Connectors, and add a custom connector with the address above. It needs no sign-in.</p>
<h3>ChatGPT</h3>
<p>Add a custom app (connector) with the address above and no authentication. Custom apps need developer mode, under Settings, Apps, Advanced settings.</p>
<h3>Cursor</h3>
<p>In <code>.cursor/mcp.json</code>, or <code>~/.cursor/mcp.json</code> for every project:</p>
<pre><code>{ "mcpServers": { "agentic-seo-check": { "url": "${MCP_URL}" } } }</code></pre>
<h3>VS Code</h3>
<p>In <code>.vscode/mcp.json</code>:</p>
<pre><code>{ "servers": { "agentic-seo-check": { "type": "http", "url": "${MCP_URL}" } } }</code></pre>

<h2>The tools</h2>
<table>
<thead><tr><th>Tool</th><th>What it does</th></tr></thead>
<tbody>
<tr><td><code>seo_audit_page</code></td><td>Audits one page, from its URL or its HTML, and returns findings with fixes.</td></tr>
<tr><td><code>seo_crawl_site</code></td><td>Crawls a site from a start URL and adds site-wide checks: robots.txt, sitemaps, broken links, duplicates, redirects.</td></tr>
<tr><td><code>seo_aeo_audit</code></td><td>Checks a page or site for answer engines: AI crawler access, llms.txt, snippet controls, answer-ready content.</td></tr>
<tr><td><code>seo_list_rules</code></td><td>Lists every rule the audits report.</td></tr>
</tbody>
</table>

<h2>Limits</h2>
<p>The server is free for everyone, so it keeps each site and each caller to a fair share. A call past a limit gets an answer that names the limit and says when to try again.</p>
<table>
<thead><tr><th>What</th><th>Limit</th></tr></thead>
<tbody>
${limitRow("Requests to one site, from every caller together", perPeriod("SITE_REQUESTS", "requests"))}
${limitRow("Tool calls from one IP address", `${perPeriod("CALLER_CALLS", "calls")}, ${perPeriod("CALLER_CRAWLS", "crawls")} among them`)}
${limitRow("Tool calls from claude.ai or ChatGPT, each counted as one caller", `${perPeriod("PLATFORM_CALLS", "calls")}, ${perPeriod("PLATFORM_CRAWLS", "crawls")} among them`)}
${limitRow("Requests to all sites together", `${dailyRequests.toLocaleString("en")} a day; then audits of inline HTML still work until 00:00 UTC`)}
${limitRow("A crawl", `${HOSTED_LIMITS.maxPages} pages, ${HOSTED_LIMITS.maxDepth} links deep, ${HOSTED_LIMITS.maxLinkChecks} link checks, ${HOSTED_LIMITS.maxSitemaps} sitemaps of up to ${MB(HOSTED_LIMITS.maxSitemapBytes)}`)}
${limitRow("A page", `the first ${MB(HOSTED_LIMITS.maxBodyBytes)} of its HTML, within ${HOSTED_LIMITS.timeoutMs / 1000} seconds`)}
</tbody>
</table>
<p>The limits on calls and requests count per Cloudflare location and are approximate. <code>seo_list_rules</code> is not counted.</p>

<h2>What it cannot do</h2>
<p>The server runs on Cloudflare's network, not on your machine, so it cannot:</p>
<ul>
<li>reach <code>localhost</code>, your network or other private addresses, or request an IP address;</li>
<li>read a build directory such as <code>dist/</code> or <code>out/</code>;</li>
<li>render pages with JavaScript, or run Lighthouse;</li>
<li>audit a site behind a login, or send your own headers or User-Agent;</li>
<li>request a page with each AI bot's User-Agent.</li>
</ul>
<p>For all of this, run the local server, which does everything above from your own machine:</p>
<pre><code>${LOCAL_SERVER}</code></pre>

<h2>robots.txt</h2>
<p>The server obeys robots.txt for every request it sends, an audit of one page included: the group for <code>agentic-seo-check</code>, or <code>*</code> when there is none. A crawl waits between requests to a site as its <code>Crawl-delay</code> asks, for at most ${CRAWL_DELAY_BUDGET} in all. When robots.txt keeps it out, or a site turns it away, the server says so and requests nothing more there.</p>

<h2>Privacy</h2>
<p>The server keeps no HTML you send, no reports and no headers. For each tool call, and each run of the website's page audit, it records the tool, the outcome, the duration, the number of requests and pages, and the hostname it audited, so that a report about too many requests to a site can be checked against what the server sent there. It records the hostname only, never the path or the query, and never your IP address. Records are kept for three months. The server runs on Cloudflare, which processes the requests for ${MAKER}.</p>

<h2>Requests to your site</h2>
<p>If this server has requested your site, <a href="/crawler">the page for site owners</a> says what the requests are and how to stop them. Report abuse, such as too many requests to one site, through <a href="${ABUSE_URL}">help.rivi.software/contact</a>.</p>`,
  });

/** The page at /crawler, which the User-Agent of every request links to. */
export const crawlerPage = (): string =>
  layout({
    path: "/crawler",
    title: "agentic-seo-check requests to your site | RIVI Software",
    description:
      "What the agentic-seo-check requests to your site are, how to recognise them, what limits they keep and how to block them or report abuse.",
    data: {
      "@type": "WebPage",
      name: "agentic-seo-check requests to your site",
      url: `${ORIGIN}/crawler`,
      publisher: { "@id": PUBLISHER_ID },
    },
    body: `<h1>agentic-seo-check requests to your site</h1>
<p class="lead">Someone asked their AI assistant to audit your site for search engines or AI answer engines, or entered one of its pages in the form on <a href="${SITE_ORIGIN}/">the agentic-seo-check website</a>. Both use the hosted agentic-seo-check server, run by ${MAKER}. Every request is part of an audit a person started; the server does not crawl the web on its own.</p>

<h2>What the requests are</h2>
<p>Every audit reads robots.txt first and obeys it: the group for <code>agentic-seo-check</code>, or <code>*</code> when there is none. An audit of one page is then one request, plus any redirects; the website's form audits one page for search engines and for answer engines, which also reads llms.txt. A crawl requests up to ${HOSTED_LIMITS.maxPages} pages, up to ${HOSTED_LIMITS.maxSitemaps} sitemaps and up to ${HOSTED_LIMITS.maxLinkChecks} link and image targets: about 150 requests. It waits between requests as <code>Crawl-delay</code> asks, and stops once those waits add up to more than ${CRAWL_DELAY_BUDGET}, every site's together. The server sends at most ${perPeriod("SITE_REQUESTS", "requests")} to one hostname, from all its callers together. A 429 or a challenge page ends its requests to the site, and a 403 those to the page: it does not retry, and sends no other User-Agent.</p>

<h2>How to recognise them</h2>
<p>The requests carry this User-Agent:</p>
<pre><code>${USER_AGENT}</code></pre>
<p>Each one over https is signed with <a href="https://datatracker.ietf.org/doc/html/rfc9421">HTTP Message Signatures</a>, as Web Bot Auth asks: it carries <code>Signature-Agent: "${ORIGIN}"</code> and the headers <code>Signature-Input</code> and <code>Signature</code>, made with an Ed25519 key that <a href="${DIRECTORY_PATH}">the key directory</a> lists. A request over https without a valid signature did not come from this server, whatever its User-Agent says. Requests over plain http go unsigned, since anyone on their path could copy a signature and send it again.</p>
<p>They come from Cloudflare's network, with the header <code>CF-Worker: rivi.software</code>. A site on Cloudflare sees them with the address <code>2a06:98c0:3600::103</code>, which every Cloudflare Worker shares.</p>
<p>The User-Agent <code>${LOCAL_PRODUCT_TOKEN}</code> is the same tool run on someone's own machine, as a command or a local MCP server. Its requests come from that machine, unsigned, and its crawls obey a robots.txt group for <code>${LOCAL_PRODUCT_TOKEN}</code>, or <code>*</code>.</p>

<h2>How to block them</h2>
<ul>
<li>In robots.txt, a group for the product token keeps the server out: every audit reads it before anything else.
<pre><code>User-agent: agentic-seo-check
Disallow: /</code></pre>
Add a <code>User-agent: ${LOCAL_PRODUCT_TOKEN}</code> line to the group to keep out crawls run from people's own machines too.</li>
<li>In a firewall, block requests whose User-Agent contains <code>agentic-seo-check</code>, which both product tokens do.</li>
<li>On Cloudflare, a WAF custom rule on <code>cf.worker.upstream_zone eq "rivi.software"</code> blocks the server, and with it every other Worker on rivi.software.</li>
</ul>

<h2>Report abuse</h2>
<p>If the server sends your site more requests than it should, or requests you did not expect, tell us through <a href="${ABUSE_URL}">help.rivi.software/contact</a>, with the hostname and the time, in UTC. The server records the hostname of every audit for three months, so we can check what it sent.</p>
<p>agentic-seo-check is open source: read <a href="${REPOSITORY_URL}">its code on GitHub</a>, or see <a href="/">the hosted server's page</a>.</p>`,
  });

export const notFoundPage = (): string =>
  layout({
    path: "/404",
    title: "Not found | agentic-seo-check hosted MCP server",
    description:
      "This address is not part of the agentic-seo-check hosted MCP server.",
    data: { "@type": "WebPage", name: "Not found" },
    body: `<h1>Not found</h1>
<p>This address is not part of the agentic-seo-check hosted MCP server. The server itself is at <code>${MCP_URL}</code>; <a href="/">its page</a> says how to use it.</p>`,
  });
