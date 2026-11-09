import { isCut } from "../../src/core/rules/fix.js";
import type { Finding, FixEdit } from "../../src/core/types.js";

/** Each edit of each finding, with the finding it belongs to. */
export const editsOf = (findings: Finding[]): [Finding, FixEdit][] =>
  findings.flatMap((f) => (f.fix ?? []).map((e): [Finding, FixEdit] => [f, e]));

/** Findings without a fix; `tool.*` findings are about this machine and have none. */
export const withoutFix = (findings: Finding[]): string[] =>
  findings.flatMap((f) =>
    f.rule.startsWith("tool.") || f.fix?.length ? [] : [f.rule]
  );

/**
 * HTML edits whose `current` is not in `source` as written: a fix an agent could not find. A quote
 * cut short (ending in "…") is left out.
 */
export const unquotedEdits = (
  findings: Finding[],
  source: string
): [string, string][] =>
  editsOf(findings).flatMap(([f, e]): [string, string][] =>
    e.in === "html" &&
    e.current !== undefined &&
    !isCut(e.current) &&
    !source.includes(e.current)
      ? [[f.rule, e.current]]
      : []
  );

/**
 * Edits missing a part their action needs (replace: current and code, remove: current, add: at
 * and code), or with a `{{…}}` slot that is not closed or not explained in `write`.
 */
export const incompleteEdits = (findings: Finding[]): [string, FixEdit][] =>
  editsOf(findings).flatMap(([f, e]): [string, FixEdit][] => {
    const code = e.code ?? "";
    const slots = code.match(/\{\{[^{}]+\}\}/gu) ?? [];
    const opens = code.split("{{").length - 1;
    const closes = code.split("}}").length - 1;

    const broken =
      (e.action === "replace" &&
        (e.current === undefined || e.code === undefined)) ||
      (e.action === "remove" && e.current === undefined) ||
      (e.action === "add" && (!e.at || e.code === undefined)) ||
      slots.length !== opens ||
      slots.length !== closes ||
      (slots.length > 0 && !e.write);

    return broken ? [[f.rule, e]] : [];
  });
