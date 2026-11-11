/**
 * The website's homepage: what Agentic SEO Check is, the page audit to run in the browser, what it
 * checks and how to give it to a coding agent. An answer of the audit form is this page again,
 * with the report, or the reason there is none, in place of the example report.
 */
import { MAKER, PRODUCT_NAME, REPOSITORY_URL } from "../../../src/brand.js";
import { AI_BOTS } from "../../../src/core/aeo/bots.js";
import { HOSTED_LIMITS, LOCAL_SERVER } from "../../../src/core/hosted.js";
import { AEO_RULES, SEO_RULES } from "../../../src/core/rules/index.js";
import type { Category, Severity } from "../../../src/core/types.js";
import { ORIGIN as MCP_ORIGIN, rateLimit } from "../limits.js";
import {
  CLAUDE_DIRECTORY_URL,
  directoryBadge,
  PRIVACY_URL,
} from "../ui/frame.js";
import { GITHUB_MARK, icon } from "../ui/icons.js";
import type { IconName } from "../ui/icons.js";
import { esc } from "./html.js";
import {
  HOSTED_PAGE,
  layout,
  NPM_URL,
  publisher,
  SITE_ORIGIN,
} from "./layout.js";
import { PURPOSE_LABEL, scoreRing, severityChip } from "./report.js";

/**
 * What kind of refusal the form answered with, as the page's `audit_failed` event names it (issue
 * #57): the address, the check that keeps bots out, a limit, the form switched off, the site's
 * refusal, or any other failure of the audit.
 */
export type FailureKind =
  | "address"
  | "check"
  | "limit"
  | "paused"
  | "refused"
  | "fetch";

/** The name of each rule category, as the homepage and the rules page head it. */
export const CATEGORY_LABEL: Record<Category, string> = {
  title: "Titles",
  meta: "Meta descriptions",
  headings: "Headings",
  canonical: "Canonical URLs",
  indexing: "Indexing and robots",
  document: "The document",
  social: "Open Graph and Twitter cards",
  images: "Images",
  links: "Links",
  international: "hreflang and languages",
  "structured-data": "Structured data",
  content: "Content",
  keyword: "Keywords",
  response: "The HTTP response",
  rendering: "JavaScript rendering",
  performance: "Performance",
  site: "Site-wide checks",
  aeo: "AI answer engines",
  tool: "The audit itself",
};

export interface HomeState {
  /** The audit form is on: Turnstile is set up and the server is not paused. */
  open: boolean;
  /** The form crawls a site from its homepage: crawls are not off. */
  crawls: boolean;
  /** Turnstile's public site key, for the form's widget. */
  siteKey: string;
  /** The URL in the field: the one just audited, or one a link filled in. */
  url?: string;
  /** Why there is no report, in the words of the refusal. */
  error?: string;
  /** What kind of refusal `error` is, for the page's `audit_failed` event (issue #57). */
  failure?: FailureKind;
  /** The report of the audit just run (report.ts, site-report.ts). */
  report?: string;
  /** A crawl is running, and its answer streams in: the form waits for it. */
  crawling?: boolean;
}

const AUDIT_COMMAND =
  "npx @rivi-software/agentic-seo-check audit https://example.com";

/** What the form does, under it. */
const formFacts = (crawls: boolean): string[] => {
  const calls = rateLimit("CALLER_CALLS");
  const crawlLimit = rateLimit("CALLER_CRAWLS");
  const mb = HOSTED_LIMITS.maxBodyBytes / 1_000_000;

  return crawls
    ? [
        "A public page, or a whole site from its homepage",
        `Up to ${HOSTED_LIMITS.maxPages} pages a site, ${mb} MB of HTML each`,
        `${calls.limit} runs a ${calls.period} per address, ${crawlLimit.limit} of them sites`,
        "Reads the HTML the server sends, without running its JavaScript",
      ]
    : [
        "One public page per run",
        `The first ${mb} MB of its HTML`,
        `${calls.limit} runs a ${calls.period} per address`,
        "Reads the HTML the server sends, without running its JavaScript",
      ];
};

/** The form's button: busy, and off, while a crawl's answer streams in. */
const submitButton = (crawling: boolean): string =>
  `<button class="btn btn-primary btn-lg${crawling ? " is-busy" : ""}" type="submit"${crawling ? " disabled" : ""}><span class="btn-label" data-idle="Run the audit">${crawling ? "Crawling the site…" : "Run the audit"}</span>${icon("arrow", "arrow")}</button>`;

