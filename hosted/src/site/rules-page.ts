/**
 * The page at /rules: every rule the audits report, by category, as `agentic-seo-check rules` and
 * `seo_list_rules` list them, for a person, a search engine or an agent to read.
 */
import { MAKER, PRODUCT_NAME } from "../../../src/brand.js";
import { CATEGORY_LABEL, SEVERITIES } from "../../../src/core/report/labels.js";
import {
  AEO_RULES,
  ALL_RULES,
  SEO_RULES,
} from "../../../src/core/rules/index.js";
import type { Category, RuleMeta, Severity } from "../../../src/core/types.js";
import { icon } from "../ui/icons.js";
import { esc, safeHref } from "./html.js";
import { layout, publisher, SITE_ORIGIN } from "./layout.js";
import { severityChip } from "./report.js";
import { AUDIT_LABEL, auditOf, REQUIREMENTS, rulePath } from "./rule-info.js";

/**
 * A rule as one line, its id, severity and what it finds, that opens on what to change and links
 * to the rule's own page (issue #171). The page has some 200 of them: closed, they can be scanned.
 * A link to `#<id>` opens the rule (site.js), and the text inside stays in the page for search
 * engines and agents. The filters read `data-audit` and `data-severity`.
 */
const ruleHtml = (rule: RuleMeta): string => {
  const docs = rule.docs ? safeHref(rule.docs) : null;

  return `<details class="rule sev-${rule.severity}" id="${esc(rule.id)}" data-audit="${auditOf(rule)}" data-severity="${rule.severity}">
<summary><h3><code>${esc(rule.id)}</code></h3>${severityChip(rule.severity)}${rule.requires ? `<span class="chip">${REQUIREMENTS[rule.requires].tag}</span>` : ""}${icon("chevron", "chev")}<span class="rule-desc">${esc(rule.description)}</span></summary>
<div class="rule-body">
<p class="rule-todo"><strong>What to change:</strong> ${esc(rule.recommendation)}</p>
${rule.requires ? `<p class="rule-when">${REQUIREMENTS[rule.requires].when}</p>` : ""}<div class="rule-actions"><a class="link-arrow" href="${rulePath(rule.id)}">How to run it, and the rules beside it${icon("arrow", "arrow")}</a>${docs ? `<a class="link-arrow" href="${docs}" rel="noopener">Documentation${icon("arrow", "arrow")}</a>` : ""}</div>
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

/** The severities as the filter and the summary name them, in the plural. */
const SEVERITY_PLURAL: Record<Severity, string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Info",
};

/** One count under the heading; a severity's has its colour. */
const tile = (count: number, label: string, severity?: Severity): string =>
  `<li${severity ? ` class="sev-${severity}"` : ""}><strong>${count}</strong><span>${label}</span></li>`;

/** How many rules each audit and each severity has, under the heading. */
const stats = (): string =>
  `<ul class="rules-stats rise" style="--d:180ms">${[
    tile(SEO_RULES.length, AUDIT_LABEL.seo),
    tile(AEO_RULES.length, AUDIT_LABEL.aeo),
    ...SEVERITIES.map((severity) =>
      tile(
        ALL_RULES.filter((rule) => rule.severity === severity).length,
        SEVERITY_PLURAL[severity],
        severity
      )
    ),
  ].join("")}</ul>`;

/** A row of buttons that narrows the list to one value of `facet`, or to all of them. */
const facet = (
  name: "audit" | "severity",
  label: string,
  options: [value: string, text: string][]
): string =>
  `<div class="seg" role="group" aria-label="${label}">${[
    ["", "All"],
    ...options,
  ]
    .map(
      ([value, text]) =>
        `<button type="button" data-facet="${name}" data-value="${value}" aria-pressed="${value === "" ? "true" : "false"}">${text}</button>`
    )
    .join("")}</div>`;

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
    body: `<section class="hero hero-glow hero-split rules-hero" aria-labelledby="rules-title">
<div class="wrap">
<div class="hero-copy">
<p class="pill rise"><span class="dot" aria-hidden="true"></span>${ALL_RULES.length} rules in ${groups.length} categories</p>
<h1 class="hero-title rise" id="rules-title" style="--d:60ms">The rules of ${PRODUCT_NAME}.</h1>
</div>
<p class="lede rise" style="--d:120ms">What each rule finds, and what to change. Open a rule for its fix, or its page for how to run it.</p>
${stats()}
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
<div class="rules-facets">
${facet("audit", "Audit", [
  ["seo", "SEO"],
  ["aeo", "AEO"],
])}
${facet(
  "severity",
  "Severity",
  SEVERITIES.map((severity) => [severity, SEVERITY_PLURAL[severity]])
)}
<p class="rules-count" aria-live="polite"></p>
</div>
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
<p class="rules-empty" hidden>No rule matches. Clear the filter, or try fewer words.</p>
</div>
</div>`,
  });
};
