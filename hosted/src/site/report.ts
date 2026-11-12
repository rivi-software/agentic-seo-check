/**
 * The report of a page audit as HTML: the SEO audit and the AEO audit of one page, each with its
 * score and its findings, and every finding with the edits that fix it. What it shows is the
 * audit as the tools return it; no model reads or rewrites it. Everything quoted from the audited
 * page is escaped. A site's report (site-report.ts) is built from the same parts.
 *
 * A report is a stack of cards: its address and buttons, the two scores, a strip of tabs, and
 * under each tab the cards of one section. The overview has what to fix first, an index of the
 * findings as a tile for each group, and the facts; each audit's section has a card for each
 * category of findings; the last is the AI crawlers. The page's script shows one section at a
 * time; without it they follow one another. Printed, or saved as a PDF from the print dialog, the
 * report is every section in turn, on white, with every finding open (ui/style.ts and files.ts).
 */
import { MAKER, PRODUCT_NAME, WEBSITE_URL } from "../../../src/brand.js";
import { compactAeoAudit } from "../../../src/core/aeo/audit.js";
import { compactAudit } from "../../../src/core/audit.js";
import {
  FIELD_LABELS,
  FIELD_METRICS,
  fieldBand,
  fieldValue,
} from "../../../src/core/field-data.js";
import type { FieldBand } from "../../../src/core/field-data.js";
import { HOSTED_LIMITS } from "../../../src/core/hosted.js";
import {
  ACTION_LABEL,
  band,
  CATEGORY_LABEL,
  countLabel,
  plural,
  PURPOSE_LABEL,
  SEVERITIES,
  TARGET_LABEL,
} from "../../../src/core/report/labels.js";
import type { Band } from "../../../src/core/report/labels.js";
import {
  renderAeoMarkdown,
  renderMarkdown,
} from "../../../src/core/report/markdown.js";
import { AEO_PAGE_RULES } from "../../../src/core/rules/index.js";
import type {
  AeoAudit,
  AiBotAccess,
  Category,
  Finding,
  FixEdit,
  PageAudit,
  SeverityCounts,
  Severity,
  SiteAudit,
} from "../../../src/core/types.js";
import { ORIGIN as MCP_ORIGIN } from "../limits.js";
import { icon } from "../ui/icons.js";
import { esc, safeHref, scriptSafe } from "./html.js";

const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

/** A score's band in a word, as the terminal's report names it. */
const BAND_LABEL: Record<Band, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

/** The most findings the overview lists to fix first. */
const MAX_FIX_FIRST = 5;

/** The most characters of a finding's evidence the report prints. */
const MAX_EVIDENCE_CHARS = 4000;

export const code = (text: string): string => `<code>${esc(text)}</code>`;

export const chip = (text: string): string =>
  `<span class="chip">${text}</span>`;

/** The severity as a coloured label, as the report and the rules page show it. */
export const severityChip = (severity: Severity): string =>
  `<span class="sev">${icon(severity)}${SEVERITY_LABEL[severity]}</span>`;

/** A score out of 100 as a ring that fills to it, coloured by its band. */
export const scoreRing = (score: number, size = ""): string =>
  `<span class="ring band-${band(score)}${size ? ` ${size}` : ""}" aria-hidden="true"><svg viewBox="0 0 64 64"><circle class="ring-track" cx="32" cy="32" r="28"/>${
    score > 0
      ? `<circle class="ring-fill" cx="32" cy="32" r="28" pathLength="100" stroke-dasharray="${score} 100"/>`
      : ""
  }</svg><span class="ring-value">${score}</span></span>`;

/** The counts of each severity, and a bar split by them. */
const countsHtml = (counts: SeverityCounts): string => {
  const total = counts.error + counts.warning + counts.info;

  const parts = SEVERITIES.flatMap((severity) =>
    counts[severity] > 0
      ? [`<i class="is-${severity}" style="--n:${counts[severity]}"></i>`]
      : []
  );

  return `<span class="counts">${SEVERITIES.map(
    (severity) =>
      `<span class="is-${severity}">${countLabel(severity, counts[severity])}</span>`
  ).join("")}</span><span class="sev-bar" aria-hidden="true">${
    total === 0 ? '<i class="is-clear" style="--n:1"></i>' : parts.join("")
  }</span>`;
};