const auditForm = (state: HomeState): string => {
  if (!state.open) {
    return `<div class="audit audit-off rise" style="--d:180ms" id="audit">
<div class="audit-box">
<p><strong>The page audit is switched off at the moment.</strong> Run the same audit from your machine:</p>
<div class="install" data-copy="audit_command"><span class="prompt">$</span><code>${AUDIT_COMMAND}</code></div>
</div>
</div>`;
  }

  return `<form class="audit rise" style="--d:180ms" id="audit" method="post" action="/audit" data-check="on"${state.crawls ? ' data-crawls="on"' : ""}>
<div class="audit-box">
<label class="sr-only" for="url">${state.crawls ? "The address of the page to audit, or a homepage to audit its site" : "The address of the page to audit"}</label>
<div class="audit-row">
<div class="audit-field">${icon("globe")}<input id="url" name="url" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" required maxlength="2048" placeholder="https://example.com/pricing" value="${esc(state.url ?? "")}"></div>
${submitButton(state.crawling ?? false)}
</div>
</div>
<div class="cf-turnstile" data-sitekey="${esc(state.siteKey)}" data-callback="onAuditToken" data-action="audit"></div>
${state.error ? `<p class="notice" role="alert"${state.failure ? ` data-failure="${state.failure}"` : ""}>${icon("error")}<span>${esc(state.error)}</span></p>` : ""}
<ul class="audit-facts">${formFacts(state.crawls)
    .map((fact) => `<li>${icon("check")}${fact}</li>`)
    .join("")}</ul>
<noscript><p class="notice">The form needs JavaScript for the check that keeps bots out. Without it, run <code>${AUDIT_COMMAND}</code>.</p></noscript>
</form>`;
};

const previewRow = (
  severity: Severity,
  rule: string,
  message: string,
  fix = ""
): string =>
  `<div class="preview-row sev-${severity}${fix ? " is-open" : ""}">${severityChip(severity)}<code>${rule}</code><span class="msg">${esc(message)}</span>${fix}</div>`;

/**
 * An example report, drawn as the report is, to show what the form gives before anyone runs it.
 * Its rules and messages are the tool's own; the page and its numbers are made up, and the
 * scores follow from the counts as score.ts weighs them.
 */
const PREVIEW = `<div class="wrap">
<div class="stage rise" style="--d:320ms">
<div class="stage-window">
<div class="window preview" role="img" aria-label="An example report: the SEO and AEO scores of a page, its findings, and the edit that adds its missing canonical link" data-nosnippet>
<div class="window-bar"><span class="window-address">${icon("globe")}example.com/pricing</span><span class="window-actions"><span class="chip">${icon("download")}JSON</span><span class="chip">${icon("copy")}Markdown</span></span></div>
<div class="preview-body">
<div class="preview-side">
<div class="mini-score">${scoreRing(82, "ring-sm")}<div><p class="score-name">SEO</p><p>3 warnings, 3 info</p></div></div>
<div class="mini-score">${scoreRing(93, "ring-sm")}<div><p class="score-name">AEO</p><p>1 warning, 2 info</p></div></div>
<ul class="preview-list"><li>Indexable<b>Yes</b></li><li>HTTP status<b>200</b></li><li>robots.txt<b>found</b></li><li>llms.txt<b>missing</b></li></ul>
</div>
<div class="preview-main">
${previewRow(
  "warning",
  "canonical.missing",
  "Page has no canonical link.",
  `<div class="diff diff-add"><span class="diff-label">Add at head</span><pre><code>${esc('<link rel="canonical" href="https://example.com/pricing">')}</code></pre></div>`
)}
${previewRow("warning", "aeo.robots-blocks-answer-bot", "robots.txt blocks OAI-SearchBot.")}
${previewRow("warning", "img.alt-missing", "2 of 5 images have no alt attribute.")}
${previewRow("warning", "meta-description.missing", "Page has no meta description.")}
${previewRow("info", "aeo.llms-txt-missing", "No llms.txt at https://example.com/llms.txt (HTTP 404).")}
${previewRow("info", "og.incomplete", "Open Graph is missing: og:description, og:url, og:type.")}
</div>
</div>
</div>
</div>
</div>
</div>`;

