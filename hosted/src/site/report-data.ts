/**
 * A report's data, which the website shows as HTML (report.ts, site-report.ts) and draws as a PDF
 * (pdf.ts, issue #157): the groups the findings are shown in and their anchors, what to fix first,
 * and the facts. Nothing here is markup; each renderer quotes the audited site's text its own way.
 */
import type { SiteAudits } from "../../../src/core/aeo/audit.js";
import {
  FIELD_LABELS,
  FIELD_METRICS,
  fieldBand,
  fieldValue,
} from "../../../src/core/field-data.js";
import type { FieldBand } from "../../../src/core/field-data.js";
import { CATEGORY_LABEL } from "../../../src/core/report/labels.js";
import type { Band } from "../../../src/core/report/labels.js";
import { AEO_PAGE_RULES, sortFindings } from "../../../src/core/rules/index.js";
import type {
  AeoAudit,
  Category,
  Finding,
  IssueRollup,
  PageAudit,
  Severity,
  SiteAudit,
} from "../../../src/core/types.js";

/** A score's band in a word, as the terminal's report names it. */
export const BAND_LABEL: Record<Band, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

/** The AEO rules that look at one page, as against those that look at the site's files. */
const AEO_PAGE_RULE_IDS = new Set(AEO_PAGE_RULES.map((rule) => rule.meta.id));

/** The anchor of the item at `index` of the group at the anchor `groupId`. */
const itemId = (groupId: string, index: number): string =>
  `${groupId}-${index + 1}`;

/**
 * One item of a group, at its anchor: a finding with its fix, or, in a site's report, the findings
 * of one rule on the pages, with how many pages have it.
 */
export type Entry =
  | { kind: "finding"; id: string; finding: Finding }
  | { kind: "issue"; id: string; issue: IssueRollup };

/** What every entry has: its severity, its rule, its message, and for a rule on the pages, how many. */
export interface EntryHead {
  severity: Severity;
  rule: string;
  message: string;
  pages?: number;
}

export const headOf = (entry: Entry): EntryHead =>
  entry.kind === "finding" ? entry.finding : entry.issue;

/** A group of findings under its own heading: a category's, or those across the site. */
export interface Group {
  /** Its anchor, which the overview's index links to. */
  id: string;
  label: string;
  /** Its entries in the order it lists them: by severity, as the audits sort them. */
  entries: Entry[];
}

/**
 * Groups of findings, under `title` when it has one: "On the pages" holds a site's page findings
 * by category, under the group of its findings across the site.
 */
export interface Part {
  title?: string;
  groups: Group[];
}

/** One audit's parts and the other's: what a report's two findings sections show. */
export interface ReportParts {
  seo: Part[];
  aeo: Part[];
}

export const severitiesOf = (groups: Group[]): Severity[] =>
  groups.flatMap((group) =>
    group.entries.map((entry) => headOf(entry).severity)
  );

/**
 * `items` by category, the groups in the order their first item comes in: as findings come sorted
 * by severity, the group with the worst finding is first.
 */
const byCategory = <T extends { category: Category }>(
  items: T[]
): [Category, T[]][] => {
  const groups = new Map<Category, T[]>();

  for (const item of items) {
    const group = groups.get(item.category);

    if (group) {
      group.push(item);
    } else {
      groups.set(item.category, [item]);
    }
  }

  return [...groups];
};

/** `findings` as one group, or no group when there are none. */
const findingGroup = (
  id: string,
  label: string,
  findings: Finding[]
): Group[] =>
  findings.length === 0
    ? []
    : [
        {
          id,
          label,
          entries: findings.map((finding, index) => ({
            kind: "finding",
            id: itemId(id, index),
            finding,
          })),
        },
      ];

/** Findings on the pages by rule as one group, or no group when there are none. */
const issueGroup = (
  id: string,
  label: string,
  issues: IssueRollup[]
): Group[] =>
  issues.length === 0
    ? []
    : [
        {
          id,
          label,
          entries: issues.map((issue, index) => ({
            kind: "issue",
            id: itemId(id, index),
            issue,
          })),
        },
      ];

/** `findings` by category, each group at the anchor `<prefix>-<category>`. */
export const categoryGroups = (prefix: string, findings: Finding[]): Group[] =>
  byCategory(findings).flatMap(([category, group]) =>
    findingGroup(`${prefix}-${category}`, CATEGORY_LABEL[category], group)
  );

/** Findings on the pages by rule, grouped by category at the anchors `<prefix>-<category>`. */
const issueGroups = (prefix: string, issues: IssueRollup[]): Group[] =>
  byCategory(issues).flatMap(([category, group]) =>
    issueGroup(`${prefix}-${category}`, CATEGORY_LABEL[category], group)
  );