const editHtml = (edit: FixEdit, index: number): string => {
  const where = [
    `${ACTION_LABEL[edit.action]} in ${TARGET_LABEL[edit.in]}`,
    edit.at ? ` at ${code(edit.at)}` : "",
    edit.url ? ` of ${code(edit.url)}` : "",
  ].join("");

  const current = edit.current
    ? `<div class="diff diff-del"><span class="diff-label">Now</span><pre><code>${esc(edit.current)}</code></pre></div>`
    : "";

  const next = edit.code
    ? `<div class="diff diff-add"><span class="diff-label">${edit.action === "add" ? "Add" : "Write"}</span><pre data-copy="fix_edit"><code>${esc(edit.code)}</code></pre></div>`
    : "";

  const write = edit.write
    ? `<p class="edit-write">${icon("pencil")}<span>${esc(edit.write)}</span></p>`
    : "";

  return `<li class="edit"><p class="edit-head"><span class="edit-step">${index + 1}</span><span>${where}</span></p>${current}${next}${write}</li>`;
};

const evidenceHtml = (evidence: NonNullable<Finding["evidence"]>): string => {
  const json = JSON.stringify(evidence, null, 2);

  const shown =
    json.length > MAX_EVIDENCE_CHARS
      ? `${json.slice(0, MAX_EVIDENCE_CHARS)}\n… (the JSON download has all of it)`
      : json;

  return `<details class="evidence"><summary>${icon("chevron")}Evidence</summary><pre><code>${esc(shown)}</code></pre></details>`;
};

/**
 * A finding's closed line: what is wrong first, in words, then the rule that says so and `chips`.
 * The rules across the pages of a site (site-report.ts) are shown the same way.
 */
export const findingSummary = (
  item: { severity: Severity; rule: string; message: string },
  chips = ""
): string =>
  `<summary>${severityChip(item.severity)}<span class="finding-text"><span class="msg">${esc(item.message)}</span><span class="finding-meta">${code(item.rule)}${chips}</span></span>${icon("chevron", "chev")}</summary>`;

const findingHtml = (finding: Finding, id: string): string => {
  const docs = finding.docs ? safeHref(finding.docs) : null;

  const body = [
    `<div class="todo"><p class="label">What to change</p><p>${esc(finding.recommendation)}</p></div>`,
    finding.selector
      ? `<p class="where"><span class="label">Where</span>${code(finding.selector)}</p>`
      : "",
    finding.fix && finding.fix.length > 0
      ? `<div class="fix"><p class="label">The fix</p><ol class="edits">${finding.fix.map(editHtml).join("")}</ol></div>`
      : "",
    finding.evidence && Object.keys(finding.evidence).length > 0
      ? evidenceHtml(finding.evidence)
      : "",
    docs
      ? `<p><a class="link-arrow" href="${docs}" rel="noopener">Documentation${icon("arrow", "arrow")}</a></p>`
      : "",
  ].join("");

  // Errors start open: they are what to fix first.
  return `<details class="finding sev-${finding.severity}" id="${id}"${finding.severity === "error" ? " open" : ""}>
${findingSummary(finding)}
<div class="finding-body">${body}</div>
</details>`;
};

/** The AEO rules that look at one page, as against those that look at the site's files. */
export const AEO_PAGE_RULE_IDS = new Set(
  AEO_PAGE_RULES.map((rule) => rule.meta.id)
);

/** One finding of a group as the overview names it: what it says, and where the report has it. */
export interface GroupItem {
  /** Its anchor: `<the group's id>-<its number in the group>`. */
  id: string;
  severity: Severity;
  rule: string;
  message: string;
  /** How many pages have it, for a rule across the pages of a site. */
  pages?: number;
}