const STEPS: [figure: string, title: string, text: string][] = [
  [
    `<div class="fig-input">${icon("globe")}<span>example.com/pricing</span><b>Audit</b></div>`,
    "Audit",
    "Enter a page above, or a homepage to crawl its site, or let your agent run the tool on a URL, a crawl of a site or a build directory such as <code>dist/</code>.",
  ],
  [
    `<div class="fig-diff"><span class="del">− ${esc("<title>React App</title>")}</span><span class="add">+ ${esc("<title>")}<em>{{…}}</em>${esc(" | Example</title>")}</span></div>`,
    "Fix",
    "Every finding carries its edits: the tag as the page has it, and what to write instead. Words only an author can write are left in <code>{{…}}</code> slots.",
  ],
  [
    `<div class="fig-again">${scoreRing(64, "ring-sm")}${icon("arrow")}${scoreRing(96, "ring-sm")}</div>`,
    "Check again",
    "Run the audit again to see what is left. Each finding has an id, and an audit given a <code>baseline</code> says what is fixed, what is still open and what is new.",
  ],
];

/** The AEO rules by what they check: they share one category, so the homepage sorts them by id. */
const AEO_THEMES: [label: string, ids: RegExp][] = [
  [
    "AI crawlers in robots.txt",
    /^aeo\.(?:robots|content-signal|server-blocks|bot-probe)/u,
  ],
  [
    "Snippet and answer controls",
    /^aeo\.(?:noindex|nosnippet|max-snippet|noarchive|nocache|noai|data-nosnippet)/u,
  ],
  [
    "Authors, dates and entities",
    /^aeo\.(?:article|organization|entity|schema)/u,
  ],
  ["llms.txt", /^aeo\.llms-txt/u],
];

/** Where an AEO rule no theme names goes: the checks of what a page gives an answer engine to read. */
const AEO_REST = "Pages answer engines can read";

const aeoTheme = (id: string): string =>
  AEO_THEMES.find(([, ids]) => ids.test(id))?.[0] ?? AEO_REST;

/** Labels with their counts, most first, as bars against the largest; `wide` sets them in two columns. */
const levels = (
  rows: [label: string, count: number, href: string][],
  wide = false
): string => {
  const sorted = rows.toSorted((a, b) => b[1] - a[1]);
  const most = sorted[0]?.[1] ?? 1;

  return `<ul class="levels${wide ? " levels-2" : ""}">${sorted
    .map(
      ([label, count, href]) =>
        `<li><a href="${href}"><span>${label}</span><span class="level-bar" aria-hidden="true"><i style="--v:${(count / most).toFixed(3)}"></i></span><span class="level-count">${count}</span></a></li>`
    )
    .join("")}</ul>`;
};

/** How many of `items` each key has, in the order the keys first appear. */
const tally = <T, K>(items: T[], key: (item: T) => K): Map<K, number> => {
  const counts = new Map<K, number>();

  for (const item of items) {
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  }

  return counts;
};

const seoLevels = (): string =>
  levels(
    [...tally(SEO_RULES, (rule) => rule.category)].flatMap(
      ([category, count]): [string, number, string][] =>
        category === "tool"
          ? []
          : [[CATEGORY_LABEL[category], count, `/rules#${category}`]]
    ),
    true
  );

const aeoLevels = (): string =>
  levels(
    [...tally(AEO_RULES, (rule) => aeoTheme(rule.id))].map(([theme, count]) => [
      theme,
      count,
      "/rules#aeo",
    ])
  );

const PURPOSES = ["search", "answer", "training"] as const;

const botChips = (): string => `<div class="bots">
<div class="bots-head"><p>robots.txt is read for ${AI_BOTS.length} crawlers</p><ul class="legend">${PURPOSES.map(
  (purpose) =>
    `<li><span class="purpose purpose-${purpose}" aria-hidden="true"></span>${PURPOSE_LABEL[purpose]}</li>`
).join("")}</ul></div>
<ul class="bot-chips">${AI_BOTS.map(
  (bot) =>
    `<li class="bot-chip" title="${esc(`${bot.operator}: ${bot.usedFor}`)}"><span class="purpose purpose-${bot.purpose}" aria-hidden="true"></span>${esc(bot.name)}<span class="sr-only">, ${PURPOSE_LABEL[bot.purpose]}</span></li>`
).join("")}</ul>
</div>`;

