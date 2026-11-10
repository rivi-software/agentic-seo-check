/**
 * The report of a page audit as HTML: the SEO audit and the AEO audit of one page, each with its
 * score and its findings, and every finding with the edits that fix it. What it shows is the
 * audit as the tools return it; no model reads or rewrites it. Everything quoted from the audited
 * page is escaped.
 */
import { compactAeoAudit } from "../../../src/core/aeo/audit.js";
import { compactAudit } from "../../../src/core/audit.js";
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
} from "../../../src/core/types.js";
import { esc, safeHref, scriptSafe } from "./html.js";

const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

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

/** The most characters of a finding's evidence the report prints. */
const MAX_EVIDENCE_CHARS = 4000;

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const countsText = (counts: SeverityCounts): string =>
  `${plural(counts.error, "error")}, ${plural(counts.warning, "warning")}, ${counts.info} info`;

const code = (text: string): string => `<code>${esc(text)}</code>`;

const editHtml = (edit: FixEdit): string => {
  const where = [
    `${ACTION_LABEL[edit.action]} in ${TARGET_LABEL[edit.in]}`,
    edit.at ? ` at ${code(edit.at)}` : "",
    edit.url ? ` of ${code(edit.url)}` : "",
  ].join("");

  const current = edit.current
    ? `<span class="edit-label">Now</span><pre class="current"><code>${esc(edit.current)}</code></pre>`
    : "";

  const next = edit.code
    ? `<span class="edit-label">${edit.action === "add" ? "Add" : "Write"}</span><pre class="code"><code>${esc(edit.code)}</code></pre>`
    : "";

  const write = edit.write ? `<p>${esc(edit.write)}</p>` : "";

  return `<li><p class="edit-head">${where}</p>${current}${next}${write}</li>`;
};

const evidenceHtml = (evidence: NonNullable<Finding["evidence"]>): string => {
  const json = JSON.stringify(evidence, null, 2);

  const shown =
    json.length > MAX_EVIDENCE_CHARS
      ? `${json.slice(0, MAX_EVIDENCE_CHARS)}\n… (the JSON download has all of it)`
      : json;

  return `<details class="evidence"><summary>Evidence</summary><pre><code>${esc(shown)}</code></pre></details>`;
};

const findingHtml = (finding: Finding): string => {
  const docs = finding.docs ? safeHref(finding.docs) : null;

  const body = [
    `<p><strong>What to change:</strong> ${esc(finding.recommendation)}</p>`,
    finding.selector ? `<p>Where: ${code(finding.selector)}</p>` : "",
    finding.fix && finding.fix.length > 0
      ? `<ol class="edits">${finding.fix.map(editHtml).join("")}</ol>`
      : "",
    finding.evidence && Object.keys(finding.evidence).length > 0
      ? evidenceHtml(finding.evidence)
      : "",
    docs ? `<p><a href="${docs}" rel="noopener">Documentation</a></p>` : "",
  ].join("");

  // Errors start open: they are what to fix first.
  return `<details class="finding sev-${finding.severity}"${finding.severity === "error" ? " open" : ""}>
<summary><span class="sev">${SEVERITY_LABEL[finding.severity]}</span>${code(finding.rule)}<span class="msg">${esc(finding.message)}</span></summary>
<div class="finding-body">${body}</div>
</details>`;
};

const findingsHtml = (findings: Finding[]): string =>
  findings.length === 0
    ? "<p>No findings: nothing to fix on this page.</p>"
    : `<div class="findings">${findings.map(findingHtml).join("\n")}</div>`;

/** A list of facts; a fact without a value is left out. */
const facts = (rows: [label: string, value: string | null][]): string =>
  `<dl class="facts">${rows
    .flatMap(([label, value]) =>
      value === null || value === ""
        ? []
        : [`<dt>${label}</dt><dd>${esc(value)}</dd>`]
    )
    .join("")}</dl>`;

