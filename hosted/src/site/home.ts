/**
 * The website's homepage: what agentic-seo-check is, the page audit to run in the browser, what it
 * checks and how to give it to a coding agent. An answer of the audit form is this page again,
 * with the report or the reason there is none under the form.
 */
import { MAKER, REPOSITORY_URL } from "../../../src/brand.js";
import { HOSTED_LIMITS, LOCAL_SERVER } from "../../../src/core/hosted.js";
import { AEO_RULES, SEO_RULES } from "../../../src/core/rules/index.js";
import type { Category } from "../../../src/core/types.js";
import { ORIGIN as MCP_ORIGIN, rateLimit } from "../limits.js";
import { esc } from "./html.js";
import { HOSTED_PAGE, layout, publisher, SITE_ORIGIN } from "./layout.js";

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
  /** Turnstile's public site key, for the form's widget. */
  siteKey: string;
  /** The URL in the field: the one just audited, or one a link filled in. */
  url?: string;
  /** Why there is no report, in the words of the refusal. */
  error?: string;
  /** The report of the audit just run (report.ts). */
  report?: string;
}

const auditForm = (state: HomeState): string => {
  const { limit, period } = rateLimit("CALLER_CALLS");

  if (!state.open) {
    return `<div class="audit-card" id="audit">
<p><strong>The page audit is switched off at the moment.</strong> Run the same audit from your machine: <code>npx @rivi-software/agentic-seo-check audit https://example.com</code></p>
</div>`;
  }

  return `<form class="audit-card" id="audit" method="post" action="/audit" data-check="on">
<label for="url">Audit a page</label>
<div class="audit-row">
<input id="url" name="url" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" required maxlength="2048" placeholder="https://example.com/pricing" value="${esc(state.url ?? "")}">
<button class="button" type="submit">Run the audit</button>
</div>
<div class="cf-turnstile" data-sitekey="${esc(state.siteKey)}" data-callback="onAuditToken" data-action="audit"></div>
${state.error ? `<p class="notice" role="alert">${esc(state.error)}</p>` : ""}
<p class="hint">One public page per run, the first ${HOSTED_LIMITS.maxBodyBytes / 1_000_000} MB of its HTML, ${limit} runs a ${period} per address. The audit reads the HTML the server sends; it does not run the page's JavaScript.</p>
<noscript><p class="hint">The form needs JavaScript for the check that keeps bots out. Without it, run <code>npx @rivi-software/agentic-seo-check audit https://example.com</code>.</p></noscript>
</form>`;
};

/** The categories of `rules` with their counts, most rules first. */
const categoryCards = (
  rules: { category: Category }[],
  skip: Category[]
): string => {
  const counts = new Map<Category, number>();

  for (const rule of rules) {
    counts.set(rule.category, (counts.get(rule.category) ?? 0) + 1);
  }

  return [...counts]
    .filter(([category]) => !skip.includes(category))
    .toSorted((a, b) => b[1] - a[1])
    .map(
      ([category, count]) =>
        `<li class="card"><a href="/rules#${category}">${CATEGORY_LABEL[category]}</a><br><span class="count">${count} rules</span></li>`
    )
    .join("");
};

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

const DESCRIPTION =
  "Audit a page for search engines and AI answer engines in your browser, free. agentic-seo-check gives each finding the exact fix, for you or your coding agent.";

/** The homepage, with the audit form and what `state` puts under it. */
export const homePage = (state: HomeState): string =>
  layout({
    path: "/",
    title: "agentic-seo-check: SEO and AEO audits | RIVI Software",
    description: DESCRIPTION,
    script: true,
    turnstile: state.open,
    data: {
      "@type": "WebApplication",
      name: "agentic-seo-check",
      url: `${SITE_ORIGIN}/`,
      description: DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      publisher,
    },
    body: `<section class="wrap hero">
<p class="eyebrow">Open source, by ${MAKER}</p>
<h1>SEO and AEO audits with the fix for every finding</h1>
<p class="lead">agentic-seo-check audits a page for search engines and for AI answer engines such as ChatGPT search, Claude, Perplexity and Google AI Overviews. Every finding names the rule, the place in the HTML and the exact edit that fixes it, so you or your coding agent can act on it.</p>
${auditForm(state)}
</section>
${state.report ?? ""}
<section class="band">
<div class="wrap">
<h2>What the audit checks</h2>
<p class="prose">The SEO audit has ${SEO_RULES.length} rules and the AEO audit ${AEO_RULES.length}, each with its own score. The form above runs the rules for one page; a crawl adds the site-wide ones. <a href="/rules">Every rule, with what it reports and what it recommends</a>.</p>
<ul class="grid">${categoryCards(SEO_RULES, ["tool"])}${categoryCards(AEO_RULES, [])}</ul>
</div>
</section>
<section class="band">
<div class="wrap">
<h2>A finding names its fix</h2>
<p class="prose">A finding is a fact about the page, not advice in general. It quotes the tag as the server sent it, says what to write instead, and marks the words only an author can write with <code>{{…}}</code>. An agent applies the edits and runs the audit again to see what is left.</p>
<pre class="prose"><code>${esc(EXAMPLE_FINDING)}</code></pre>
</div>
</section>
<section class="band">
<div class="wrap">
<h2>Give it to your coding agent</h2>
<p class="prose">The form on this page is the audit for a person. The same audit runs as a command, as an MCP server on your machine and as a hosted MCP server, so an agent can audit, fix and check again by itself.</p>
<ul class="grid">
<li class="card"><h3>The command</h3><p>Audits a URL, a crawl of a site, or a directory of built HTML such as <code>dist/</code>. It needs Node 22.19 or later.</p><pre><code>npx @rivi-software/agentic-seo-check audit https://example.com</code></pre></li>
<li class="card"><h3>The local MCP server</h3><p>Reaches <code>localhost</code> and build directories, renders JavaScript and runs Lighthouse.</p><pre><code>${LOCAL_SERVER}</code></pre></li>
<li class="card"><h3>The hosted MCP server</h3><p>For Claude, ChatGPT, Cursor and VS Code, with no install, no account and no key. <a href="${HOSTED_PAGE}">How to add it</a>.</p><pre><code>${MCP_ORIGIN}/mcp</code></pre></li>
</ul>
<p class="prose" style="margin-top:1.5rem">The README on <a href="${REPOSITORY_URL}">GitHub</a> covers every flag, tool and option, and the skill that teaches an agent to use them.</p>
</div>
</section>
<section class="band">
<div class="wrap"><div class="prose">
<h2>What this site keeps</h2>
<p>The audit runs on Cloudflare's network, with no AI model: the same rules give the same findings every time. The site stores no report and no page. For each run it records the outcome, the duration, the number of requests and the hostname audited, for three months, so that a report about too many requests to a site can be checked. It never records the path, the query or your IP address. The check that keeps bots out of the form is Cloudflare Turnstile.</p>
</div></div>
</section>`,
  });

export const notFoundPage = (): string =>
  layout({
    path: "/404",
    title: "Not found | agentic-seo-check",
    description: "This address is not a page of the agentic-seo-check website.",
    data: { "@type": "WebPage", name: "Not found" },
    body: `<section class="wrap hero">
<h1>Not found</h1>
<p class="lead">This address is not a page of this site. <a href="/">Audit a page</a>, or read <a href="/rules">the rules</a>.</p>
</section>`,
  });