/** A finding as the audit of a page without a canonical link prints it, less its `docs`, `url` and `id`. */
const EXAMPLE_FINDING = `{
  "rule": "canonical.missing",
  "severity": "warning",
  "category": "canonical",
  "message": "Page has no canonical link.",
  "recommendation": "Add a self-referencing canonical with the absolute preferred URL (scheme, host, trailing slash) so duplicate URLs (query strings, www/non-www) consolidate to it.",
  "fix": [
    {
      "in": "html",
      "action": "add",
      "at": "head",
      "code": "<link rel=\\"canonical\\" href=\\"https://example.com/pricing\\">",
      "write": "If this page is a copy of another one, name that page's URL instead."
    }
  ],
  "selector": "head > link[rel=\\"canonical\\"]"
}`;

/**
 * A string (a key with its colon), a literal or punctuation of JSON text; whitespace is what lies
 * between. It runs on EXAMPLE_FINDING only, never on a page's text.
 */
const JSON_TOKEN =
  /"(?:[^"\\]|\\.)*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?|[{}[\],]/gu;

/** One token of JSON_TOKEN, escaped and marked for its colour. */
const jsonToken = (token: string): string => {
  if (token.startsWith('"')) {
    const end = token.lastIndexOf('"') + 1;
    const colon = token.slice(end);

    return colon
      ? `<span class="j-key">${esc(token.slice(0, end))}</span><span class="j-punc">${colon}</span>`
      : `<span class="j-str">${esc(token)}</span>`;
  }

  return /^[{}[\],]$/u.test(token)
    ? `<span class="j-punc">${token}</span>`
    : `<span class="j-lit">${token}</span>`;
};

/** `json` with its keys, strings and literals marked for colour. */
const highlightJson = (json: string): string =>
  json.replaceAll(JSON_TOKEN, jsonToken);

const FINDING_PARTS: [name: string, text: string][] = [
  [
    "rule and severity",
    "an id an agent can look up in the rules, and how much it matters",
  ],
  ["selector", "the element the finding is about"],
  [
    "fix",
    "the exact edits: in the HTML, the HTTP response, robots.txt, the sitemap or llms.txt",
  ],
  ["evidence", "what the audit saw on the page, capped"],
];

/** What each route's command is called in the page's `snippet_copied` event (issue #57). */
const ROUTE_SNIPPETS = ["audit_command", "local_server", "mcp_url"];

const ROUTES: [
  iconName: IconName,
  title: string,
  text: string,
  command: string,
  link: [href: string, label: string],
][] = [
  [
    "terminal",
    "The command",
    "Audits a URL, a crawl of a site, or a directory of built HTML such as <code>dist/</code>. It needs Node 22.19 or later.",
    `<span class="prompt">$</span><code>${AUDIT_COMMAND}</code>`,
    [NPM_URL, "The package on npm"],
  ],
  [
    "server",
    "The local MCP server",
    "Reaches <code>localhost</code> and build directories, renders JavaScript and runs Lighthouse.",
    `<span class="prompt">$</span><code>${LOCAL_SERVER}</code>`,
    [`${REPOSITORY_URL}#mcp-server`, "Set it up from the README"],
  ],
  [
    "cloud",
    "The hosted MCP server",
    `For Claude, ChatGPT, Cursor and VS Code, with no install, no account and no key. In claude.ai, connect it from <a href="${CLAUDE_DIRECTORY_URL}">the Claude Directory</a>.`,
    `<code>${MCP_ORIGIN}/mcp</code>`,
    [HOSTED_PAGE, "How to add it"],
  ],
];

const KEEPS: [iconName: IconName, title: string, text: string][] = [
  [
    "cpu",
    "No AI model",
    "The audit runs on Cloudflare's network with rules only: the same page gets the same findings every time.",
  ],
  [
    "fileX",
    "No report, no page",
    "The site stores neither: the report is only in the answer your browser gets, and a share link holds only the address and the scores.",
  ],
  [
    "clock",
    "The hostname, for three months",
    "Each run records its outcome, duration, requests and the hostname audited. Never the path, the query or your IP address.",
  ],
  [
    "shield",
    "Bots kept out",
    "Cloudflare Turnstile checks that a person sent the form, and the hosted limits keep each site to a fair share.",
  ],
  [
    "chart",
    "Visits, counted",
    "PostHog (EU) counts visits and actions such as running an audit, never the address you audited. A cookie only if you accept one.",
  ],
];

