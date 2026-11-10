/**
 * The pages the Worker serves besides /mcp: the landing page (how to add the server, its limits,
 * what it cannot do, privacy, abuse), the page the User-Agent links to (what the requests are and
 * how to stop them), robots.txt and the favicon. They share the website's frame (ui/frame.ts).
 * The pages state the limits from wrangler.jsonc, so they cannot drift from what the Worker
 * enforces, and they pass the server's own audit.
 */
import { MAKER, REPOSITORY_URL } from "../../src/brand.js";
import { LOCAL_PRODUCT_TOKEN } from "../../src/core/fetch.js";
import { HOSTED_LIMITS, LOCAL_SERVER } from "../../src/core/hosted.js";
import { ORIGIN, rateLimit, SITE_ORIGIN, USER_AGENT } from "./limits.js";
import { DIRECTORY_PATH } from "./signing.js";
import { esc } from "./site/html.js";
import { scoreRing, severityChip } from "./site/report.js";
import { ABUSE_URL, frame, publisher } from "./ui/frame.js";
import type { FramePage } from "./ui/frame.js";
import { icon } from "./ui/icons.js";
import type { IconName } from "./ui/icons.js";
import { SERVER_CARD } from "./ui/og.js";

const MCP_URL = `${ORIGIN}/mcp`;

export { MARK_SVG as FAVICON_SVG } from "../../src/brand.js";

export const ROBOTS_TXT = "User-agent: *\nDisallow: /mcp\n";

/** How long Crawl-delay may hold up a hosted crawl, as the pages say it. */
const CRAWL_DELAY_BUDGET = `${HOSTED_LIMITS.crawlDelayBudgetMs / 1000} seconds`;

/** The server's own hostname, whose header offers the website's page audit. */
const SERVER = {
  origin: ORIGIN,
  action: { href: `${SITE_ORIGIN}/`, label: "Audit a page" },
  card: SERVER_CARD,
};

const layout = (page: FramePage): string => frame(SERVER, page);

const limitRow = (what: string, limit: string): string =>
  `<tr><th scope="row">${what}</th><td>${limit}</td></tr>`;

const perPeriod = (name: Parameters<typeof rateLimit>[0], noun: string) => {
  const { limit, period } = rateLimit(name);

  return `${limit} ${noun} a ${period}`;
};

const MB = (bytes: number): string => `${bytes / 1_000_000} MB`;

/** A command or a snippet to copy. */
const install = (text: string, prompt = false): string =>
  `<div class="install" data-copy>${prompt ? '<span class="prompt">$</span>' : ""}<code>${esc(text)}</code></div>`;

const snippet = (text: string): string =>
  `<pre data-copy><code>${esc(text)}</code></pre>`;

/**
 * An example conversation with an assistant that has the server, to show what it does. The tools,
 * rules and messages are the tool's own; the page and its numbers are made up.
 */
const CHAT = `<div class="wrap">
<div class="stage rise" style="--d:320ms">
<div class="stage-window fade-late">
<div class="window" role="img" aria-label="An example conversation: an assistant audits a page with the hosted server's tools, reports both scores and makes the edits the findings name" data-nosnippet>
<div class="window-bar"><span class="window-title">Your assistant</span><span class="window-actions"><span class="chip"><span class="dot" aria-hidden="true"></span>agentic-seo-check</span></span></div>
<div class="chat">
<p class="chat-user">Check example.com/pricing for search engines and AI answers, and fix what you find in the code.</p>
<p class="chat-tool">${icon("plug")}<span><b>seo_audit_page</b> url: "https://example.com/pricing"</span>${icon("check", "ok")}</p>
<p class="chat-tool">${icon("plug")}<span><b>seo_aeo_audit</b> url: "https://example.com/pricing"</span>${icon("check", "ok")}</p>
<div class="chat-reply">
<div class="chat-scores"><div class="mini-score">${scoreRing(82, "ring-sm")}<div><p class="score-name">SEO</p><p>3 warnings</p></div></div><div class="mini-score">${scoreRing(93, "ring-sm")}<div><p class="score-name">AEO</p><p>1 warning</p></div></div></div>
<p>I made the edits for the three SEO warnings:</p>
<ul class="chat-fixes">
<li>${icon("check")}<span><code>canonical.missing</code> a canonical link in the head</span></li>
<li>${icon("check")}<span><code>img.alt-missing</code> alt text for two images</span></li>
<li>${icon("check")}<span><code>meta-description.missing</code> a description of the page</span></li>
</ul>
<p><span class="sev-warning">${severityChip("warning")}</span> robots.txt blocks OAI-SearchBot, so ChatGPT search cannot cite the page. That is your call: shall I allow it?</p>
</div>
</div>
</div>
</div>
</div>
</div>`;

