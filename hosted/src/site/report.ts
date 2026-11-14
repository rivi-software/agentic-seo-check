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
 * time; without it they follow one another. Its "Download PDF" button draws the same data as a
 * document of its own (pdf.ts), and printed the report is every section in turn, on white, with
 * every finding open (ui/style.ts and files.ts). What both show is in report-data.ts.
 */
import { MAKER, PRODUCT_NAME, WEBSITE_URL } from "../../../src/brand.js";
import { compactAeoAudit } from "../../../src/core/aeo/audit.js";
import { compactAudit } from "../../../src/core/audit.js";
import { HOSTED_LIMITS } from "../../../src/core/hosted.js";
import {
  ACTION_LABEL,
  band,
  countLabel,
  plural,
  PURPOSE_LABEL,
  SEVERITIES,
  TARGET_LABEL,
} from "../../../src/core/report/labels.js";
import {
  renderAeoMarkdown,
  renderMarkdown,
} from "../../../src/core/report/markdown.js";
import type {
  AeoAudit,
  AiBotAccess,
  Finding,
  FixEdit,
  IssueRollup,
  PageAudit,
  SeverityCounts,
  Severity,
  SiteAudit,
} from "../../../src/core/types.js";
import { MCP_URL } from "../limits.js";
import { icon } from "../ui/icons.js";
import { esc, safeHref, scriptSafe } from "./html.js";
import { pagePdf } from "./pdf.js";
import type { PdfReport } from "./pdf.js";
import {
  aeoFactRows,
  auditedOn,
  BAND_LABEL,
  fieldFactRows,
  headOf,
  pageParts,
  seoFactRows,
  severitiesOf,
  urgentEntries,
} from "./report-data.js";
import type {
  Entry,
  Fact,
  Group,
  Part,
  ReportParts,
  Tone,
} from "./report-data.js";
import { rulePathOf } from "./rule-info.js";

const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
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

/**
 * The links under a finding: the rule's own page on this site (issue #171), when the rule has one,
 * and the search engine's documentation.
 */
const findingLinks = (rule: string, docs: string | null): string => {
  const page = rulePathOf(rule);

  const links = [
    page
      ? `<a class="link-arrow" href="${page}">About the rule${icon("arrow", "arrow")}</a>`
      : "",
    docs
      ? `<a class="link-arrow" href="${docs}" rel="noopener">Documentation${icon("arrow", "arrow")}</a>`
      : "",
  ].join("");

  return links ? `<p class="finding-links">${links}</p>` : "";
};

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
    findingLinks(finding.rule, docs),
  ].join("");

  // Errors start open: they are what to fix first.
  return `<details class="finding sev-${finding.severity}" id="${id}"${finding.severity === "error" ? " open" : ""}>
${findingSummary(finding)}
<div class="finding-body">${body}</div>
</details>`;
};

/**
 * A crawled page as a link to the form with its address in the field: one more run gives that
 * page's report, with the edits a roll-up leaves out. The address is the site's text, so it only
 * ever becomes a query value.
 */
export const pageLink = (url: string): string =>
  `<a class="page-link" href="${esc(`/?url=${encodeURIComponent(url)}#audit`)}">${esc(url)}</a>`;

/** The findings of one rule on the pages, as a finding is shown, with the pages it is on. */
const issueHtml = (issue: IssueRollup, id: string): string => {
  const shown =
    issue.pages > issue.examples.length
      ? `, the first ${issue.examples.length}`
      : "";

  return `<details class="finding sev-${issue.severity}" id="${id}">
${findingSummary(issue, chip(plural(issue.pages, "page")))}
<div class="finding-body"><div class="todo"><p class="label">What to change</p><p>${esc(issue.recommendation)}</p></div><div class="examples"><p class="label">Pages${shown}</p><ul>${issue.examples.map((url) => `<li>${pageLink(url)}</li>`).join("")}</ul></div>${findingLinks(issue.rule, null)}</div>
</details>`;
};

const entryHtml = (entry: Entry): string =>
  entry.kind === "finding"
    ? findingHtml(entry.finding, entry.id)
    : issueHtml(entry.issue, entry.id);

/** The counts of the severities that occur in `severities`: "2 errors", "1 warning", "3 info". */
export const tally = (severities: Severity[]): string =>
  `<span class="counts">${SEVERITIES.flatMap((severity) => {
    const count = severities.filter((s) => s === severity).length;

    return count > 0
      ? [`<span class="is-${severity}">${countLabel(severity, count)}</span>`]
      : [];
  }).join("")}</span>`;

const groupHtml = (group: Group, level: 4 | 5): string =>
  `<div class="finding-group" id="${group.id}"><div class="finding-group-head"><h${level}>${group.label}</h${level}>${tally(severitiesOf([group]))}</div><div class="findings">${group.entries.map(entryHtml).join("\n")}</div></div>`;

