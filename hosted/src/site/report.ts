/**
 * The report of a page audit as HTML: the SEO audit and the AEO audit of one page, each with its
 * score and its findings, and every finding with the edits that fix it. What it shows is the
 * audit as the tools return it; no model reads or rewrites it. Everything quoted from the audited
 * page is escaped. A site's report (site-report.ts) is built from the same parts.
 */
import { compactAeoAudit } from "../../../src/core/aeo/audit.js";
import { compactAudit } from "../../../src/core/audit.js";
import { HOSTED_LIMITS } from "../../../src/core/hosted.js";
import {
  renderAeoMarkdown,
  renderMarkdown,
} from "../../../src/core/report/markdown.js";
import type {
  AeoAudit,
  AiBotAccess,
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

const SEVERITIES: Severity[] = ["error", "warning", "info"];

const ACTION_LABEL: Record<FixEdit["action"], string> = {
  add: "Add",
  replace: "Replace",
  remove: "Remove",
};

const TARGET_LABEL: Record<FixEdit["in"], string> = {
  html: "the page's HTML",
  http: "the HTTP response",
  "robots.txt": "robots.txt",
  sitemap: "the sitemap",
  "llms.txt": "llms.txt",
  asset: "a file the site serves",
};

/** What each kind of AI crawler fetches pages for, as the report groups them. */
export const PURPOSE_LABEL: Record<AiBotAccess["purpose"], string> = {
  search: "Search index",
  answer: "AI answers",
  training: "Model training",
};

/** The most characters of a finding's evidence the report prints. */
const MAX_EVIDENCE_CHARS = 4000;

export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const COUNT_NOUN: Record<Severity, (count: number) => string> = {
  error: (count) => plural(count, "error"),
  warning: (count) => plural(count, "warning"),
  info: (count) => `${count} info`,
};

export const code = (text: string): string => `<code>${esc(text)}</code>`;

/** The severity as a coloured label, as the report and the rules page show it. */
export const severityChip = (severity: Severity): string =>
  `<span class="sev">${icon(severity)}${SEVERITY_LABEL[severity]}</span>`;

/** Lighthouse's bands: 90 and up is good, under 50 is poor. */
export const band = (score: number): string => {
  if (score >= 90) {
    return "good";
  }

  return score >= 50 ? "fair" : "poor";
};

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
      `<span class="is-${severity}">${COUNT_NOUN[severity](counts[severity])}</span>`
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

const findingHtml = (finding: Finding): string => {
  const docs = finding.docs ? safeHref(finding.docs) : null;

  const body = [
    `<div class="todo"><p class="label">What to change</p><p>${esc(finding.recommendation)}</p></div>`,
    finding.selector
      ? `<p class="where"><span class="label">Where</span>${code(finding.selector)}</p>`
      : "",
    finding.fix && finding.fix.length > 0
      ? `<ol class="edits">${finding.fix.map(editHtml).join("")}</ol>`
      : "",
    finding.evidence && Object.keys(finding.evidence).length > 0
      ? evidenceHtml(finding.evidence)
      : "",
    docs
      ? `<p><a class="link-arrow" href="${docs}" rel="noopener">Documentation${icon("arrow", "arrow")}</a></p>`
      : "",
  ].join("");

  // Errors start open: they are what to fix first.
  return `<details class="finding sev-${finding.severity}"${finding.severity === "error" ? " open" : ""}>
<summary>${severityChip(finding.severity)}${code(finding.rule)}<span class="msg">${esc(finding.message)}</span>${icon("chevron", "chev")}</summary>
<div class="finding-body">${body}</div>
</details>`;
};

/** Findings with their fixes, or `empty` when there are none. */
export const findingsHtml = (
  findings: Finding[],
  empty = "No findings: nothing to fix on this page."
): string =>
  findings.length === 0
    ? `<p class="empty">${icon("check")}${empty}</p>`
    : `<div class="findings">${findings.map(findingHtml).join("\n")}</div>`;

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

/** robots.txt's answer for each AI crawler, for `page`: "this page", or a site's start page. */
export const crawlersHtml = (audit: AeoAudit, page = "this page"): string => {
  const bots = audit.crawlers?.bots ?? [];

  if (bots.length === 0) {
    return "";
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

  return `<div class="report-section" id="crawlers">
<div class="report-section-head"><h3>AI crawlers in robots.txt</h3><span class="chip">${allowed} of ${bots.length} may fetch ${page}</span></div>
<div class="crawler-groups">${groups.join("")}</div>
</div>`;
};

/** A score with its counts, linked to the findings at `#anchor`, or on its own with no anchor. */
export const scoreCard = (
  anchor: string | null,
  name: string,
  score: number,
  counts: SeverityCounts
): string => {
  const inner = `${scoreRing(score)}<span class="score-text"><span class="score-name">${name}</span><span class="sr-only">Score ${score} of 100.</span>${countsHtml(counts)}</span>`;

  return anchor
    ? `<a class="score-card" href="#${anchor}">${inner}</a>`
    : `<div class="score-card">${inner}</div>`;
};

const auditSection = (
  anchor: string,
  title: string,
  factsHtml: string,
  findings: Finding[]
): string => `<div class="report-section" id="${anchor}">
<div class="report-section-head"><h3>${title}</h3><span class="chip">${plural(findings.length, "finding")}</span></div>
${factsHtml}
${findingsHtml(findings)}
</div>`;

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

/**
 * A report under the audit form: its bar with the address and the buttons, `body`, and `data`.
 * `share` is the Share menu (share-page.ts), when the site can sign a share link.
 */
export const reportFrame = (report: {
  title: string;
  url: string;
  body: string;
  data: string;
  share?: string;
}): string => `<section class="report" id="report" aria-labelledby="report-title">
<div class="wrap">
<div class="window report-window">
<div class="report-bar">
<div class="report-title"><h2 id="report-title">${report.title}</h2><p class="report-url">${icon("globe")}<span>${esc(report.url)}</span></p></div>
<div class="report-actions"><button class="btn btn-secondary btn-sm" type="button" data-report="download">${icon("download")}<span class="btn-label">Download JSON</span></button><button class="btn btn-secondary btn-sm" type="button" data-report="copy">${icon("copy")}<span class="btn-label">Copy as Markdown</span></button>${report.share ?? ""}</div>
</div>
<div class="report-body">
${report.body}
</div>
</div>
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
    : `This is the audit of one page. To audit the whole site, up to ${HOSTED_LIMITS.maxPages} pages with site-wide checks such as broken links, sitemap coverage and duplicate titles, enter its homepage: <code>${esc(origin)}/</code>.`;
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
): string =>
  reportFrame({
    title: "Audit report",
    url: seo.url,
    share,
    data: reportData(seo, aeo, new URL(seo.url).hostname),
    body: `<div class="scores">${scoreCard("seo", "SEO: search engines", seo.score, seo.counts)}${scoreCard("aeo", "AEO: AI answer engines", aeo.score, aeo.counts)}</div>
${auditSection("seo", "SEO findings", seoFacts(seo), seo.findings)}
${auditSection("aeo", "AEO findings", aeoFacts(aeo, "page"), aeo.findings)}
${crawlersHtml(aeo)}
<div class="report-note">${icon("info")}<p>${pageNote(seo, homepage)}</p></div>`,
  });