const CLIENTS: [name: string, how: string, code: string][] = [
  [
    "Claude Code",
    "Run this in a terminal:",
    install(
      `claude mcp add --transport http agentic-seo-check ${MCP_URL}`,
      true
    ),
  ],
  [
    "claude.ai, Cowork and the Claude apps",
    "In claude.ai, open Settings, then Connectors, and add a custom connector with this address. It needs no sign-in.",
    install(MCP_URL),
  ],
  [
    "ChatGPT",
    "Add a custom app (connector) with this address and no authentication. Custom apps need developer mode, under Settings, Apps, Advanced settings.",
    install(MCP_URL),
  ],
  [
    "Cursor",
    "In <code>.cursor/mcp.json</code>, or <code>~/.cursor/mcp.json</code> for every project:",
    snippet(
      `{ "mcpServers": { "agentic-seo-check": { "url": "${MCP_URL}" } } }`
    ),
  ],
  [
    "VS Code",
    "In <code>.vscode/mcp.json</code>:",
    snippet(
      `{ "servers": { "agentic-seo-check": { "type": "http", "url": "${MCP_URL}" } } }`
    ),
  ],
  [
    "Any other MCP client",
    "Add a server with this address over Streamable HTTP, with no authentication.",
    install(MCP_URL),
  ],
];

const TOOLS: [name: string, iconName: IconName, text: string][] = [
  [
    "seo_audit_page",
    "search",
    "Audits one page, from its URL or its HTML, and returns findings with fixes.",
  ],
  [
    "seo_crawl_site",
    "layers",
    "Crawls a site from a start URL and adds site-wide checks: robots.txt, sitemaps, broken links, duplicates, redirects.",
  ],
  [
    "seo_aeo_audit",
    "bot",
    "Checks a page or site for answer engines: AI crawler access, llms.txt, snippet controls, answer-ready content.",
  ],
  ["seo_list_rules", "list", "Lists every rule the audits report."],
];

/** What each server can do: the hosted one, then the local one. */
const COMPARISON: [what: string, hosted: boolean, local: boolean][] = [
  ["Public pages and sites: audits, crawls and answer engines", true, true],
  ["Works without Node on your machine", true, false],
  [
    "<code>localhost</code>, your network or other private addresses, or an IP address",
    false,
    true,
  ],
  [
    "A build directory such as <code>dist/</code> or <code>out/</code>",
    false,
    true,
  ],
  ["Pages rendered with JavaScript, and Lighthouse", false, true],
  ["A site behind a login, with your own headers or User-Agent", false, true],
  ["A request with each AI bot's User-Agent", false, true],
];

