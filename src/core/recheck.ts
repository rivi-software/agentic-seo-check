import { createHash } from "node:crypto";

import { z } from "zod";

import { ExpectedError } from "./errors.js";
import { findingKey } from "./rules/rule.js";
import type { PageRecord } from "./site-rules.js";
import type {
  BaselineComparison,
  Finding,
  FixedFinding,
  Requirement,
  RuleMeta,
  Severity,
} from "./types.js";

/** One finding of an earlier audit. Only `id` is required: an MCP client may have nothing else. */
export interface BaselineEntry {
  id: string;
  rule?: string;
  severity?: Severity;
  url?: string;
  message?: string;
}

/** What an earlier audit reported, for a re-check. */
export type Baseline = readonly BaselineEntry[];

const hash = (text: string, length: number): string =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

/** The part of an id that names the page: a hash of the finding's URL, or of "" for a site-wide finding. */
const urlPart = (url: string | undefined): string => hash(url ?? "", 8);

/** A finding's id before any numbering: its rule, page and, when it has one, its key. */
const baseId = (f: Finding): string => {
  const key = findingKey(f);

  return `${f.rule}@${urlPart(f.url)}${key ? `:${hash(key, 4)}` : ""}`;
};

/**
 * Gives each finding an id that stays the same while the problem does: `rule@<URL hash>`, plus
 * `:<key hash>` when the rule reports more than one finding per page and says which one this is.
 * Findings that would still share an id are numbered in order (`~1`, `~2`): which is which can
 * change between audits, so a re-check never calls one of them fixed.
 */
export const assignIds = (findings: readonly Finding[]): void => {
  const count = new Map<string, number>();

  for (const f of findings) {
    count.set(baseId(f), (count.get(baseId(f)) ?? 0) + 1);
  }

  const seen = new Map<string, number>();

  for (const f of findings) {
    const id = baseId(f);

    if ((count.get(id) ?? 0) > 1) {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      f.id = `${id}~${n}`;
    } else {
      f.id = id;
    }
  }
};

const ID =
  /^(?<base>(?<rule>[^@]+)@(?<url>[\da-f]{8})(?::[\da-f]{4})?)(?<numbered>~\d+)?$/u;

/** An id without its number: `rule@<URL hash>[:<key hash>]`. */
const baseOf = (id: string): string | undefined => ID.exec(id)?.groups?.base;

/** Baseline entries for finding ids, such as an MCP client passes back. */
export const baselineFromIds = (ids: readonly string[]): BaselineEntry[] =>
  ids.map((id) => ({ id }));

/** What the re-check ran: which rules, on which pages. */
export interface RecheckScope {
  /**
   * URLs this audit checked page rules on, in every form a finding may carry (requested, final,
   * file URL).
   */
  urls: Iterable<string>;
  /** The audit ran site rules (a crawl, a directory, an AEO audit with a site): site-wide findings count. */
  site: boolean;
  /** Whether a rule ran this time; the caller knows the options. */
  ruleRan: (rule: string) => boolean;
  /**
   * Findings this audit made but left out of its output (info, with `includeInfo: false`): still
   * on the page, so never fixed, and not listed as open or new either.
   */
  hidden?: readonly Finding[];
}

/** What the re-check knows of this audit, to tell whether an earlier finding was checked again. */
interface Checked {
  /** Hashes of the URLs whose findings this audit checked. */
  urls: Set<string>;
  shownIds: Set<string>;
  hiddenIds: Set<string>;
  /** Base ids of findings numbered now (`~n`), whose ids may have swapped. */
  numbered: Set<string>;
  scope: RecheckScope;
}

const idsOf = (findings: readonly Finding[]): Set<string> =>
  new Set(findings.flatMap((f) => (f.id ? [f.id] : [])));

/**
 * The fixed finding an earlier entry stands for, or null when this audit could not have reported
 * it again: its rule did not run on its page, it is only hidden (`includeInfo: false`), or its id
 * was numbered and may now belong to another finding.
 */
