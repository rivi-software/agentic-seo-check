import { isCut } from "../../src/core/rules/fix.js";
import type { Finding, FixEdit } from "../../src/core/types.js";

/** Each edit of each finding, with the finding it belongs to. */
export const editsOf = (findings: Finding[]): [Finding, FixEdit][] =>
  findings.flatMap((f) => (f.fix ?? []).map((e): [Finding, FixEdit] => [f, e]));

/**
 * Findings that have no fix on purpose: they describe the audit rather than the site (the crawl
 * limit, a crawl the hosted server stopped, a page read in part, a bot probe that could not run),
 * or there is nothing to change (a retired rich result, whose markup answer engines still read).
 * `tool.*` findings are about this machine.
 */
export const RULES_WITHOUT_FIX = new Set([
  "site.crawl-limit-reached",
  "site.crawl-stopped",
  "response.truncated",
  "aeo.page-truncated",
  "aeo.crawl-stopped",
  "aeo.bot-probe-inconclusive",
  "structured-data.retired-type",
]);

/** Findings without a fix, other than those that have none on purpose. */
export const withoutFix = (findings: Finding[]): string[] =>
  findings.flatMap((f) =>
    f.rule.startsWith("tool.") || RULES_WITHOUT_FIX.has(f.rule) || f.fix?.length
      ? []
      : [f.rule]
  );

/**
 * HTML edits of this page whose `current` is not in `source` as written: a fix an agent could not
 * find. Edits of another page (`url` set) and quotes cut short (ending in "…") are left out.
 */
export const unquotedEdits = (
  findings: Finding[],
  source: string
): [string, string][] =>
  editsOf(findings).flatMap(([f, e]): [string, string][] =>
    e.in === "html" &&
    e.url === undefined &&
    e.current !== undefined &&
    !isCut(e.current) &&
    !source.includes(e.current)
      ? [[f.rule, e.current]]
      : []
  );

const isWholeFile = (e: FixEdit): boolean =>
  e.in === "asset" && e.at === "whole file";

/**
 * Edits missing a part their action needs (replace: current and code, remove: current, add: at
 * and code), or with a `{{…}}` slot that is not closed or not explained in `write`. An asset
 * replace at "whole file" changes the file itself and quotes nothing.
 */
export const incompleteEdits = (findings: Finding[]): [string, FixEdit][] =>
  editsOf(findings).flatMap(([f, e]): [string, FixEdit][] => {
    const code = e.code ?? "";
    const slots = code.match(/\{\{[^{}]+\}\}/gu) ?? [];
    const opens = code.split("{{").length - 1;
    const closes = code.split("}}").length - 1;

    const broken =
      (e.action === "replace" &&
        ((e.current === undefined && !isWholeFile(e)) ||
          e.code === undefined)) ||
      (e.action === "remove" && e.current === undefined) ||
      (e.action === "add" && (!e.at || e.code === undefined)) ||
      slots.length !== opens ||
      slots.length !== closes ||
      (slots.length > 0 && !e.write);

    return broken ? [[f.rule, e]] : [];
  });
