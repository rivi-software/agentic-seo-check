import { AEO_SITE_RULES } from "../aeo/site-rules.js";
import { caughtError, ExpectedError } from "../errors.js";
import { PERFORMANCE_RULES } from "../performance-rules.js";
import { RENDER_RULES } from "../render-rules.js";
import { SITE_RULES } from "../site-rules.js";
import type { Finding, RuleMeta } from "../types.js";
import { aeoRules } from "./aeo.js";
import { canonicalRules } from "./canonical.js";
import { contentRules } from "./content.js";
import { discoverRules } from "./discover.js";
import { documentRules } from "./document.js";
import { headRules } from "./head.js";
import { headingRules } from "./headings.js";
import { hreflangRules } from "./hreflang.js";
import { imageRules } from "./images.js";
import { indexingRules } from "./indexing.js";
import { keywordRules } from "./keyword.js";
import { linkRules } from "./links.js";
import { loadingRules } from "./loading.js";
import { metaRules } from "./meta.js";
import { responseRules } from "./response.js";
import type { PageContext, Rule } from "./rule.js";
import { socialRules } from "./social.js";
import { structuredDataEligibilityRules } from "./structured-data-eligibility.js";
import { structuredDataValueRules } from "./structured-data-values.js";
import { structuredDataRules } from "./structured-data.js";
import { titleRules } from "./title.js";
import { urlRules } from "./urls.js";

export type { PageContext, Rule } from "./rule.js";

/** Rules evaluated against a single HTML document. */
export const PAGE_RULES: Rule[] = [
  ...titleRules,
  ...metaRules,
  ...headingRules,
  ...canonicalRules,
  ...indexingRules,
  ...discoverRules,
  ...documentRules,
  ...headRules,
  ...socialRules,
  ...imageRules,
  ...linkRules,
  ...urlRules,
  ...loadingRules,
  ...hreflangRules,
  ...structuredDataRules,
  ...structuredDataValueRules,
  ...structuredDataEligibilityRules,
  ...contentRules,
  ...keywordRules,
  ...responseRules,
];

/** Rules the AEO audit evaluates against each page; the SEO audit never runs them. */
export const AEO_PAGE_RULES: Rule[] = aeoRules;

/** Metadata for every rule the tool can emit, including rules implemented outside the page-rule loop. */
export const ALL_RULES: RuleMeta[] = [
  ...PAGE_RULES.map((r) => r.meta),
  ...RENDER_RULES,
  ...PERFORMANCE_RULES,
  ...SITE_RULES,
  ...AEO_PAGE_RULES.map((r) => r.meta),
  ...AEO_SITE_RULES,
];

export interface RunRulesOptions {
  /** Rule ids to skip. */
  disable?: Set<string>;
  /** Run only these rule ids. */
  only?: Set<string>;
  /** The rules to run (default: the SEO page rules). */
  rules?: Rule[];
}

export const sortFindings = (findings: Finding[]): Finding[] => {
  const rank = { error: 0, warning: 1, info: 2 } as const;

  return findings.toSorted(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule)
  );
};

