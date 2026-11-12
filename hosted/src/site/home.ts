/**
 * The website's homepage: what Agentic SEO Check is, the page audit to run in the browser, what it
 * checks and how to give it to a coding agent. An answer of the audit form is this page again,
 * with the report, or the reason there is none, in place of the example report.
 */
import { MAKER, PRODUCT_NAME, REPOSITORY_URL } from "../../../src/brand.js";
import { AI_BOTS } from "../../../src/core/aeo/bots.js";
import { HOSTED_LIMITS, LOCAL_SERVER } from "../../../src/core/hosted.js";
import {
  CATEGORY_LABEL,
  PURPOSE_LABEL,
} from "../../../src/core/report/labels.js";
import { AEO_RULES, SEO_RULES } from "../../../src/core/rules/index.js";
import type { Severity } from "../../../src/core/types.js";
import { ORIGIN as MCP_ORIGIN } from "../limits.js";
import { listingBadges, PRIVACY_URL } from "../ui/frame.js";
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
import { scoreRing, severityChip } from "./report.js";

/**
 * What kind of refusal the form answered with, as the page's `audit_failed` event names it (issue
 * #57): the address, the check that keeps bots out, a limit, the form switched off, the site's
 * refusal (its answer, or its robots.txt), or a failure on our side (issue #96).
 */
export type FailureKind =
  | "address"
  | "check"
  | "limit"
  | "paused"
  | "refused"
  | "error";

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

/**
 * What the form does, under it, in three short lines. The rate limits are left to the answer that
 * refuses a run past them, which names the limit.
 */
const formFacts = (crawls: boolean): string[] => {
  const mb = HOSTED_LIMITS.maxBodyBytes / 1_000_000;

  return [
    crawls ? "A page, or a whole site from its homepage" : "One public page",
    crawls
      ? `Up to ${HOSTED_LIMITS.maxPages} pages, ${mb} MB of HTML each`
      : `The first ${mb} MB of its HTML`,
    "The HTML as served, without running its JavaScript",
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
<div class="window-bar"><span class="window-address">${icon("globe")}example.com/pricing</span><span class="window-actions"><span class="chip">${icon("download")}JSON</span><span class="chip">${icon("copy")}Markdown</span><span class="chip">${icon("file")}PDF</span></span></div>
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
    "Enter a page, or a homepage to crawl the site. An agent can also audit a build directory.",
  ],
  [
    `<div class="fig-diff"><span class="del">− ${esc("<title>React App</title>")}</span><span class="add">+ ${esc("<title>")}<em>{{…}}</em>${esc(" | Example</title>")}</span></div>`,
    "Fix",
    "Each finding carries its edits. Words only you can write are left in <code>{{…}}</code>.",
  ],
  [
    `<div class="fig-again">${scoreRing(64, "ring-sm")}${icon("arrow")}${scoreRing(96, "ring-sm")}</div>`,
    "Check again",
    "Run it again to see what is fixed, what is still open and what is new.",
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
    "A URL, a site or a build directory such as <code>dist/</code>. Needs Node 22.19 or later.",
    `<span class="prompt">$</span><code>${AUDIT_COMMAND}</code>`,
    [NPM_URL, "The package on npm"],
  ],
  [
    "server",
    "The local MCP server",
    "Adds <code>localhost</code>, build directories, JavaScript rendering and Lighthouse.",
    `<span class="prompt">$</span><code>${LOCAL_SERVER}</code>`,
    [`${REPOSITORY_URL}#mcp-server`, "Set it up from the README"],
  ],
  [
    "cloud",
    "The hosted MCP server",
    "For Claude, ChatGPT, Cursor and VS Code. No install, no account, no key.",
    `<code>${MCP_ORIGIN}/mcp</code>`,
    [HOSTED_PAGE, "How to add it"],
  ],
];