const seoFacts = (audit: PageAudit): string => {
  const { summary, response } = audit;

  return facts([
    ["Title", summary.title],
    ["Description", summary.metaDescription],
    ["Canonical", summary.canonical],
    ["HTTP status", response?.status ? String(response.status) : null],
    [
      "Redirects",
      response && response.redirectChain.length > 0
        ? String(response.redirectChain.length)
        : null,
    ],
    ["Indexable", summary.indexable ? "Yes" : "No"],
    ["Language", summary.lang],
    ["H1", summary.h1.join(" · ")],
    ["Words", summary.wordCount.toLocaleString("en")],
    [
      "Links",
      `${summary.links.internal} internal, ${summary.links.external} external`,
    ],
    [
      "Images",
      `${summary.images.total}, ${summary.images.missingAlt} without alt text`,
    ],
    ["Structured data", summary.structuredDataTypes.join(", ")],
  ]);
};

const aeoFacts = (audit: AeoAudit): string => {
  const { summary } = audit;
  const { page } = summary;

  return facts([
    ["robots.txt", summary.robotsTxt],
    ["llms.txt", summary.llmsTxt],
    [
      "AI training preference",
      summary.trainingPreference === "none" ? null : summary.trainingPreference,
    ],
    ["Google snippets", page?.googleSnippets ?? null],
    ["Copilot answers", page?.copilotAnswers ?? null],
    ["Question headings", page ? String(page.questions) : null],
    ["Author", page?.author ?? null],
    ["Published", page?.datePublished ?? null],
    ["Modified", page?.dateModified ?? null],
  ]);
};

const PURPOSE_LABEL: Record<AiBotAccess["purpose"], string> = {
  search: "Search index",
  answer: "AI answers",
  training: "Model training",
};

const botRow = (bot: AiBotAccess): string =>
  `<tr><td>${code(bot.name)}</td><td>${esc(bot.operator)}</td><td>${PURPOSE_LABEL[bot.purpose]}</td><td>${bot.allowed ? "Allowed" : "Blocked"}</td></tr>`;

const crawlersHtml = (audit: AeoAudit): string => {
  const bots = audit.crawlers?.bots ?? [];

  if (bots.length === 0) {
    return "";
  }

  return `<h3>AI crawlers in robots.txt</h3>
<div class="table-scroll"><table>
<thead><tr><th>Crawler</th><th>Operator</th><th>Fetches pages for</th><th>This page</th></tr></thead>
<tbody>${bots.map(botRow).join("")}</tbody>
</table></div>`;
};

const scoreCard = (
  anchor: string,
  name: string,
  score: number,
  counts: SeverityCounts
): string =>
  `<a class="card score" href="#${anchor}"><span class="score-number">${score}<small>/100</small></span><span><span class="score-name">${name}</span><br><span class="score-counts">${countsText(counts)}</span></span></a>`;

/**
 * The report's data for its buttons: the two audits as the MCP tools return them, and the same as
 * Markdown. The page's script reads it; nothing is stored on the server.
 */
const reportData = (seo: PageAudit, aeo: AeoAudit): string =>
  scriptSafe(
    JSON.stringify({
      json: { seo: compactAudit(seo), aeo: compactAeoAudit(aeo) },
      markdown: `${renderMarkdown(seo)}\n\n${renderAeoMarkdown(aeo)}`,
      name: new URL(seo.url).hostname,
    })
  );

/** The report of one page's SEO and AEO audits, to put under the audit form. */
export const renderReport = (seo: PageAudit, aeo: AeoAudit): string =>
  `<section class="wrap report" id="report" aria-labelledby="report-title">
<div class="report-head">
<div><h2 id="report-title">Audit report</h2><p>${esc(seo.url)}</p></div>
<div class="report-actions"><button class="button quiet" type="button" data-report="download">Download JSON</button><button class="button quiet" type="button" data-report="copy">Copy as Markdown</button></div>
</div>
<div class="scores">${scoreCard("seo", "SEO: search engines", seo.score, seo.counts)}${scoreCard("aeo", "AEO: AI answer engines", aeo.score, aeo.counts)}</div>
<h3 id="seo">SEO findings</h3>
${seoFacts(seo)}
${findingsHtml(seo.findings)}
<h3 id="aeo">AEO findings</h3>
${aeoFacts(aeo)}
${findingsHtml(aeo.findings)}
${crawlersHtml(aeo)}
<p class="hint">This is the audit of one page. A crawl adds site-wide checks, such as broken links, sitemap coverage and duplicate titles: run <code>npx @rivi-software/agentic-seo-check crawl ${esc(new URL(seo.url).origin)}</code>, or give your assistant the hosted server.</p>
<script type="application/json" id="report-data">${reportData(seo, aeo)}</script>
</section>`;