export const runPageRules = (
  ctx: PageContext,
  options: RunRulesOptions = {}
): Finding[] => {
  const findings: Finding[] = [];

  for (const rule of options.rules ?? PAGE_RULES) {
    if (
      options.disable?.has(rule.meta.id) ||
      (options.only && !options.only.has(rule.meta.id))
    ) {
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
    } catch (error) {
      // A bug of the rule's, on a page it did not expect: the CLI's and the local MCP server's
      // error tracking hears it, with the rule's id (issue #85).
      caughtError(error, { rule: rule.meta.id });

      findings.push({
        rule: "tool.rule-error",
        severity: "info",
        category: "tool",
        message: `Rule ${rule.meta.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        recommendation:
          "Report this as a bug at https://github.com/rivi-software/agentic-seo-check/issues; the rest of the audit is unaffected.",
        url: ctx.page.url,
      });
    }
  }

  return sortFindings(findings);
};

export const findRule = (id: string): RuleMeta | undefined =>
  ALL_RULES.find((r) => r.id === id);

/** The rules the SEO audit evaluates (`audit`, `crawl`), the AEO rules left out. */
export const SEO_RULES: RuleMeta[] = ALL_RULES.filter(
  (r) => r.category !== "aeo"
);

/** The rules the AEO audit evaluates. */
export const AEO_RULES: RuleMeta[] = ALL_RULES.filter(
  (r) => r.category === "aeo"
);

/**
 * Why `--rule` names nothing an audit runs, for the hosted server's analytics (issue #121): names
 * that are no rule or category, or the other audit's.
 */
export type RuleNamesReason = "unknown_rules" | "other_audit_rules";

/** `--rule` names that are no rule of the audit's: its message says what to name instead. */
export class RuleNamesError extends ExpectedError {
  override name = "RuleNamesError";
  declare readonly reason: RuleNamesReason;

  constructor(message: string, reason: RuleNamesReason) {
    super(message, { reason });
  }
}

const categoriesOf = (rules: readonly RuleMeta[]): string[] => [
  ...new Set(rules.map((r) => r.category)),
];

/**
 * Rule names as the ids of `rules`: a category stands for its rules among them (issue #121), as an
 * agent on a structured-data pass names `structured-data`. Every rule id has a dot and no category
 * has one, so neither reads as the other. A name that is neither stays as it was given.
 */
const ruleIdsOf = (
  names: readonly string[],
  rules: readonly RuleMeta[]
): string[] =>
  names.flatMap((name) => {
    const inCategory = rules.filter((r) => r.category === name);

    return inCategory.length > 0 ? inCategory.map((r) => r.id) : [name];
  });

/** Fails on ids that are none of `rules`, the rules an audit runs; `kind` names it. */
const checkRuleIds = (
  ids: readonly string[],
  rules: readonly RuleMeta[],
  kind: "SEO" | "AEO"
): void => {
  const known = new Set(rules.map((r) => r.id));
  const unknown = ids.filter((id) => !known.has(id));

  if (unknown.length === 0) {
    return;
  }

  const other = kind === "SEO" ? AEO_RULES : SEO_RULES;
  const otherNames = new Set(other.flatMap((r) => [r.id, r.category]));

  // The caller's input: an error the tool explains, not a bug (issue #60).
  if (unknown.every((id) => otherNames.has(id))) {
    throw new RuleNamesError(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not ${kind} rules; run ${kind === "SEO" ? "the AEO audit (aeo, seo_aeo_audit)" : "the SEO audit (audit, crawl)"} for ${unknown.length === 1 ? "it" : "them"}.`,
      "other_audit_rules"
    );
  }

  throw new RuleNamesError(
    `Unknown rule id(s): ${unknown.join(", ")}. Name rule ids, or their categories (${categoriesOf(rules).join(", ")}). List the rules with \`agentic-seo-check rules\` or seo_list_rules.`,
    "unknown_rules"
  );
};

/**
 * `options` with `onlyRules` and `disableRules` as the ids of `rules`, the rules an audit runs, a
 * category standing for its rules. Fails on `onlyRules` that name none of them, before any request
 * goes out, so a typo fails loudly instead of running nothing; `kind` names the audit for the
 * message. A name in `disableRules` that is neither is kept, as before: it turns nothing off.
 */
export const selectRules = <
  T extends { onlyRules?: string[]; disableRules?: string[] },
>(
  options: T,
  rules: readonly RuleMeta[],
  kind: "SEO" | "AEO"
): T => {
  if (!(options.onlyRules || options.disableRules)) {
    return options;
  }

  const onlyRules = options.onlyRules && ruleIdsOf(options.onlyRules, rules);

  if (onlyRules) {
    checkRuleIds(onlyRules, rules, kind);
  }

  return {
    ...options,
    onlyRules,
    disableRules:
      options.disableRules && ruleIdsOf(options.disableRules, rules),
  };
};
