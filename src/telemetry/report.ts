/**
 * What an audit found, as the analytics count it: pages, findings per severity and the ids of the
 * rules that fired, which are the tool's own. The CLI's `cli_command` (issue #57) and the hosted
 * server's `$mcp_tool_call` (issue #84) send it; it runs in Node and in a Worker.
 */
import { competitorCounts } from "../core/compare.js";
import type {
  AeoAudit,
  Audit,
  Comparison,
  SeverityCounts,
} from "../core/types.js";

/** The most rule ids an event lists. */
const MAX_RULES = 100;

/** What a run found, in numbers and rule ids: the rules are the tool's own. */
interface ReportBase {
  pages: number;
  rules: string[];
}

/** What an audit found: its findings per severity too. */
export interface AuditReport extends ReportBase {
  counts: SeverityCounts;
}

/** What a comparison found (issue #129): its gaps, as it has no findings to count. */
export interface ComparisonReport extends ReportBase {
  gaps: number;
}

export type RunReport = AuditReport | ComparisonReport;

const ids = (list: { rule: string }[] | undefined): string[] =>
  (list ?? []).map((item) => item.rule);

export const runReport = (report: Audit | AeoAudit): AuditReport => {
  let rules: string[];
  let pages: number;

  switch (report.kind) {
    case "page": {
      rules = ids(report.findings);
      pages = 1;
      break;
    }

    case "site": {
      rules = [...ids(report.siteFindings), ...ids(report.issues)];
      pages = report.pages.length;
      break;
    }

    default: {
      rules = [...ids(report.findings), ...ids(report.issues)];
      pages = report.pages?.length ?? 1;
    }
  }

  return {
    pages,
    counts: report.counts,
    rules: [...new Set(rules)].toSorted().slice(0, MAX_RULES),
  };
};

/**
 * What a comparison found (issue #129): the pages it read, its gaps, and the rules whose fix closes
 * one, which fired on the page. It has no findings of its own to count.
 */
export const comparisonReport = (comparison: Comparison): ComparisonReport => ({
  // The page, and each competitor it read.
  pages: competitorCounts(comparison).read + 1,
  rules: [...new Set(comparison.gaps.flatMap((g) => g.rules))]
    .toSorted()
    .slice(0, MAX_RULES),
  gaps: comparison.gaps.length,
});