/** Parts of findings with their headings, or `empty` when none of them has a finding. */
export const partsHtml = (parts: Part[], empty: string): string => {
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
const indexCard = (name: string, parts: Part[]): string => {
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
export const findingsIndex = ({ seo, aeo }: ReportParts): string =>
  `<div class="report-row index-row">${indexCard("SEO: search engines", seo)}${indexCard("AEO: AI answer engines", aeo)}</div>`;

/**
 * The overview's first card: the errors and warnings of both audits, the worst first, each a link
 * to the finding with its fix.
 */
export const fixFirst = (parts: ReportParts): string => {
  const urgent = urgentEntries(parts);

  if (urgent.length === 0) {
    return overviewPart(
      "Fix first",
      `<p class="empty">${icon("check")}No errors and no warnings: nothing that has to be fixed.</p>`
    );
  }

  const rows = urgent.slice(0, MAX_FIX_FIRST).map(({ audit, entry }) => {
    const item = headOf(entry);

    return `<li><a class="fix-row sev-${item.severity}" href="#${entry.id}">${severityChip(item.severity)}<span class="finding-text"><span class="msg">${esc(item.message)}</span><span class="finding-meta">${code(item.rule)}${chip(audit)}${item.pages === undefined ? "" : chip(plural(item.pages, "page"))}</span></span>${icon("arrow", "arrow")}</a></li>`;
  });

  const more = urgent.length - rows.length;

  return overviewPart(
    "Fix first",
    `<ol class="fix-list">${rows.join("")}</ol>${more > 0 ? `<p class="card-foot">And ${more} more in the SEO and AEO findings.</p>` : ""}`,
    "fix-first",
    tally(urgent.map(({ entry }) => headOf(entry).severity))
  );
};

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

/** A dot in a tone, as the pages table marks a page's HTTP status. */
export const toneDot = (tone: Tone): string =>
  tone ? `<span class="tone tone-${tone}" aria-hidden="true"></span>` : "";

export const seoFacts = (audit: PageAudit): string => {
  const rows = seoFactRows(audit);

  return `${facts("text", rows.text)}${facts("tiles", rows.tiles)}`;
};

/**
 * Real-user Core Web Vitals of a page (issue #130): each 75th percentile as a tile in its rating's
 * tone, and whose visits they are; or why there are none. Nothing when the audit did not ask.
 */
const fieldFacts = (field: PageAudit["fieldData"]): string => {
  const rows = fieldFactRows(field);

  return rows ? `${facts("tiles", rows.tiles)}<p>${esc(rows.note)}</p>` : "";
};

/** The card of a page's field data, which the overview shows when the audit has some. */
export const fieldCard = (field: PageAudit["fieldData"]): string =>
  cardRow([
    overviewPart("Real visits on phones", fieldFacts(field), "field-data"),
  ]);

/** The AEO audit's facts: the site's, and with `page` those of the page it audited. */
export const aeoFacts = (audit: AeoAudit, scope: "page" | "site"): string =>
  facts("tiles", aeoFactRows(audit, scope));

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
 * The report's data for its buttons: the two audits as the MCP tools return them, the same as
 * Markdown, and the document its PDF is drawn from (pdf.ts). The page's script reads it; nothing
 * is stored on the server. `summary` is what the
 * page's `audit_shown` event says (issue #57): the kind of audit, the scores and the page count.
 */
export const reportData = (
  seo: PageAudit | SiteAudit,
  aeo: AeoAudit,
  host: string,
  pdf: PdfReport
): string =>
  scriptSafe(
    JSON.stringify({
      json: { seo: compactAudit(seo), aeo: compactAeoAudit(aeo) },
      markdown: `${renderMarkdown(seo)}\n\n${renderAeoMarkdown(aeo)}`,
      pdf,
      name: host,
      summary: {
        mode: seo.kind,
        seo_score: seo.score,
        aeo_score: aeo.score,
        pages: seo.kind === "site" ? seo.pages.length : 1,
      },
    })
  );

/**
 * A report under the audit form: a card with the address and the buttons, then `body`, a stack of
 * cards, and `data`. `share` is the Share menu (share-page.ts), when the site can sign a share
 * link. Under the address, a line that only paper shows says when the audit ran and what made it,
 * as a document handed on needs to.
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
<div class="report-actions"><button class="btn btn-secondary btn-sm" type="button" data-report="download">${icon("download")}<span class="btn-label">Download JSON</span></button><button class="btn btn-secondary btn-sm" type="button" data-report="copy">${icon("copy")}<span class="btn-label">Copy as Markdown</span></button><button class="btn btn-secondary btn-sm" type="button" data-report="pdf">${icon("file")}<span class="btn-label">Download PDF</span></button>${report.share ?? ""}</div>
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
    ? `This is the audit of the homepage alone: crawls of a whole site are switched off at the moment. A crawl adds site-wide checks, such as broken links, sitemap coverage and duplicate titles: run <code>npx @rivi-software/agentic-seo-check crawl ${esc(origin)}</code>, or give your assistant <a href="${MCP_URL}">the hosted server</a>.`
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
  const parts = pageParts(seo, aeo);

  const sections: ReportSection[] = [
    {
      id: "overview",
      tab: "Overview",
      title: "Overview",
      body: [
        fixFirst(parts),
        findingsIndex(parts),
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
        parts.seo,
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
        parts.aeo,
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
    data: reportData(
      seo,
      aeo,
      new URL(seo.url).hostname,
      pagePdf(seo, aeo, parts)
    ),
    body: `<div class="scores">${scoreCard("seo", "SEO: search engines", seo.score, seo.counts)}${scoreCard("aeo", "AEO: AI answer engines", aeo.score, aeo.counts)}</div>
${sectionsHtml(sections)}
<div class="report-note">${icon("info")}<p>${pageNote(seo, homepage)}</p></div>`,
  });
};