const DESCRIPTION = `Audit a page or a whole site for search engines and AI answer engines, free. ${PRODUCT_NAME} gives each finding the exact fix, for you or your coding agent.`;

/** The homepage, with the audit form and what `state` puts under it. */
export const homePage = (state: HomeState): string =>
  layout({
    path: "/",
    title: `${PRODUCT_NAME}: SEO and AEO audits | ${MAKER}`,
    description: DESCRIPTION,
    turnstile: state.open,
    data: {
      "@type": "WebApplication",
      name: PRODUCT_NAME,
      url: `${SITE_ORIGIN}/`,
      description: DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      publisher,
    },
    body: `<section class="hero hero-glow" aria-labelledby="hero-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill rise"><span class="dot" aria-hidden="true"></span>Free and open source, by ${MAKER}</p>
<h1 class="hero-title rise" id="hero-title" style="--d:60ms">SEO and AEO audits <span class="hero-accent">with the fix for every finding.</span></h1>
<p class="lede rise" style="--d:120ms">${PRODUCT_NAME} audits a page for search engines and for AI answer engines such as ChatGPT search, Claude, Perplexity and Google AI Overviews. Every finding names the rule, the place in the HTML and the exact edit that fixes it, so you or your coding agent can act on it.</p>
</div>
${auditForm(state)}
</div>
${state.report ? "" : PREVIEW}
</section>
${state.report ?? ""}
<section class="section" aria-labelledby="loop-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">How it works</p>
<h2 id="loop-title">Audit, fix, check again.</h2>
<p>The same loop for a person at this form and for an agent with the tool, until nothing is left to fix.</p>
</div>
<ol class="steps">${STEPS.map(
      ([figure, title, text], index) =>
        `<li class="step"><div class="fig" aria-hidden="true">${figure}</div><span class="step-index">0${index + 1}</span><h3>${title}</h3><p>${text}</p></li>`
    ).join("")}</ol>
</div>
</section>
<section class="section" aria-labelledby="checks-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">What it checks</p>
<h2 id="checks-title">Two audits, each with its own score.</h2>
<p>The SEO audit has ${SEO_RULES.length} rules and the AEO audit ${AEO_RULES.length}. The form above runs the rules for one page; given a homepage, it crawls the site and adds the site-wide ones. <a href="/rules">Every rule, with what it reports and what it recommends</a>.</p>
</div>
<div class="audits">
<article class="audit-panel">
<div class="panel-head"><span class="panel-icon">${icon("search")}</span><div><h3>SEO: search engines</h3><p>Titles, canonicals, structured data, links, the response and more, for Google, Bing and every index an answer engine draws on.</p></div><p class="panel-count">${SEO_RULES.length}<small>rules</small></p></div>
${seoLevels()}
</article>
<article class="audit-panel">
<div class="panel-head"><span class="panel-icon">${icon("bot")}</span><div><h3>AEO: AI answer engines</h3><p>Whether AI crawlers may fetch a page, whether answer engines may quote it, and whether its content is easy to lift into an answer.</p></div><p class="panel-count">${AEO_RULES.length}<small>rules</small></p></div>
<div class="panel-body">
${aeoLevels()}
${botChips()}
</div>
</article>
</div>
</div>
</section>
<section class="section" aria-labelledby="fix-title">
<div class="wrap split">
<div class="split-copy">
<p class="kicker">The output</p>
<h2 id="fix-title">A finding names its fix.</h2>
<p>A finding is a fact about the page, not advice in general. It quotes the tag as the server sent it, says what to write instead, and marks the words only an author can write with <code>{{…}}</code>. An agent applies the edits and runs the audit again to see what is left.</p>
<ul class="ticks">${FINDING_PARTS.map(([name, text]) => `<li>${icon("check")}<span><code>${name.replace(" and ", "</code> and <code>")}</code>: ${text}</span></li>`).join("")}</ul>
</div>
<div class="window">
<div class="window-bar"><span class="window-title">canonical.missing</span><span class="window-actions sev-warning">${severityChip("warning")}</span></div>
<pre class="json" data-copy="example_finding"><code>${highlightJson(EXAMPLE_FINDING)}</code></pre>
</div>
</div>
</section>
<section class="section" aria-labelledby="agent-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">For coding agents</p>
<h2 id="agent-title">Give it to your coding agent.</h2>
<p>The form on this page is the audit for a person. The same audit runs as a command, as an MCP server on your machine and as a hosted MCP server, so an agent can audit, fix and check again by itself.</p>
</div>
<ul class="cards routes">${ROUTES.map(
      ([iconName, title, text, command, [href, label]], index) =>
        `<li class="card${index === 2 ? " route-featured" : ""}"><span class="card-icon">${icon(iconName)}</span>${index === 2 ? '<span class="chip corner"><span class="dot" aria-hidden="true"></span>No install</span>' : ""}<h3>${title}</h3><p>${text}</p><div class="install" data-copy="${ROUTE_SNIPPETS[index] ?? "route"}">${command}</div><a class="link-arrow" href="${href}">${label}${icon("arrow", "arrow")}</a></li>`
    ).join("")}</ul>
<p class="section-foot">The README on <a href="${REPOSITORY_URL}">GitHub</a> covers every flag, tool and option, and the skill that teaches an agent to use them.</p>
</div>
</section>
<section class="section" aria-labelledby="keeps-title">
<div class="wrap split">
<div class="split-copy">
<p class="kicker">Privacy</p>
<h2 id="keeps-title">What this site keeps.</h2>
<p>The audit runs on Cloudflare's network, with no AI model: the same rules give the same findings every time. The site stores no report and no page. A report's share link holds the address and the two scores, and nothing else: whoever you give it to sees them, and the site keeps no copy. For each run it records the outcome, the duration, the number of requests and the hostname audited, for three months, so that a report about too many requests to a site can be checked. It never records the path, the query or your IP address. The check that keeps bots out of the form is Cloudflare Turnstile.</p>
<p>PostHog, in the EU, counts the visits to this site and a short list of actions: running an audit, with its kind and its scores, downloading or sharing a report, copying a command, following a link to GitHub, npm or the hosted server. Never the address you audited or anything you type. When an audit fails on a bug of ours, it gets the kind of error and where in the code it happened, without the addresses or text in its message. It counts a visit without a cookie, and sets one only when you accept it in the banner; <span class="nowrap">Cookie settings</span>, at the foot of each page, changes your choice. The <a href="${PRIVACY_URL}">privacy policy</a> has the details.</p>
</div>
<ul class="cards keeps">${KEEPS.map(([iconName, title, text]) => `<li class="card"><span class="keep-icon">${icon(iconName)}</span><h3>${title}</h3><p>${text}</p></li>`).join("")}</ul>
</div>
</section>
<section class="section section-tight" aria-labelledby="cta-title">
<div class="wrap">
<div class="cta-card">
<p class="pill"><span class="dot" aria-hidden="true"></span>Hosted MCP server</p>
<h2 id="cta-title">Audit, fix and check again <span class="hero-accent">from your assistant.</span></h2>
<p>Add the hosted server to Claude, ChatGPT, Cursor or VS Code with one address: <code>${MCP_ORIGIN}/mcp</code></p>
<div class="cta-actions"><a class="btn btn-primary" href="${HOSTED_PAGE}#add">Add it to your assistant${icon("arrow", "arrow")}</a><a class="btn btn-secondary" href="${REPOSITORY_URL}">${GITHUB_MARK}Read the code</a></div>
${directoryBadge()}
</div>
</div>
</section>`,
  });

export const notFoundPage = (): string =>
  layout({
    path: "/404",
    title: `Not found | ${PRODUCT_NAME}`,
    description: `This address is not a page of the ${PRODUCT_NAME} website.`,
    data: { "@type": "WebPage", name: "Not found" },
    body: `<section class="hero hero-glow notfound" aria-labelledby="notfound-title">
<div class="wrap">
<div class="hero-copy">
<p class="notfound-code">404</p>
<h1 id="notfound-title">Not found.</h1>
<p class="lede">This address is not a page of this site. Audit a page, or read the rules.</p>
<div class="cta-actions"><a class="btn btn-primary" href="/">Audit a page${icon("arrow", "arrow")}</a><a class="btn btn-secondary" href="/rules">The rules</a></div>
</div>
</div>
</section>`,
  });