/**
 * A page's parts: its SEO findings by category, and its AEO findings about the site's files, then
 * its own.
 */
export const pageParts = (seo: PageAudit, aeo: AeoAudit): ReportParts => ({
  seo: [{ groups: categoryGroups("seo", seo.findings) }],
  aeo: [
    {
      groups: [
        ...findingGroup(
          "aeo-site",
          "Across the site",
          aeo.findings.filter((finding) => !AEO_PAGE_RULE_IDS.has(finding.rule))
        ),
        ...findingGroup(
          "aeo-page",
          "On this page",
          aeo.findings.filter((finding) => AEO_PAGE_RULE_IDS.has(finding.rule))
        ),
      ],
    },
  ],
});

/**
 * One audit's findings across the site, with their fixes, then its findings on the pages: by
 * category, or with `categories` false in one group, as the AEO rules all share one category.
 */
const auditSiteParts = (
  prefix: string,
  siteFindings: Finding[],
  issues: IssueRollup[],
  categories = true
): Part[] => {
  const across = findingGroup(
    `${prefix}-site`,
    "Across the site",
    siteFindings
  );

  return categories
    ? [
        { groups: across },
        {
          title: "On the pages, by rule",
          groups: issueGroups(`${prefix}-pages`, issues),
        },
      ]
    : [
        {
          groups: [
            ...across,
            ...issueGroup(`${prefix}-pages`, "On the pages, by rule", issues),
          ],
        },
      ];
};

/** A site's parts, from one crawl's two audits. */
export const siteParts = ({ seo, aeo }: SiteAudits): ReportParts => ({
  seo: auditSiteParts("seo", seo.siteFindings, seo.issues),
  aeo: auditSiteParts("aeo", aeo.findings, aeo.issues ?? [], false),
});

/**
 * The homepage's own findings with their edits, as its page report has them. Its AEO findings
 * about robots.txt and llms.txt are the site's, which the AEO section shows already. Each audit's
 * findings come sorted, the two together do not: sorted again, the group with the worst finding
 * comes first whichever audit it is from.
 */
export const homeFindings = (start: NonNullable<SiteAudits["start"]>) =>
  sortFindings([
    ...start.seo.findings,
    ...start.aeo.findings.filter((f) => AEO_PAGE_RULE_IDS.has(f.rule)),
  ]);

/** An entry to fix first, with the audit it is from. */
export interface Urgent {
  audit: "SEO" | "AEO";
  entry: Entry;
}

const entriesOf = (parts: Part[], audit: Urgent["audit"]): Urgent[] =>
  parts.flatMap((part) =>
    part.groups.flatMap((group) =>
      group.entries.map((entry) => ({ audit, entry }))
    )
  );

/**
 * What to fix first: the errors and warnings of both audits, errors before warnings, each in the
 * order its section lists them. Info is left to the sections: it is seldom what to fix first.
 */
export const urgentEntries = ({ seo, aeo }: ReportParts): Urgent[] => {
  const all = [...entriesOf(seo, "SEO"), ...entriesOf(aeo, "AEO")];

  return (["error", "warning"] as const).flatMap((severity) =>
    all.filter(({ entry }) => headOf(entry).severity === severity)
  );
};

/** How a fact reads at a glance: a good, doubtful or bad value gets a coloured dot. */
export type Tone = "good" | "warn" | "bad" | null;

/** A fact; one without a value is left out. */
export type Fact = [label: string, value: string | null, tone?: Tone];

export const statusTone = (status: number): Tone => {
  if (status < 300) {
    return "good";
  }

  return status < 400 ? "warn" : "bad";
};

/** A page's facts: what it says of itself as a list, its numbers as tiles. */
export interface PageFacts {
  text: Fact[];
  tiles: Fact[];
}

export const seoFactRows = (audit: PageAudit): PageFacts => {
  const { summary, response } = audit;

  return {
    text: [
      ["Title", summary.title],
      ["Description", summary.metaDescription],
      ["Canonical", summary.canonical],
      ["H1", summary.h1.join(" · ")],
      ["Structured data", summary.structuredDataTypes.join(", ")],
    ],
    tiles: [
      [
        "HTTP status",
        response?.status ? String(response.status) : null,
        response?.status ? statusTone(response.status) : null,
      ],
      [
        "Redirects",
        response && response.redirectChain.length > 0
          ? String(response.redirectChain.length)
          : null,
      ],
      [
        "Indexable",
        summary.indexable ? "Yes" : "No",
        summary.indexable ? "good" : "bad",
      ],
      ["Language", summary.lang],
      ["Words", summary.wordCount.toLocaleString("en")],
      [
        "Links",
        `${summary.links.internal} internal, ${summary.links.external} external`,
      ],
      [
        "Images",
        `${summary.images.total}, ${summary.images.missingAlt} without alt`,
        summary.images.missingAlt > 0 ? "warn" : null,
      ],
    ],
  };
};