/** The anchor of the item at `index` of the group at the anchor `groupId`. */
export const itemId = (groupId: string, index: number): string =>
  `${groupId}-${index + 1}`;

/** A group of findings in a card of its own: a category's, or those across the site. */
export interface FindingGroup {
  /** Its anchor, which the overview's index links to. */
  id: string;
  label: string;
  /** Its findings as the overview names them, in the order the card lists them. */
  items: GroupItem[];
  /** The findings, as HTML. */
  html: string;
}

const severitiesOf = (groups: FindingGroup[]): Severity[] =>
  groups.flatMap((group) => group.items.map((item) => item.severity));

/**
 * Groups of findings, under `title` when it has one: "On the pages" holds a site's page findings
 * by category, under the group of its findings across the site.
 */
export interface FindingPart {
  title?: string;
  groups: FindingGroup[];
}

/** The counts of the severities that occur in `severities`: "2 errors", "1 warning", "3 info". */
export const tally = (severities: Severity[]): string =>
  `<span class="counts">${SEVERITIES.flatMap((severity) => {
    const count = severities.filter((s) => s === severity).length;

    return count > 0
      ? [`<span class="is-${severity}">${countLabel(severity, count)}</span>`]
      : [];
  }).join("")}</span>`;

/**
 * `items` by category, the groups in the order their first item comes in: as findings come sorted
 * by severity, the group with the worst finding is first.
 */
