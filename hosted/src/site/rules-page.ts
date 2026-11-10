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
import { CATEGORY_LABEL } from "./home.js";
import { esc, safeHref } from "./html.js";
import { layout, publisher, SITE_ORIGIN } from "./layout.js";

/** When a rule runs, for the rules that do not run on every audit. */
const REQUIREMENT: Record<Requirement, string> = {
  render: "Runs with --render, on the command or the local server.",
  lighthouse: "Runs with --lighthouse, on the command or the local server.",
  crawl: "Runs on a crawl or a build directory.",
  keyword: "Runs when the audit is given a keyword.",
  "ai-bots": "Runs with --ai-bots, on the command or the local server.",
};

const SEVERITY_LABEL: Record<RuleMeta["severity"], string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

const ruleHtml = (rule: RuleMeta): string => {
  const docs = rule.docs ? safeHref(rule.docs) : null;

  return `<article class="rule sev-${rule.severity}" id="${esc(rule.id)}">
<h3><code>${esc(rule.id)}</code><span class="sev">${SEVERITY_LABEL[rule.severity]}</span></h3>
<p>${esc(rule.description)}</p>
<p><strong>What to change:</strong> ${esc(rule.recommendation)}</p>
${rule.requires ? `<p class="count">${REQUIREMENT[rule.requires]}</p>` : ""}${docs ? `<p><a href="${docs}" rel="noopener">Documentation</a></p>` : ""}
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
    body: `<section class="wrap hero">
<h1>The rules of agentic-seo-check</h1>
<p class="lead">The audits report ${ALL_RULES.length} rules in ${groups.length} categories. Each rule has an id, a usual severity, what it finds on a page or site and what it recommends. A finding adds the exact edits for the page it is about.</p>
<ul class="toc">${groups
      .map(
        ([category, rules]) =>
          `<li><a href="#${category}">${CATEGORY_LABEL[category]}</a> <span class="count">${rules.length}</span></li>`
      )
      .join("")}</ul>
</section>
${groups
  .map(
    ([category, rules]) => `<section class="band" id="${category}">
<div class="wrap"><div class="prose">
<h2>${CATEGORY_LABEL[category]}</h2>
${rules.map(ruleHtml).join("\n")}
</div></div>
</section>`
  )
  .join("\n")}`,
  });
};
