/**
 * The page of one rule at /rules/<id> (issue #171): what it finds, what to change, when it runs,
 * how to run or skip it, and the rules beside it in its category. Built from the rule's metadata,
 * as the rules index is, so a rule's page never says more than the tool does.
 */
import { PRODUCT_NAME, REPOSITORY_URL } from "../../../src/brand.js";
import { CATEGORY_LABEL, plural } from "../../../src/core/report/labels.js";
import { ALL_RULES } from "../../../src/core/rules/index.js";
import { PAGE_WEIGHTS } from "../../../src/core/score.js";
import type { RuleMeta, Severity } from "../../../src/core/types.js";
import { icon } from "../ui/icons.js";
import { esc, safeHref } from "./html.js";
import { layout, publisher, SITE_ORIGIN } from "./layout.js";
import { severityChip } from "./report.js";
import {
  AUDIT_LABEL,
  auditOf,
  REQUIREMENTS,
  rulePath,
  ruleUsage,
  runsWhere,
} from "./rule-info.js";

/** The most rules of its category a rule's page lists beside it, the nearest in the list first. */
const MAX_NEIGHBOURS = 8;

/** What a finding of each severity means. */
const SEVERITY_MEANS: Record<Severity, string> = {
  error:
    "An error is a problem that keeps a page out of search or out of answers, or breaks how it shows there.",
  warning:
    "A warning is a problem that costs a page ranking, clicks or citations.",
  info: "Info is a best practice: worth doing, rarely urgent, and --no-info leaves it out.",
};

/** What a finding of `severity` means, and what it takes off a page's score (score.ts). */
const severityMeans = (severity: Severity): string =>
  `${SEVERITY_MEANS[severity]} Each finding takes ${plural(PAGE_WEIGHTS[severity], "point")} off the page's score.`;

/** The issue form for a wrong finding, with the rule's id filled in. */
const wrongFindingUrl = (id: string): string =>
  `${REPOSITORY_URL}/issues/new?template=wrong_finding.yml&rule=${encodeURIComponent(id)}`;

/** The rules of a category nearest to `rule` in the list, in the list's order. */
const neighbours = (rule: RuleMeta, same: RuleMeta[]): RuleMeta[] => {
  const at = same.indexOf(rule);

  const start = Math.max(
    0,
    Math.min(at - MAX_NEIGHBOURS / 2, same.length - MAX_NEIGHBOURS - 1)
  );

  return same
    .slice(start, start + MAX_NEIGHBOURS + 1)
    .filter((other) => other !== rule);
};

/** A rule as a link to its page: its severity, its id and what it finds. */
const ruleLink = (rule: RuleMeta): string =>
  `<li><a class="rule-link sev-${rule.severity}" href="${rulePath(rule.id)}">${severityChip(rule.severity)}<span class="rule-link-text"><code>${esc(rule.id)}</code><span>${esc(rule.description)}</span></span>${icon("arrow", "arrow")}</a></li>`;

/** One side of the pager: a link to the rule there, or nothing at an end of the list. */
const pagerSide = (
  other: RuleMeta | undefined,
  label: string,
  rel: "prev" | "next"
): string =>
  other
    ? `<a href="${rulePath(other.id)}" rel="${rel}"><span class="label">${label}</span><code>${esc(other.id)}</code></a>`
    : "";

/** The rule before and after this one in the whole list, for reading them in turn. */
const pager = (rule: RuleMeta): string => {
  const at = ALL_RULES.indexOf(rule);

  return `<nav class="rule-pager" aria-label="Previous and next rule">${pagerSide(ALL_RULES[at - 1], "Previous rule", "prev")}${pagerSide(ALL_RULES[at + 1], "Next rule", "next")}</nav>`;
};

/** A line of the facts beside the rule. */
const fact = (term: string, value: string): string =>
  `<div class="fact"><dt>${term}</dt><dd>${value}</dd></div>`;

/** A title within 60 characters: the id, then as much of the product as fits. */
const titleOf = (rule: RuleMeta): string => {
  const long = `${rule.id}: a rule of ${PRODUCT_NAME}`;

  return long.length <= 60 ? long : `${rule.id} | ${PRODUCT_NAME}`;
};

/** A description within 160 characters: what the rule finds, cut at a word when it is longer. */
const descriptionOf = (rule: RuleMeta): string => {
  const lead = `${rule.id}, a rule of the ${AUDIT_LABEL[auditOf(rule)]}: ${rule.description}`;

  if (lead.length <= 160) {
    return lead.length >= 70
      ? lead
      : `${lead} What to change, and how to run it.`;
  }

  return `${lead.slice(0, lead.lastIndexOf(" ", 157))}…`;
};