/** What the site keeps, in short; the privacy policy has the rest. */
const KEEPS: [iconName: IconName, title: string, text: string][] = [
  [
    "cpu",
    "No AI model",
    "Rules only: the same page gets the same findings every time.",
  ],
  [
    "fileX",
    "No report kept",
    "The report is only in your browser. A share link holds the address and the scores.",
  ],
  [
    "clock",
    "The hostname, for three months",
    "Each run's outcome, duration, requests and hostname. Never the path, the query or your IP address: only a hash of it, until 00:00 UTC, to count the sites you audit that day.",
  ],
  [
    "shield",
    "Bots kept out",
    "Cloudflare Turnstile checks that a person sent the form.",
  ],
  [
    "chart",
    "Visits, counted",
    "PostHog (EU) counts visits, actions and our own errors, never the address you audited. A cookie only if you accept one.",
  ],
  [
    "globe",
    "The address, to Google",
    "For the speed of real visits, the page's address goes to Google's Chrome UX Report, and nothing else of the run.",
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
<p class="lede rise" style="--d:120ms">Check a page or a whole site for search engines and AI answer engines such as ChatGPT, Claude and Perplexity. Every finding comes with the exact edit that fixes it.</p>
</div>
${auditForm(state)}
</div>
${state.report ? "" : PREVIEW}
</section>
${state.report ?? ""}
<section class="section" id="how" aria-labelledby="loop-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">How it works</p>
<h2 id="loop-title">Audit, fix, check again.</h2>
</div>
<ol class="steps">${STEPS.map(
      ([figure, title, text], index) =>
        `<li class="step"><div class="fig" aria-hidden="true">${figure}</div><span class="step-index">0${index + 1}</span><h3>${title}</h3><p>${text}</p></li>`
    ).join("")}</ol>
</div>
</section>
<section class="section" id="checks" aria-labelledby="checks-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">What it checks</p>
<h2 id="checks-title">Two audits, each with its own score.</h2>
<p><a href="/rules">Browse all ${SEO_RULES.length + AEO_RULES.length} rules</a>, or pick a category below.</p>
</div>
<div class="audits">
<article class="audit-panel">
<div class="panel-head"><span class="panel-icon">${icon("search")}</span><div><h3>SEO: search engines</h3><p>Titles, canonicals, structured data, links and the response.</p></div><p class="panel-count">${SEO_RULES.length}<small>rules</small></p></div>
${seoLevels()}
</article>
<article class="audit-panel">
<div class="panel-head"><span class="panel-icon">${icon("bot")}</span><div><h3>AEO: AI answer engines</h3><p>Whether AI crawlers may fetch a page, and answer engines quote it.</p></div><p class="panel-count">${AEO_RULES.length}<small>rules</small></p></div>
<div class="panel-body">
${aeoLevels()}
${botChips()}
</div>
</article>
</div>
</div>
</section>
<section class="section" id="output" aria-labelledby="fix-title">
<div class="wrap split">
<div class="split-copy">
<p class="kicker">The output</p>
<h2 id="fix-title">A finding names its fix.</h2>
<p>It quotes the tag as the server sent it and says what to write instead, in the HTML, the response, robots.txt, the sitemap or llms.txt.</p>
</div>
<div class="window">
<div class="window-bar"><span class="window-title">canonical.missing</span><span class="window-actions sev-warning">${severityChip("warning")}</span></div>
<pre class="json" data-copy="example_finding"><code>${highlightJson(EXAMPLE_FINDING)}</code></pre>
</div>
</div>
</section>
<section class="section" id="agents" aria-labelledby="agent-title">
<div class="wrap">
<div class="section-head">
<p class="kicker">For coding agents</p>
<h2 id="agent-title">Give it to your coding agent.</h2>
<p>So it can audit, fix and check again by itself.</p>
</div>
<ul class="cards routes">${ROUTES.map(
      ([iconName, title, text, command, [href, label]], index) =>
        `<li class="card${index === 2 ? " route-featured" : ""}"><span class="card-icon">${icon(iconName)}</span>${index === 2 ? '<span class="chip corner"><span class="dot" aria-hidden="true"></span>No install</span>' : ""}<h3>${title}</h3><p>${text}</p><div class="install" data-copy="${ROUTE_SNIPPETS[index] ?? "route"}">${command}</div><a class="link-arrow" href="${href}">${label}${icon("arrow", "arrow")}</a></li>`
    ).join("")}</ul>
</div>
</section>
<section class="section" id="privacy" aria-labelledby="keeps-title">
<div class="wrap split split-top">
<div class="split-copy">
<p class="kicker">Privacy</p>
<h2 id="keeps-title">What this site keeps.</h2>
<p>The short version; the <a href="${PRIVACY_URL}">privacy policy</a> has the details. <span class="nowrap">Cookie settings</span>, at the foot of each page, changes your choice.</p>
</div>
<ul class="cards keeps">${KEEPS.map(([iconName, title, text]) => `<li class="card"><span class="keep-icon">${icon(iconName)}</span><h3>${title}</h3><p>${text}</p></li>`).join("")}</ul>
</div>
</section>
<section class="section section-tight" aria-labelledby="cta-title">
<div class="wrap">
<div class="cta-card">
<p class="pill"><span class="dot" aria-hidden="true"></span>Hosted MCP server</p>
<h2 id="cta-title">Audit, fix and check again <span class="hero-accent">from your assistant.</span></h2>
<p>One address for Claude, ChatGPT, Cursor and VS Code: <code>${MCP_ORIGIN}/mcp</code></p>
<div class="cta-actions"><a class="btn btn-primary" href="${HOSTED_PAGE}#add">Add it to your assistant${icon("arrow", "arrow")}</a><a class="btn btn-secondary" href="${REPOSITORY_URL}">${GITHUB_MARK}Read the code</a></div>
${listingBadges()}
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