export const byCategory = <T extends { category: Category }>(
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

const findingsList = (groupId: string, findings: Finding[]): string =>
  `<div class="findings">${findings.map((finding, index) => findingHtml(finding, itemId(groupId, index))).join("\n")}</div>`;

/** `findings` as one group, or no group when there are none. */
export const findingGroup = (
  id: string,
  label: string,
  findings: Finding[]
): FindingGroup[] =>
  findings.length === 0
    ? []
    : [
        {
          id,
          label,
          items: findings.map(({ severity, rule, message }, index) => ({
            id: itemId(id, index),
            severity,
            rule,
            message,
          })),
          html: findingsList(id, findings),
        },
      ];

/** `findings` by category, each group at the anchor `<prefix>-<category>`. */
export const categoryGroups = (
  prefix: string,
  findings: Finding[]
): FindingGroup[] =>
  byCategory(findings).flatMap(([category, group]) =>
    findingGroup(`${prefix}-${category}`, CATEGORY_LABEL[category], group)
  );

const groupHtml = (group: FindingGroup, level: 4 | 5): string =>
  `<div class="finding-group" id="${group.id}"><div class="finding-group-head"><h${level}>${group.label}</h${level}>${tally(severitiesOf([group]))}</div>${group.html}</div>`;

/** Parts of findings with their headings, or `empty` when none of them has a finding. */
export const partsHtml = (parts: FindingPart[], empty: string): string => {
  const shown = parts.filter((part) => part.groups.length > 0);

  if (shown.length === 0) {
    return `<p class="empty">${icon("check")}${empty}</p>`;
  }

  return `<div class="finding-groups">${shown
    .map((part) =>
      part.title
        ? `<div class="finding-part"><div class="finding-group-head finding-part-head"><h4>${part.title}</h4>${tally(severitiesOf(part.groups))}</div>${part.groups.map((group) => groupHtml(group, 5)).join("\n")}</div>`
        : part.groups.map((group) => groupHtml(group, 4)).join("\n")
    )
    .join("\n")}</div>`;
};

/** The worst severity among `severities`, which colours a tile of the index. */
const worst = (severities: Severity[]): Severity | undefined =>
  SEVERITIES.find((severity) => severities.includes(severity));

/** One audit's card in the overview's index: a tile for each of its groups, with their counts. */
const indexCard = (name: string, parts: FindingPart[]): string => {
  const shown = parts.filter((part) => part.groups.length > 0);

  const tiles = shown.flatMap((part) => [
    ...(part.title ? [`<li class="index-sub">${part.title}</li>`] : []),
    ...part.groups.map((group) => {
      const severities = severitiesOf([group]);

      return `<li><a class="index-tile is-${worst(severities) ?? "clear"}" href="#${group.id}"><span class="index-label">${group.label}</span>${tally(severities)}</a></li>`;
    }),
  ]);

  return `<div class="report-card index-card"><div class="card-head"><div><p class="label">Findings by section</p><h4>${name}</h4></div>${tally(shown.flatMap((part) => severitiesOf(part.groups)))}</div>${
    tiles.length === 0
      ? `<p class="index-empty">${icon("check")}No findings</p>`
      : `<ul class="index-tiles">${tiles.join("")}</ul>`
  }</div>`;
};

/** A card of the report under its own heading, with `meta` beside it; nothing without a body. */
export const overviewPart = (
  title: string,
  body: string,
  id = "",
  meta = ""
): string =>
  body
    ? `<div class="report-card report-part"${id ? ` id="${id}"` : ""}><div class="card-head"><h4>${title}</h4>${meta}</div>${body}</div>`
    : "";

/** Cards side by side where the window is wide enough; nothing when none of them has a body. */
export const cardRow = (cards: string[]): string => {
  const shown = cards.filter(Boolean);

  return shown.length === 0
    ? ""
    : `<div class="report-row">${shown.join("")}</div>`;
};

/** The overview's index of both audits' findings, by the groups their sections show them in. */
export const findingsIndex = (seo: FindingPart[], aeo: FindingPart[]): string =>
  `<div class="report-row index-row">${indexCard("SEO: search engines", seo)}${indexCard("AEO: AI answer engines", aeo)}</div>`;

const itemsOf = (parts: FindingPart[], audit: string) =>
  parts.flatMap((part) =>
    part.groups.flatMap((group) => group.items.map((item) => ({ audit, item })))
  );

/**
 * The overview's first card: the errors and warnings of both audits, the worst first, each a link
 * to the finding with its fix. Info is left to the sections: it is seldom what to fix first.
 */
export const fixFirst = (seo: FindingPart[], aeo: FindingPart[]): string => {
  const all = [...itemsOf(seo, "SEO"), ...itemsOf(aeo, "AEO")];

  // Errors before warnings, each in the order its section lists them.
  const urgent = (["error", "warning"] as const).flatMap((severity) =>
    all.filter(({ item }) => item.severity === severity)
  );

  if (urgent.length === 0) {
    return overviewPart(
      "Fix first",
      `<p class="empty">${icon("check")}No errors and no warnings: nothing that has to be fixed.</p>`
    );
  }

  const rows = urgent
    .slice(0, MAX_FIX_FIRST)
    .map(
      ({ audit, item }) =>
        `<li><a class="fix-row sev-${item.severity}" href="#${item.id}">${severityChip(item.severity)}<span class="finding-text"><span class="msg">${esc(item.message)}</span><span class="finding-meta">${code(item.rule)}${chip(audit)}${item.pages === undefined ? "" : chip(plural(item.pages, "page"))}</span></span>${icon("arrow", "arrow")}</a></li>`
    );

  const more = urgent.length - rows.length;

  return overviewPart(
    "Fix first",
    `<ol class="fix-list">${rows.join("")}</ol>${more > 0 ? `<p class="card-foot">And ${more} more in the SEO and AEO findings.</p>` : ""}`,
    "fix-first",
    tally(urgent.map(({ item }) => item.severity))
  );
};

/** The AEO findings of one page: those about the site's files, then the page's own. */
const aeoPageParts = (findings: Finding[]): FindingPart[] => [
  {
    groups: [
      ...findingGroup(
        "aeo-site",
        "Across the site",
        findings.filter((finding) => !AEO_PAGE_RULE_IDS.has(finding.rule))
      ),
      ...findingGroup(
        "aeo-page",
        "On this page",
        findings.filter((finding) => AEO_PAGE_RULE_IDS.has(finding.rule))
      ),
    ],
  },
];

/** One section of a report: its tab, and the panel the tab shows. */
export interface ReportSection {
  id: string;
  tab: string;
  /** The number on the tab: how many findings, rules or pages its panel lists. */
  count?: number;
  /** Whether one of them is an error, which colours the number. */
  errors?: boolean;
  title: string;
  /** Chips beside the panel's heading. */
  chips?: string;
  body: string;
}

const tabHtml = (section: ReportSection): string =>
  `<a href="#${section.id}">${section.tab}${
    section.count === undefined
      ? ""
      : `<span class="tab-count${section.errors ? " has-errors" : ""}"><span class="sr-only">: </span>${section.count}</span>`
  }</a>`;

const panelHtml = (section: ReportSection): string =>
  `<div class="report-panel" id="${section.id}">
<div class="report-section">
<div class="report-section-head"><h3>${section.title}</h3>${section.chips ?? ""}</div>
${section.body}
</div>
</div>`;

/**
 * A report's sections: a strip with a tab for each, then their panels. The page's script makes
 * the strip a tab list that shows one panel at a time; without it the panels follow one another
 * and the strip links to each.
 */
export const sectionsHtml = (sections: ReportSection[]): string =>
  `<nav class="report-tabs" aria-label="Sections of the report">${sections.map(tabHtml).join("")}</nav>
<div class="report-panels">
${sections.map(panelHtml).join("\n")}
</div>`;

/** How a fact reads at a glance: a good, doubtful or bad value gets a coloured dot. */
type Tone = "good" | "warn" | "bad" | null;

export type Fact = [label: string, value: string | null, tone?: Tone];

/** Facts as a list or as tiles; a fact without a value is left out. */
export const facts = (kind: "text" | "tiles", rows: Fact[]): string => {
  const shown = rows.flatMap(([label, value, tone]) =>
    value === null || value === ""
      ? []
      : [
          `<div class="fact"><dt>${label}</dt><dd>${tone ? `<span class="tone tone-${tone}" aria-hidden="true"></span>` : ""}${esc(value)}</dd></div>`,
        ]
  );

  return shown.length === 0
    ? ""
    : `<dl class="facts facts-${kind}">${shown.join("")}</dl>`;
};

export const statusTone = (status: number): Tone => {
  if (status < 300) {
    return "good";
  }

  return status < 400 ? "warn" : "bad";
};

export const seoFacts = (audit: PageAudit): string => {
  const { summary, response } = audit;

  return `${facts("text", [
    ["Title", summary.title],
    ["Description", summary.metaDescription],
    ["Canonical", summary.canonical],
    ["H1", summary.h1.join(" · ")],
    ["Structured data", summary.structuredDataTypes.join(", ")],
  ])}${facts("tiles", [
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
  ])}`;
};

/** The tone of each rating Google gives a metric of the Chrome UX Report. */
const FIELD_TONE: Record<FieldBand, Tone> = {
  good: "good",
  "needs improvement": "warn",
  poor: "bad",
};

/**
 * Real-user Core Web Vitals of a page (issue #130): each 75th percentile as a tile in its rating's
 * tone, and whose visits they are; or why there are none. Nothing when the audit did not ask.
 */
export const fieldFacts = (field: PageAudit["fieldData"]): string => {
  if (!field) {
    return "";
  }

  if (field.source === null) {
    return `<p>${esc(field.message)}</p>`;
  }

  return `${facts(
    "tiles",
    FIELD_METRICS.map((key): Fact => {
      const metric = field[key];

      return [
        FIELD_LABELS[key],
        metric ? fieldValue(key, metric.p75) : null,
        metric ? FIELD_TONE[fieldBand(key, metric.p75)] : null,
      ];
    })
  )}<p>The 75th percentile of real Chrome visits on phones ${field.source === "url" ? "to this page" : "to the whole site, as this page has too few of its own"}, ${esc(field.period.firstDate)} to ${esc(field.period.lastDate)}, from the Chrome UX Report, which Google ranks on.</p>`;
};

/** The card of a page's field data, which the overview shows when the audit has some. */
export const fieldCard = (field: PageAudit["fieldData"]): string =>
  cardRow([
    overviewPart("Real visits on phones", fieldFacts(field), "field-data"),
  ]);

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
export const aeoFacts = (audit: AeoAudit, scope: "page" | "site"): string => {
  const { summary } = audit;
  const page = scope === "page" ? summary.page : null;

  return facts("tiles", [
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
  ]);
};

const botItem = (bot: AiBotAccess): string =>
  `<li class="crawler ${bot.allowed ? "is-allowed" : "is-blocked"}">${code(bot.name)}<span class="crawler-op">${esc(bot.operator)}</span><span class="crawler-state">${icon(bot.allowed ? "check" : "x")}${bot.allowed ? "Allowed" : "Blocked"}</span></li>`;

/**
 * robots.txt's answer for each AI crawler, for `page`: "this page", or a site's start page. None
 * when the audit has no robots.txt answer to show.
 */
export const crawlersSection = (
  audit: AeoAudit,
  page = "this page"
): ReportSection[] => {
  const bots = audit.crawlers?.bots ?? [];

  if (bots.length === 0) {
    return [];
  }

  const allowed = bots.filter((bot) => bot.allowed).length;

  const groups = (["search", "answer", "training"] as const).flatMap(
    (purpose) => {
      const group = bots.filter((bot) => bot.purpose === purpose);

      return group.length === 0
        ? []
        : [
            `<div class="crawler-group is-${purpose}"><h4>${PURPOSE_LABEL[purpose]}</h4><ul>${group.map(botItem).join("")}</ul></div>`,
          ];
    }
  );

  return [
    {
      id: "crawlers",
      tab: "AI crawlers",
      title: "AI crawlers in robots.txt",
      chips: chip(`${allowed} of ${bots.length} may fetch ${page}`),
      body: `<div class="crawler-groups">${groups.join("")}</div>`,
    },
  ];
};

/** A score with its counts, linked to the findings at `#anchor`, or on its own with no anchor. */
export const scoreCard = (
  anchor: string | null,
  name: string,
  score: number,
  counts: SeverityCounts
): string => {
  const grade = band(score);
  const inner = `${scoreRing(score)}<span class="score-text"><span class="score-head"><span class="score-name">${name}</span><span class="verdict">${BAND_LABEL[grade]}</span></span><span class="sr-only">Score ${score} of 100.</span>${countsHtml(counts)}${anchor ? `<span class="score-more">See the findings${icon("arrow", "arrow")}</span>` : ""}</span>`;

  return anchor
    ? `<a class="score-card band-${grade}" href="#${anchor}">${inner}</a>`
    : `<div class="score-card band-${grade}">${inner}</div>`;
};

/**
 * The report's data for its buttons: the two audits as the MCP tools return them, and the same as
 * Markdown. The page's script reads it; nothing is stored on the server. `summary` is what the
 * page's `audit_shown` event says (issue #57): the kind of audit, the scores and the page count.
 */
export const reportData = (
  seo: PageAudit | SiteAudit,
  aeo: AeoAudit,
  host: string
): string =>
  scriptSafe(
    JSON.stringify({
      json: { seo: compactAudit(seo), aeo: compactAeoAudit(aeo) },
      markdown: `${renderMarkdown(seo)}\n\n${renderAeoMarkdown(aeo)}`,
      name: host,
      summary: {
        mode: seo.kind,
        seo_score: seo.score,
        aeo_score: aeo.score,
        pages: seo.kind === "site" ? seo.pages.length : 1,
      },
    })
  );

/** When an audit ran, as the printed report says it: "11 November 2026 at 14:05 UTC". */
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

/**
 * A report under the audit form: a card with the address and the buttons, then `body`, a stack of
 * cards, and `data`. `share` is the Share menu (share-page.ts), when the site can sign a share
 * link. Under the address, a line that only paper and a PDF show says when the audit ran and what
 * made it, as a document handed on needs to.
 */
export const reportFrame = (report: {
  title: string;
  url: string;
  auditedAt: string;
  body: string;
  data: string;
  share?: string;
}): string => `<section class="report" id="report" aria-labelledby="report-title">
<div class="wrap report-stack">
<div class="window report-head">
<div class="report-bar">
<div class="report-title"><h2 id="report-title">${report.title}</h2><p class="report-url">${icon("globe")}<span>${esc(report.url)}</span></p><p class="report-print">Audited on ${auditedOn(report.auditedAt)} with ${PRODUCT_NAME} by ${MAKER}, <a href="${WEBSITE_URL}/">${new URL(WEBSITE_URL).host}</a></p></div>
<div class="report-actions"><button class="btn btn-secondary btn-sm" type="button" data-report="download">${icon("download")}<span class="btn-label">Download JSON</span></button><button class="btn btn-secondary btn-sm" type="button" data-report="copy">${icon("copy")}<span class="btn-label">Copy as Markdown</span></button><button class="btn btn-secondary btn-sm" type="button" data-report="pdf">${icon("file")}<span class="btn-label">Save as PDF</span></button>${report.share ?? ""}</div>
</div>
</div>
${report.body}
</div>
<script type="application/json" id="report-data">${report.data}</script>
</section>`;

/**
 * What follows a page's report: how to audit its whole site. The form crawls a site from its
 * homepage, so a homepage audited alone is one the form did not crawl, because crawls are off.
 */
const pageNote = (seo: PageAudit, homepage: boolean): string => {
  const { origin } = new URL(seo.url);

  return homepage
    ? `This is the audit of the homepage alone: crawls of a whole site are switched off at the moment. A crawl adds site-wide checks, such as broken links, sitemap coverage and duplicate titles: run <code>npx @rivi-software/agentic-seo-check crawl ${esc(origin)}</code>, or give your assistant <a href="${MCP_ORIGIN}/">the hosted server</a>.`
    : `To audit the whole site, up to ${HOSTED_LIMITS.maxPages} pages with checks such as broken links and duplicate titles, enter its homepage: <code>${esc(origin)}/</code>.`;
};

/**
 * The report of one page's SEO and AEO audits, to put under the audit form. `homepage`: the page
 * is a site's homepage, which the form audited alone. `share`: the Share menu, if any.
 */
export const renderReport = (
  seo: PageAudit,
  aeo: AeoAudit,
  homepage = false,
  share = ""
): string => {
  const seoParts = [{ groups: categoryGroups("seo", seo.findings) }];
  const aeoParts = aeoPageParts(aeo.findings);

  const sections: ReportSection[] = [
    {
      id: "overview",
      tab: "Overview",
      title: "Overview",
      body: [
        fixFirst(seoParts, aeoParts),
        findingsIndex(seoParts, aeoParts),
        cardRow([
          overviewPart("The page", seoFacts(seo)),
          overviewPart("For AI answer engines", aeoFacts(aeo, "page")),
        ]),
        fieldCard(seo.fieldData),
      ].join("\n"),
    },
    {
      id: "seo",
      tab: "SEO",
      count: seo.findings.length,
      errors: seo.counts.error > 0,
      title: "SEO findings",
      chips: chip(plural(seo.findings.length, "finding")),
      body: partsHtml(
        seoParts,
        "No SEO findings: nothing to fix on this page."
      ),
    },
    {
      id: "aeo",
      tab: "AEO",
      count: aeo.findings.length,
      errors: aeo.counts.error > 0,
      title: "AEO findings",
      chips: chip(plural(aeo.findings.length, "finding")),
      body: partsHtml(
        aeoParts,
        "No AEO findings: nothing to fix on this page."
      ),
    },
    ...crawlersSection(aeo),
  ];

  return reportFrame({
    title: "Audit report",
    url: seo.url,
    auditedAt: seo.auditedAt,
    share,
    data: reportData(seo, aeo, new URL(seo.url).hostname),
    body: `<div class="scores">${scoreCard("seo", "SEO: search engines", seo.score, seo.counts)}${scoreCard("aeo", "AEO: AI answer engines", aeo.score, aeo.counts)}</div>
${sectionsHtml(sections)}
<div class="report-note">${icon("info")}<p>${pageNote(seo, homepage)}</p></div>`,
  });
};