export const rulePage = (rule: RuleMeta): string => {
  const audit = auditOf(rule);
  const category = CATEGORY_LABEL[rule.category];
  const usage = ruleUsage(rule);
  const docs = rule.docs ? safeHref(rule.docs) : null;
  const same = ALL_RULES.filter((other) => other.category === rule.category);
  const others = neighbours(rule, same);
  const url = `${SITE_ORIGIN}${rulePath(rule.id)}`;
  const description = descriptionOf(rule);

  const when = rule.requires
    ? REQUIREMENTS[rule.requires].when
    : `Runs on every ${AUDIT_LABEL[audit]}: of a page, a crawl, a build directory or HTML.`;

  return layout({
    path: rulePath(rule.id),
    title: titleOf(rule),
    description,
    data: {
      "@type": "WebPage",
      name: rule.id,
      url,
      description,
      isPartOf: {
        "@type": "WebPage",
        name: `The rules of ${PRODUCT_NAME}`,
        url: `${SITE_ORIGIN}/rules`,
      },
      breadcrumb: {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Rules",
            item: `${SITE_ORIGIN}/rules`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: category,
            item: `${SITE_ORIGIN}/rules#${rule.category}`,
          },
          { "@type": "ListItem", position: 3, name: rule.id, item: url },
        ],
      },
      publisher,
    },
    body: `<section class="hero hero-glow rule-hero" aria-labelledby="rule-title">
<div class="wrap">
<nav class="crumbs rise" aria-label="Breadcrumb"><ol><li><a href="/rules">Rules</a></li><li><a href="/rules#${rule.category}">${category}</a></li><li aria-current="page">${esc(rule.id)}</li></ol></nav>
<h1 class="rule-id rise" id="rule-title" style="--d:60ms">${esc(rule.id)}</h1>
<div class="rule-chips sev-${rule.severity} rise" style="--d:90ms">${severityChip(rule.severity)}<span class="chip">${AUDIT_LABEL[audit]}</span>${rule.requires ? `<span class="chip">${REQUIREMENTS[rule.requires].tag}</span>` : ""}</div>
<p class="lede rise" style="--d:120ms">${esc(rule.description)}</p>
</div>
</section>
<div class="wrap rule-layout sev-${rule.severity}">
<div class="rule-main">
<section class="rule-section" aria-labelledby="todo-title">
<h2 id="todo-title">What to change</h2>
<div class="rule-todo-card"><p>${esc(rule.recommendation)}</p>${docs && rule.docs ? `<a class="link-arrow" href="${docs}" rel="noopener">The documentation on ${esc(new URL(rule.docs).hostname.replace(/^www\./u, ""))}${icon("arrow", "arrow")}</a>` : ""}</div>
<p class="rule-note">A finding of this rule on a page carries the exact edits for that page: the markup it quotes, and what to write instead.</p>
</section>
<section class="rule-section" aria-labelledby="when-title">
<h2 id="when-title">When it runs</h2>
<p>${esc(when)} ${esc(severityMeans(rule.severity))}</p>
<p class="rule-note">The severity here is the rule's usual one: a finding can be raised or lowered when the page gives a reason.</p>
</section>
<section class="rule-section" aria-labelledby="run-title">
<h2 id="run-title">Run it, or skip it</h2>
<p>Check a page for this rule alone, after a fix for instance:</p>
<pre data-copy="rule_command"><code>${esc(usage.command)}</code></pre>
<p>Or from an assistant, with the MCP tool <code>${usage.tool}</code>:</p>
<pre data-copy="rule_tool_call"><code>${esc(JSON.stringify(usage.args, null, 2))}</code></pre>
<p>To leave it out of an audit, pass <code>--disable ${esc(rule.id)}</code> on the command, or <code>disableRules: ["${esc(rule.id)}"]</code> to a tool.</p>
</section>
<section class="rule-section" aria-labelledby="related-title">
<div class="rule-section-head"><h2 id="related-title">More in ${category}</h2><a class="link-arrow" href="/rules#${rule.category}">All ${plural(same.length, "rule")}${icon("arrow", "arrow")}</a></div>
${others.length > 0 ? `<ul class="rule-links">${others.map(ruleLink).join("")}</ul>` : "<p>This is the only rule in its category.</p>"}
</section>
${pager(rule)}
</div>
<aside class="rule-aside" aria-label="About this rule">
<dl class="facts facts-text">
${fact("Severity", severityChip(rule.severity))}
${fact("Audit", AUDIT_LABEL[audit])}
${fact("Category", `<a href="/rules#${rule.category}">${category}</a>`)}
${fact("Runs", rule.requires ? `<code>${REQUIREMENTS[rule.requires].tag}</code>` : "Every audit")}
${fact("Where", runsWhere(rule))}
</dl>
<div class="rule-aside-actions">
<a class="btn btn-primary" href="/">Audit a page${icon("arrow", "arrow")}</a>
<a class="btn btn-secondary" href="${esc(wrongFindingUrl(rule.id))}">Report a wrong finding</a>
</div>
<p class="rule-aside-note">Does this rule report a problem a page does not have? Tell us: an agent fixes what the audit reports, so a wrong finding makes work nobody needed.</p>
</aside>
</div>`,
  });
};