/** The tone of each value the AEO summary's states take. */
const TONES = {
  found: "good",
  allowed: "good",
  missing: null,
  unreachable: "bad",
  invalid: "warn",
  limited: "warn",
  "snippet-only": "warn",
  blocked: "bad",
  excluded: "bad",
} as const satisfies Record<string, Tone>;

const toned = (label: string, value: keyof typeof TONES | null): Fact => [
  label,
  value,
  value === null ? null : TONES[value],
];

/** The AEO audit's facts: the site's, and with `page` those of the page it audited. */
export const aeoFactRows = (
  audit: AeoAudit,
  scope: "page" | "site"
): Fact[] => {
  const { summary } = audit;
  const page = scope === "page" ? summary.page : null;

  return [
    toned("robots.txt", summary.robotsTxt),
    toned("llms.txt", summary.llmsTxt),
    // Keeping AI training bots out is the owner's choice, so it gets no colour.
    [
      "AI training",
      summary.trainingPreference === "none" ? null : summary.trainingPreference,
    ],
    toned("Google snippets", page?.googleSnippets ?? null),
    toned("Copilot answers", page?.copilotAnswers ?? null),
    ["Question headings", page ? String(page.questions) : null],
    ["Author", page?.author ?? null],
    ["Published", page?.datePublished ?? null],
    ["Modified", page?.dateModified ?? null],
  ];
};

/** The tone of each rating Google gives a metric of the Chrome UX Report. */
const FIELD_TONE: Record<FieldBand, Tone> = {
  good: "good",
  "needs improvement": "warn",
  poor: "bad",
};

/**
 * Real-user Core Web Vitals of a page (issue #130): each 75th percentile in its rating's tone, and
 * a sentence on whose visits they are, or why there are none. Null when the audit did not ask.
 */
export interface FieldFacts {
  tiles: Fact[];
  note: string;
}

export const fieldFactRows = (
  field: PageAudit["fieldData"]
): FieldFacts | null => {
  if (!field) {
    return null;
  }

  if (field.source === null) {
    return { tiles: [], note: field.message };
  }

  return {
    tiles: FIELD_METRICS.map((key): Fact => {
      const metric = field[key];

      return [
        FIELD_LABELS[key],
        metric ? fieldValue(key, metric.p75) : null,
        metric ? FIELD_TONE[fieldBand(key, metric.p75)] : null,
      ];
    }),
    note: `The 75th percentile of real Chrome visits on phones ${field.source === "url" ? "to this page" : "to the whole site, as this page has too few of its own"}, ${field.period.firstDate} to ${field.period.lastDate}, from the Chrome UX Report, which Google ranks on.`,
  };
};

/** A crawl's facts: how far it went, and what it found of robots.txt and the sitemaps. */
export const crawlFactRows = (seo: SiteAudit): Fact[] => {
  const { crawl, robotsTxt, sitemaps } = seo;

  return [
    [
      "Pages audited",
      `${crawl.pagesCrawled} of ${crawl.pagesDiscovered} found`,
    ],
    [
      "Page limit",
      crawl.hitPageLimit
        ? `Reached at ${crawl.maxPages}`
        : `Not reached (${crawl.maxPages})`,
    ],
    ["Links deep", `Up to ${crawl.maxDepth}`],
    ["Links checked", String(crawl.linksChecked)],
    [
      "robots.txt",
      robotsTxt?.found ? "found" : "missing",
      robotsTxt?.found ? "good" : null,
    ],
    [
      "Sitemap URLs",
      sitemaps.sources.length > 0
        ? sitemaps.urlCount.toLocaleString("en")
        : "No sitemap",
      sitemaps.sources.length > 0 ? "good" : null,
    ],
    ["Took", `${Math.max(1, Math.round(crawl.durationMs / 1000))} s`],
  ];
};

/** When an audit ran, as a report handed on says it: "11 November 2026 at 14:05 UTC". */
export const auditedOn = (auditedAt: string): string => {
  const date = new Date(auditedAt);

  const day = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return `${day} at ${date.toISOString().slice(11, 16)} UTC`;
};
