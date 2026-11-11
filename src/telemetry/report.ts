/**
 * What an audit found, as the analytics count it: pages, findings per severity and the ids of the
 * rules that fired, which are the tool's own. The CLI's `cli_command` (issue #57) and the hosted
 * server's `$mcp_tool_call` (issue #84) send it; it runs in Node and in a Worker.
 */
import type { AeoAudit, Audit, SeverityCounts } from "../core/types.js";

/** The most rule ids an event lists. */
const MAX_RULES = 100;

/** What an audit found, in numbers and rule ids: the rules are the tool's own. */
export interface RunReport {
  pages: number;
  counts: SeverityCounts;
  rules: string[];
}

const ids = (list: { rule: string }[] | undefined): string[] =>
  (list ?? []).map((item) => item.rule);

export const runReport = (report: Audit | AeoAudit): RunReport => {
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
