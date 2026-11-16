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
import { fieldRules } from "./field.js";
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
  ...fieldRules,
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
 * that are no rule, category or rule id's prefix, or the other audit's.
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

/** What a rule id has before its dot: `robots` of `robots.noindex`. Every rule id has a dot. */
const prefixOf = (id: string): string => id.slice(0, id.indexOf("."));

/**
 * Rule names as the ids of `rules`: a category stands for its rules among them (issue #121), as an
 * agent on a structured-data pass names `structured-data`, and so does what an id has before its
 * dot (issue #187): an agent checking indexing names `robots`, and one checking share tags `og`,
 * though their categories are `indexing` and `social`. Where a category and a prefix are the same
 * word, as `links` is, the category holds every rule the prefix does. Every rule id has a dot and
 * no category has one, so neither reads as the other. A name that is none of them stays as given.
 */
const ruleIdsOf = (
  names: readonly string[],
  rules: readonly RuleMeta[]
): string[] =>
  names.flatMap((name) => {
    const named = rules.filter(
      (r) => r.category === name || prefixOf(r.id) === name
    );

    return named.length > 0 ? named.map((r) => r.id) : [name];
  });

/** At most this many ids follow an unknown name in the error. */
const MAX_SUGGESTIONS = 6;

/**
 * Ids of `rules` an agent may have meant by `name`: those holding the word after its last dot, as
 * `response.status` finds `response.error-status` and `noindex` finds `robots.noindex`. A word
 * under three letters matches too much to help. The rules every audit runs come first, and a rule
 * that needs more (a crawl, `--render`) says so, as `agentic-seo-check rules` does: named on a
 * page audit without it, the rule runs nothing, and the re-check counts its findings `notChecked`.
 */
const suggestionsFor = (name: string, rules: readonly RuleMeta[]): string[] => {
  const word = name.slice(name.lastIndexOf(".") + 1).toLowerCase();

  if (word.length < 3) {
    return [];
  }

  const near = rules.filter((r) => r.id.includes(word));

  return [...near.filter((r) => !r.requires), ...near.filter((r) => r.requires)]
    .slice(0, MAX_SUGGESTIONS)
    .map((r) => (r.requires ? `${r.id} (requires ${r.requires})` : r.id));
};

/** Fails on ids that are none of `rules`, the rules an audit runs; `kind` names it. */
const checkRuleIds = (
  ids: readonly string[],
  rules: readonly RuleMeta[],
  kind: "SEO" | "AEO"
): void => {
  const known = new Set(rules.map((r) => r.id));
  const unknown = [...new Set(ids.filter((id) => !known.has(id)))];

  if (unknown.length === 0) {
    return;
  }

  const other = kind === "SEO" ? AEO_RULES : SEO_RULES;

  const otherNames = new Set(
    other.flatMap((r) => [r.id, r.category, prefixOf(r.id)])
  );

  // The caller's input: an error the tool explains, not a bug (issue #60).
  if (unknown.every((id) => otherNames.has(id))) {
    throw new RuleNamesError(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not ${kind} rules; run ${kind === "SEO" ? "the AEO audit (aeo, seo_aeo_audit)" : "the SEO audit (audit, crawl)"} for ${unknown.length === 1 ? "it" : "them"}.`,
      "other_audit_rules"
    );
  }

  // Each unknown name with the ids it comes close to, so the next call can name them.
  const named = unknown.map((id) => {
    const near = suggestionsFor(id, rules);

    return near.length > 0 ? `${id} (perhaps ${near.join(", ")})` : id;
  });

  throw new RuleNamesError(
    `Unknown rule id(s): ${named.join(", ")}. Name rule ids, their categories (${categoriesOf(rules).join(", ")}), or what an id has before its dot. List the rules with \`agentic-seo-check rules\` or seo_list_rules.`,
    "unknown_rules"
  );
};

/**
 * `options` with `onlyRules` and `disableRules` as the ids of `rules`, the rules an audit runs, a
 * category or an id's prefix standing for its rules. Fails on `onlyRules` that name none of them,
 * before any request goes out, so a typo fails loudly instead of running nothing, and names the
 * ids it comes close to; `kind` names the audit for the message. A name in `disableRules` that is
 * none of them is kept, as before: it turns nothing off.
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