const fixedEntry = (entry: BaselineEntry, c: Checked): FixedFinding | null => {
  const parts = ID.exec(entry.id)?.groups;
  const rule = entry.rule ?? parts?.rule;

  if (
    !parts?.url ||
    !parts.base ||
    !rule ||
    parts.numbered ||
    c.numbered.has(parts.base) ||
    c.hiddenIds.has(entry.id) ||
    !c.scope.ruleRan(rule)
  ) {
    return null;
  }

  const onPage =
    parts.url === urlPart(undefined) ? c.scope.site : c.urls.has(parts.url);

  if (!onPage) {
    return null;
  }

  const out: FixedFinding = { id: entry.id, rule };

  if (entry.url) {
    out.url = entry.url;
  }

  if (entry.message) {
    out.message = entry.message;
  }

  return out;
};

/**
 * Compares this audit's findings with an earlier audit's. An earlier finding counts as fixed only
 * when this audit could have reported it again: its rule ran, on its page. Everything else is
 * `notChecked`, so a narrower re-check (`rules`, one page of a crawl, `includeInfo: false`) never
 * reports a fix it did not see.
 */
export const compareWithBaseline = (
  findings: readonly Finding[],
  baseline: Baseline,
  scope: RecheckScope
): BaselineComparison => {
  const urls = new Set<string>();

  for (const u of scope.urls) {
    urls.add(urlPart(u));
  }

  for (const f of findings) {
    if (f.url) {
      urls.add(urlPart(f.url));
    }
  }

  const shownIds = idsOf(findings);
  const hiddenIds = idsOf(scope.hidden ?? []);

  const numbered = new Set(
    [...shownIds, ...hiddenIds].flatMap((id) => {
      const groups = ID.exec(id)?.groups;

      return groups?.numbered && groups.base ? [groups.base] : [];
    })
  );

  const checked: Checked = { urls, shownIds, hiddenIds, numbered, scope };
  const fixed: FixedFinding[] = [];
  let notChecked = 0;

  for (const entry of baseline) {
    if (!shownIds.has(entry.id)) {
      const out = fixedEntry(entry, checked);

      if (out) {
        fixed.push(out);
      } else {
        notChecked += 1;
      }
    }
  }

  const beforeIds = new Set(baseline.map((b) => b.id));

  // A finding numbered before or now matches no earlier id by its number, which may have moved:
  // one whose base id the earlier audit had is still open, not new.
  const beforeBases = new Set(
    baseline.flatMap((b) => {
      const base = baseOf(b.id);

      return base ? [base] : [];
    })
  );

  const open: string[] = [];
  const added: string[] = [];

  for (const f of findings) {
    if (f.id) {
      const base = baseOf(f.id);

      const before =
        beforeIds.has(f.id) || (base !== undefined && beforeBases.has(base));

      (before ? open : added).push(f.id);
    }
  }

  return { fixed, open, new: added, notChecked };
};

/** The rule options of an audit, for `ruleRanWith`. */
export interface RuleSelection {
  /** Run only these rule ids. */
  onlyRules?: readonly string[];
  disableRules?: readonly string[];
  /** The capabilities the audit had: render, lighthouse, crawl, keyword, ai-bots. */
  active: ReadonlySet<Requirement>;
}

/**
 * Whether a rule ran in an audit with these options. `rules` are the rules the audit evaluates
 * (SEO or AEO); a rule outside them, or one that needs a capability the audit did not have, did
 * not run.
 */
export const ruleRanWith = (
  selection: RuleSelection,
  rules: readonly RuleMeta[]
): ((rule: string) => boolean) => {
  const only = selection.onlyRules ? new Set(selection.onlyRules) : null;
  const disabled = new Set(selection.disableRules);
  const byId = new Map(rules.map((r) => [r.id, r]));

  return (rule) => {
    if ((only && !only.has(rule)) || disabled.has(rule)) {
      return false;
    }

    // Findings of the tool itself: whether their check ran follows from the option they belong to.
    if (rule === "tool.render-unavailable") {
      return selection.active.has("render");
    }

    if (rule === "tool.lighthouse-unavailable") {
      return selection.active.has("lighthouse");
    }

    if (rule === "tool.rule-error" || rule === "response.fetch-failed") {
      return true;
    }

    const meta = byId.get(rule);

    return (
      meta !== undefined &&
      (!meta.requires || selection.active.has(meta.requires))
    );
  };
};

