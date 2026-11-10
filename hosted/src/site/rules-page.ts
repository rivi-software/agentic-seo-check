/**
 * The page at /rules: every rule the audits report, by category, as `agentic-seo-check rules` and
 * `seo_list_rules` list them, for a person, a search engine or an agent to read.
 */
import { ALL_RULES } from "../../../src/core/rules/index.js";
import type {
  Category,
  Requirement,
  RuleMeta,
} from "../../../src/core/types.js";
import { icon } from "../ui/icons.js";
import { CATEGORY_LABEL } from "./home.js";
import { esc, safeHref } from "./html.js";
import { layout, publisher, SITE_ORIGIN } from "./layout.js";
import { severityChip } from "./report.js";

/** When a rule runs, for the rules that do not run on every audit. */
const REQUIREMENT: Record<Requirement, string> = {
  render: "Runs with --render, on the command or the local server.",
  lighthouse: "Runs with --lighthouse, on the command or the local server.",
  crawl: "Runs on a crawl or a build directory.",
  keyword: "Runs when the audit is given a keyword.",
  "ai-bots": "Runs with --ai-bots, on the command or the local server.",
};

/** The short name of each requirement, as a rule's label shows it. */
const REQUIREMENT_TAG: Record<Requirement, string> = {
  render: "--render",
  lighthouse: "--lighthouse",
  crawl: "crawl",
  keyword: "keyword",
  "ai-bots": "--ai-bots",
};

const ruleHtml = (rule: RuleMeta): string => {
  const docs = rule.docs ? safeHref(rule.docs) : null;

  return `<article class="rule sev-${rule.severity}" id="${esc(rule.id)}">
<div class="rule-head"><h3><code>${esc(rule.id)}</code></h3>${severityChip(rule.severity)}${rule.requires ? `<span class="chip">${REQUIREMENT_TAG[rule.requires]}</span>` : ""}</div>
<p>${esc(rule.description)}</p>
<p class="rule-todo"><strong>What to change:</strong> ${esc(rule.recommendation)}</p>
${rule.requires ? `<p class="rule-when">${REQUIREMENT[rule.requires]}</p>` : ""}${docs ? `<a class="link-arrow" href="${docs}" rel="noopener">Documentation${icon("arrow", "arrow")}</a>` : ""}
</article>`;
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

  const description = `The ${ALL_RULES.length} rules agentic-seo-check reports for search engines and AI answer engines: what each one finds, its severity and what it recommends.`;

  return layout({
    path: "/rules",
    title: "The rules of agentic-seo-check | RIVI Software",
    description,
    data: {
      "@type": "WebPage",
      name: "The rules of agentic-seo-check",
      url: `${SITE_ORIGIN}/rules`,
      description,
      publisher,
    },
    body: `<section class="hero hero-glow hero-split" aria-labelledby="rules-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill rise"><span class="dot" aria-hidden="true"></span>${ALL_RULES.length} rules in ${groups.length} categories</p>
<h1 class="hero-title rise" id="rules-title" style="--d:60ms">The rules of agentic-seo-check.</h1>
</div>
<p class="lede rise" style="--d:120ms">The audits report ${ALL_RULES.length} rules in ${groups.length} categories. Each rule has an id, a usual severity, what it finds on a page or site and what it recommends. A finding adds the exact edits for the page it is about.</p>
</div>
</section>
<div class="wrap rules-layout">
<nav class="rules-toc" aria-labelledby="toc-title">
<h2 id="toc-title">Categories</h2>
<ul>${groups
      .map(
        ([category, rules]) =>
          `<li><a href="#${category}">${CATEGORY_LABEL[category]} <span>${rules.length}</span></a></li>`
      )
      .join("")}</ul>
</nav>
<div>
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
