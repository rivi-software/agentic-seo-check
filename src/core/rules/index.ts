import { PERFORMANCE_RULES } from "../performance-rules.js";
import { RENDER_RULES } from "../render-rules.js";
import { SITE_RULES } from "../site-rules.js";
import type { Finding, RuleMeta } from "../types.js";
import { canonicalRules } from "./canonical.js";
import { contentRules } from "./content.js";
import { documentRules } from "./document.js";
import { headingRules } from "./headings.js";
import { hreflangRules } from "./hreflang.js";
import { imageRules } from "./images.js";
import { indexingRules } from "./indexing.js";
import { keywordRules } from "./keyword.js";
import { linkRules } from "./links.js";
import { metaRules } from "./meta.js";
import { responseRules } from "./response.js";
import type { PageContext, Rule } from "./rule.js";
import { socialRules } from "./social.js";
import { structuredDataRules } from "./structured-data.js";
import { titleRules } from "./title.js";

export type { PageContext, Rule } from "./rule.js";

/** Rules evaluated against a single HTML document. */
export const PAGE_RULES: Rule[] = [
  ...titleRules,
  ...metaRules,
  ...headingRules,
  ...canonicalRules,
  ...indexingRules,
  ...documentRules,
  ...socialRules,
  ...imageRules,
  ...linkRules,
  ...hreflangRules,
  ...structuredDataRules,
  ...contentRules,
  ...keywordRules,
  ...responseRules,
];

/** Metadata for every rule the tool can emit, including rules implemented outside the page-rule loop. */
export const ALL_RULES: RuleMeta[] = [
  ...PAGE_RULES.map((r) => r.meta),
  ...RENDER_RULES,
  ...PERFORMANCE_RULES,
  ...SITE_RULES,
];

export interface RunRulesOptions {
  /** Rule ids to skip. */
  disable?: Set<string>;
}

export function runPageRules(
  ctx: PageContext,
  options: RunRulesOptions = {}
): Finding[] {
  const findings: Finding[] = [];

  for (const rule of PAGE_RULES) {
    if (options.disable?.has(rule.meta.id)) {
      continue;
    }

    if (rule.meta.requires === "keyword" && !ctx.keyword) {
      continue;
    }

    try {
      for (const f of rule.check(ctx)) {
        if (!f.url) {
          f.url = ctx.response?.finalUrl ?? ctx.page.url;
        }

        findings.push(f);
      }
    } catch (err) {
      findings.push({
        rule: "tool.rule-error",
        severity: "info",
        category: "tool",
        message: `Rule ${rule.meta.id} failed: ${(err as Error).message}`,
        recommendation:
          "Report this as a bug at https://github.com/rivi-software/agentic-seo-check/issues; the rest of the audit is unaffected.",
        url: ctx.page.url,
      });
    }
  }

  return sortFindings(findings);
}

export function sortFindings(findings: Finding[]): Finding[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;

  return [...findings].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule)
  );
}

export function findRule(id: string): RuleMeta | undefined {
  return ALL_RULES.find((r) => r.id === id);
}