const mark = (yes: boolean): string =>
  yes
    ? `<span class="yes">${icon("check")}<span class="sr-only">Yes</span></span>`
    : `<span class="no">${icon("x")}<span class="sr-only">No</span></span>`;

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
      publisher,
    },
    body: `<section class="hero hero-glow" aria-labelledby="hero-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill rise"><span class="dot" aria-hidden="true"></span>Free, with no account and no key</p>
<h1 class="hero-title rise" id="hero-title" style="--d:60ms">SEO and AEO audits <span class="hero-accent">for your AI assistant, hosted.</span></h1>
<p class="lede rise" style="--d:120ms">agentic-seo-check audits pages and sites for search engines and AI answer engines, and gives every finding the exact fix. This is its MCP server, hosted by ${MAKER}: free to use, with no account and no key.</p>
</div>
<div class="endpoint rise" style="--d:180ms">
<p class="endpoint-label">The server's address</p>
${install(MCP_URL)}
<ul class="endpoint-facts"><li class="chip">${icon("check")}MCP over Streamable HTTP</li><li class="chip">${icon("check")}Read-only tools</li><li class="chip">${icon("check")}Obeys robots.txt</li></ul>
</div>
</div>
${CHAT}
</section>
<section class="section" id="add" aria-labelledby="add-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">Set up</p>
<h2 id="add-title">Add it to your assistant.</h2>
<p>One address for every client, with no sign-in. To audit a page or a whole site yourself, with no assistant, use the form on <a href="${SITE_ORIGIN}/">the agentic-seo-check website</a>, which also lists <a href="${SITE_ORIGIN}/rules">every rule</a>.</p>
</div>
<ul class="cards clients">${CLIENTS.map(([name, how, code]) => `<li class="card"><h3>${name}</h3><p>${how}</p>${code}</li>`).join("")}</ul>
</div>
</section>
<section class="section" aria-labelledby="tools-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">The tools</p>
<h2 id="tools-title">Four read-only tools.</h2>
<p>Ask your assistant to audit a page, crawl a site or check how answer engines see it; it answers with findings it can act on, such as a missing canonical, a broken internal link or robots.txt keeping out an AI crawler, each with the edits that fix it.</p>
</div>
<ul class="cards tools">${TOOLS.map(([name, iconName, text]) => `<li class="card"><span class="card-icon">${icon(iconName)}</span><h3><code>${name}</code></h3><p>${text}</p></li>`).join("")}</ul>
</div>
</section>
<section class="section" aria-labelledby="limits-title">
<div class="wrap split">
<div class="split-copy">
<p class="kicker">Fair use</p>
<h2 id="limits-title">Limits.</h2>
<p>The server is free for everyone, so it keeps each site and each caller to a fair share. A call past a limit gets an answer that names the limit and says when to try again.</p>
<p>The limits on calls and requests count per Cloudflare location and are approximate. <code>seo_list_rules</code> is not counted.</p>
</div>
<div class="spec"><table>
<thead><tr><th scope="col">What</th><th scope="col">Limit</th></tr></thead>
<tbody>
${limitRow("Requests to one site, from every caller together", perPeriod("SITE_REQUESTS", "requests"))}
${limitRow("Tool calls from one IP address", `${perPeriod("CALLER_CALLS", "calls")}, ${perPeriod("CALLER_CRAWLS", "crawls")} among them`)}
${limitRow("Tool calls from claude.ai or ChatGPT, each counted as one caller", `${perPeriod("PLATFORM_CALLS", "calls")}, ${perPeriod("PLATFORM_CRAWLS", "crawls")} among them`)}
${limitRow("Requests to all sites together", `${dailyRequests.toLocaleString("en")} a day; then audits of inline HTML still work until 00:00 UTC`)}
${limitRow("A crawl", `${HOSTED_LIMITS.maxPages} pages, ${HOSTED_LIMITS.maxDepth} links deep, ${HOSTED_LIMITS.maxLinkChecks} link checks, ${HOSTED_LIMITS.maxSitemaps} sitemaps of up to ${MB(HOSTED_LIMITS.maxSitemapBytes)}`)}
${limitRow("A page", `the first ${MB(HOSTED_LIMITS.maxBodyBytes)} of its HTML, within ${HOSTED_LIMITS.timeoutMs / 1000} seconds`)}
</tbody>
</table></div>
</div>
</section>
<section class="section" aria-labelledby="local-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">Hosted or local</p>
<h2 id="local-title">What it cannot do.</h2>
<p>The server runs on Cloudflare's network, not on your machine. For what it cannot do, run the local server, which does all of it from your own machine.</p>
</div>
<div class="compare-wrap"><table class="compare">
<thead><tr><th scope="col">What</th><th scope="col">Hosted</th><th scope="col">Local</th></tr></thead>
<tbody>${COMPARISON.map(([what, hosted, local]) => `<tr><th scope="row">${what}</th><td>${mark(hosted)}</td><td>${mark(local)}</td></tr>`).join("")}</tbody>
</table></div>
<div class="local-run"><p>The local server, from the npm package:</p>${install(LOCAL_SERVER, true)}</div>
</div>
</section>
<section class="section section-tight" aria-labelledby="trust-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">Trust</p>
<h2 id="trust-title">A well-behaved bot.</h2>
</div>
<div class="rows">
<div class="row" id="robots"><h3>robots.txt</h3><div class="row-body"><p>The server obeys robots.txt for every request it sends, an audit of one page included: the group for <code>agentic-seo-check</code>, or <code>*</code> when there is none. A crawl waits between requests to a site as its <code>Crawl-delay</code> asks, for at most ${CRAWL_DELAY_BUDGET} in all. When robots.txt keeps it out, or a site turns it away, the server says so and requests nothing more there.</p></div></div>
<div class="row" id="privacy"><h3>Privacy</h3><div class="row-body"><p>The server keeps no HTML you send, no reports and no headers. For each tool call, and each run of the website's page audit, it records the tool, the outcome, the duration, the number of requests and pages, and the hostname it audited, so that a report about too many requests to a site can be checked against what the server sent there. It records the hostname only, never the path or the query, and never your IP address. Records are kept for three months. The server runs on Cloudflare, which processes the requests for ${MAKER}.</p></div></div>
<div class="row" id="requests"><h3>Requests to your site</h3><div class="row-body"><p>If this server has requested your site, <a href="/crawler">the page for site owners</a> says what the requests are and how to stop them. Report abuse, such as too many requests to one site, through <a href="${ABUSE_URL}">help.rivi.software/contact</a>.</p></div></div>
</div>
</div>
</section>`,
  });