const savedFinding = z.object({
  id: z.string(),
  rule: z.string(),
  severity: z.enum(["error", "warning", "info"]).optional(),
  url: z.string().optional(),
  message: z.string().optional(),
});

const savedCounts = z.object({
  error: z.number(),
  warning: z.number(),
  info: z.number(),
});

const total = (counts: z.infer<typeof savedCounts>): number =>
  counts.error + counts.warning + counts.info;

// Findings saved before ids existed have none; they are left out rather than failing the parse.
const savedFindings = z
  .array(z.unknown())
  .default([])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = savedFinding.safeParse(item);

      return parsed.success ? [parsed.data] : [];
    })
  );

const savedAudit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), findings: savedFindings }),
  // `counts` covers every finding, also those a crawl with `--page-detail summary` leaves out.
  z.object({
    kind: z.literal("aeo"),
    findings: savedFindings,
    counts: savedCounts.optional(),
  }),
  z.object({
    kind: z.literal("site"),
    siteFindings: savedFindings,
    pages: z
      .array(
        z.object({ findings: savedFindings, counts: savedCounts.optional() })
      )
      .default([]),
  }),
]);

/**
 * The findings of an audit the CLI or the library wrote as JSON, for `--baseline`. A site audit
 * written with `--page-detail summary` has no page findings to compare with, so it is refused.
 */
export const baselineFromAudit = (json: string): BaselineEntry[] => {
  let data: ReturnType<typeof JSON.parse>;

  try {
    data = JSON.parse(json);
  } catch {
    throw new ExpectedError(
      "The baseline is not JSON. Save the first audit with --format json."
    );
  }

  const parsed = savedAudit.safeParse(data);

  if (!parsed.success) {
    throw new ExpectedError(
      'The baseline is not an audit: expected the JSON of an earlier run ("kind": "page", "site" or "aeo").'
    );
  }

  const audit = parsed.data;

  if (audit.kind === "page") {
    return audit.findings;
  }

  // A crawl saved with `--page-detail summary` drops page findings; comparing with it would call
  // every page finding new.
  const summarised =
    audit.kind === "site"
      ? audit.pages.some(
          (p) => p.counts !== undefined && p.findings.length < total(p.counts)
        )
      : audit.counts !== undefined &&
        audit.findings.length < total(audit.counts);

  if (summarised) {
    throw new ExpectedError(
      "The baseline audit lists no page findings (it ran with --page-detail summary). Run it again with --page-detail full."
    );
  }

  return audit.kind === "site"
    ? [...audit.siteFindings, ...audit.pages.flatMap((p) => p.findings)]
    : audit.findings;
};

/** `obj` with `key` set to `value` just before `before`, so the JSON reads in that order. */
export const insertBefore = <T extends object, K extends keyof T>(
  obj: T,
  before: keyof T,
  key: K,
  value: T[K]
): T => {
  const out: Partial<T> = {};

  // SAFETY: Object.keys of a T lists keys of T.
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (k === before) {
      out[key] = value;
    }

    if (k !== key) {
      out[k] = obj[k];
    }
  }

  // SAFETY: `out` has every key `obj` has, plus `key`.
  return out as T;
};

/** Every form a crawled or scanned page's URL takes in findings. */
export const recordUrls = (records: PageRecord[]): string[] =>
  records.flatMap((r) => [
    r.url,
    r.requestedUrl,
    r.page.url,
    ...(r.response ? [r.response.finalUrl] : []),
    ...(r.file ? [r.file] : []),
  ]);
