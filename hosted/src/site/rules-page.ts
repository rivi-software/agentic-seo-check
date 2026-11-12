/**
 * The page at /rules: every rule the audits report, by category, as `agentic-seo-check rules` and
 * `seo_list_rules` list them, for a person, a search engine or an agent to read.
 */
import { MAKER, PRODUCT_NAME } from "../../../src/brand.js";
import { CATEGORY_LABEL } from "../../../src/core/report/labels.js";
import { ALL_RULES } from "../../../src/core/rules/index.js";
import type {
  Category,
  Requirement,
  RuleMeta,
} from "../../../src/core/types.js";
import { icon } from "../ui/icons.js";
import { esc, safeHref } from "./html.js";
import { layout, publisher, SITE_ORIGIN } from "./layout.js";
import { severityChip } from "./report.js";

/** When a rule runs, for the rules that do not run on every audit. */
const REQUIREMENT: Record<Requirement, string> = {
  render: "Runs with --render, on the command or the local server.",
  lighthouse: "Runs with --lighthouse, on the command or the local server.",
  "field-data":
    "Runs with --field-data (fieldData), on the command and both MCP servers, and in this site's audits: it reads the Chrome UX Report's real-user data.",
  crawl: "Runs on a crawl or a build directory.",
  keyword: "Runs when the audit is given a keyword.",
  "ai-bots": "Runs with --ai-bots, on the command or the local server.",
};

/** The short name of each requirement, as a rule's label shows it. */
const REQUIREMENT_TAG: Record<Requirement, string> = {
  render: "--render",
  lighthouse: "--lighthouse",
  "field-data": "--field-data",
  crawl: "crawl",
  keyword: "keyword",
  "ai-bots": "--ai-bots",
};

/**
 * A rule as one line, its id, severity and what it finds, that opens on what to change. The page
 * has some 200 of them: closed, they can be scanned. A link to `#<id>` opens the rule (site.js),
 * and the text inside stays in the page for search engines and agents.
 */
const ruleHtml = (rule: RuleMeta): string => {
  const docs = rule.docs ? safeHref(rule.docs) : null;

  return `<details class="rule sev-${rule.severity}" id="${esc(rule.id)}">
<summary><h3><code>${esc(rule.id)}</code></h3>${severityChip(rule.severity)}${rule.requires ? `<span class="chip">${REQUIREMENT_TAG[rule.requires]}</span>` : ""}${icon("chevron", "chev")}<span class="rule-desc">${esc(rule.description)}</span></summary>
<div class="rule-body">
<p class="rule-todo"><strong>What to change:</strong> ${esc(rule.recommendation)}</p>
${rule.requires ? `<p class="rule-when">${REQUIREMENT[rule.requires]}</p>` : ""}${docs ? `<a class="link-arrow" href="${docs}" rel="noopener">Documentation${icon("arrow", "arrow")}</a>` : ""}
</div>
</details>`;
};

/** The rules by category, in the order the rules are listed. */
const byCategory = (): Map<Category, RuleMeta[]> => {
  const groups = new Map<Category, RuleMeta[]>();

  for (const rule of ALL_RULES) {
    groups.set(rule.category, [...(groups.get(rule.category) ?? []), rule]);
  }

  return groups;
};

export const rulesPage = (): string => {
  const groups = [...byCategory()];

  const description = `The ${ALL_RULES.length} rules ${PRODUCT_NAME} reports for search engines and AI answer engines: what each one finds, its severity and what it recommends.`;

  return layout({
    path: "/rules",
    title: `The rules of ${PRODUCT_NAME} | ${MAKER}`,
    description,
    data: {
      "@type": "WebPage",
      name: `The rules of ${PRODUCT_NAME}`,
      url: `${SITE_ORIGIN}/rules`,
      description,
      publisher,
    },
    body: `<section class="hero hero-glow hero-split" aria-labelledby="rules-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill rise"><span class="dot" aria-hidden="true"></span>${ALL_RULES.length} rules in ${groups.length} categories</p>
<h1 class="hero-title rise" id="rules-title" style="--d:60ms">The rules of ${PRODUCT_NAME}.</h1>
</div>
<p class="lede rise" style="--d:120ms">What each rule finds, and what to change. Open a rule for its fix.</p>
</div>
</section>
<div class="wrap rules-layout">
<nav class="rules-toc" aria-labelledby="toc-title">
<h2 id="toc-title">Categories</h2>
<ul>${groups
      .map(
        ([category, rules]) =>
          `<li><a href="#${category}" data-group="${category}">${CATEGORY_LABEL[category]} <span>${rules.length}</span></a></li>`
      )
      .join("")}</ul>
</nav>
<div>
<div class="rules-filter" hidden>
<label class="sr-only" for="rule-filter">Filter the rules</label>
<div class="audit-field">${icon("search")}<input id="rule-filter" type="search" autocomplete="off" spellcheck="false" placeholder="Filter by id or text, such as canonical or GPTBot"></div>
<p class="rules-count" aria-live="polite"></p>
</div>
${groups
  .map(
    ([
      category,
      rules,
    ]) => `<section class="rule-group" id="${category}" aria-labelledby="${category}-title">
<div class="rule-group-head"><h2 id="${category}-title">${CATEGORY_LABEL[category]}</h2><span class="chip">${rules.length} ${rules.length === 1 ? "rule" : "rules"}</span></div>
<div class="rule-list">
${rules.map(ruleHtml).join("\n")}
</div>
</section>`
  )
  .join("\n")}
</div>
</div>`,
  });
};