const RECOGNISE: [iconName: IconName, title: string, text: string][] = [
  [
    "shield",
    "robots.txt first",
    "Every audit reads it before anything else, and obeys it.",
  ],
  [
    "signature",
    "Signed",
    "Requests over https carry a Web Bot Auth signature.",
  ],
  [
    "clock",
    "Paced",
    `At most ${perPeriod("SITE_REQUESTS", "requests")} to one site.`,
  ],
  ["bot", "Started by a person", "The server never crawls the web on its own."],
];

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
      publisher,
    },
    body: `<section class="hero hero-glow hero-split" aria-labelledby="crawler-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill rise"><span class="dot" aria-hidden="true"></span>For site owners</p>
<h1 class="hero-title rise" id="crawler-title" style="--d:60ms"><span class="nowrap">agentic-seo-check</span> requests to your site</h1>
</div>
<p class="lede rise" style="--d:120ms">Someone asked their AI assistant to audit your site for search engines or AI answer engines, or entered one of its pages, or its homepage, in the form on <a href="${SITE_ORIGIN}/">the agentic-seo-check website</a>. Both use the hosted agentic-seo-check server, run by ${MAKER}. Every request is part of an audit a person started; the server does not crawl the web on its own.</p>
</div>
</section>
<section class="section section-tight" aria-label="The requests at a glance">
<div class="wrap">
<ul class="facts-strip">${RECOGNISE.map(([iconName, title, text]) => `<li>${icon(iconName)}<span><strong>${title}</strong>${text}</span></li>`).join("")}</ul>
</div>
</section>
<section class="section section-tight" aria-label="The requests in detail">
<div class="wrap">
<div class="rows">
<div class="row" id="requests"><h2>What the requests are</h2><div class="row-body"><p>Every audit reads robots.txt first and obeys it: the group for <code>agentic-seo-check</code>, or <code>*</code> when there is none. An audit of one page is then one request, plus any redirects; the website's form audits one page for search engines and for answer engines, which also reads llms.txt, and crawls the site when it is given the homepage. A crawl requests up to ${HOSTED_LIMITS.maxPages} pages, up to ${HOSTED_LIMITS.maxSitemaps} sitemaps and up to ${HOSTED_LIMITS.maxLinkChecks} link and image targets: about 150 requests. It waits between requests as <code>Crawl-delay</code> asks, and stops once those waits add up to more than ${CRAWL_DELAY_BUDGET}, every site's together. The server sends at most ${perPeriod("SITE_REQUESTS", "requests")} to one hostname, from all its callers together. A 429 or a challenge page ends its requests to the site, and a 403 those to the page: it does not retry, and sends no other User-Agent.</p></div></div>
<div class="row" id="recognise"><h2>How to recognise them</h2><div class="row-body">
<p>The requests carry this User-Agent:</p>
${snippet(USER_AGENT)}
<p>Each one over https is signed with <a href="https://datatracker.ietf.org/doc/html/rfc9421">HTTP Message Signatures</a>, as Web Bot Auth asks: it carries <code>Signature-Agent: "${ORIGIN}"</code> and the headers <code>Signature-Input</code> and <code>Signature</code>, made with an Ed25519 key that <a href="${DIRECTORY_PATH}">the key directory</a> lists. A request over https without a valid signature did not come from this server, whatever its User-Agent says. Requests over plain http go unsigned, since anyone on their path could copy a signature and send it again.</p>
<p>They come from Cloudflare's network, with the header <code>CF-Worker: rivi.software</code>. A site on Cloudflare sees them with the address <code>2a06:98c0:3600::103</code>, which every Cloudflare Worker shares.</p>
<p>The User-Agent <code>${LOCAL_PRODUCT_TOKEN}</code> is the same tool run on someone's own machine, as a command or a local MCP server. Its requests come from that machine, unsigned, and its crawls obey a robots.txt group for <code>${LOCAL_PRODUCT_TOKEN}</code>, or <code>*</code>.</p>
</div></div>
<div class="row" id="block"><h2>How to block them</h2><div class="row-body">
<ul class="blocks">
<li class="card"><h3>In robots.txt</h3><p>A group for the product token keeps the server out: every audit reads it before anything else.</p><pre data-copy><code>User-agent: agentic-seo-check
Disallow: /</code></pre><p>Add a <code>User-agent: ${LOCAL_PRODUCT_TOKEN}</code> line to the group to keep out crawls run from people's own machines too.</p></li>
<li class="card"><h3>In a firewall</h3><p>Block requests whose User-Agent contains <code>agentic-seo-check</code>, which both product tokens do.</p></li>
<li class="card"><h3>On Cloudflare</h3><p>A WAF custom rule on <code>cf.worker.upstream_zone eq "rivi.software"</code> blocks the server, and with it every other Worker on rivi.software.</p></li>
</ul>
</div></div>
<div class="row" id="abuse"><h2>Report abuse</h2><div class="row-body">
<p>If the server sends your site more requests than it should, or requests you did not expect, tell us through <a href="${ABUSE_URL}">help.rivi.software/contact</a>, with the hostname and the time, in UTC. The server records the hostname of every audit for three months, so we can check what it sent.</p>
<p>agentic-seo-check is open source: read <a href="${REPOSITORY_URL}">its code on GitHub</a>, or see <a href="/">the hosted server's page</a>.</p>
</div></div>
</div>
</div>
</section>`,
  });

export const notFoundPage = (): string =>
  layout({
    path: "/404",
    title: "Not found | agentic-seo-check hosted MCP server",
    description:
      "This address is not part of the agentic-seo-check hosted MCP server.",
    data: { "@type": "WebPage", name: "Not found" },
    body: `<section class="hero hero-glow notfound" aria-labelledby="notfound-title">
<div class="wrap">
<div class="hero-copy">
<p class="notfound-code">404</p>
<h1 id="notfound-title">Not found.</h1>
<p class="lede">This address is not part of the agentic-seo-check hosted MCP server. The server itself is at <code>${MCP_URL}</code>; <a href="/">its page</a> says how to use it.</p>
</div>
</div>
</section>`,
  });
