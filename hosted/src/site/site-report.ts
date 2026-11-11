/**
 * The report of a site audit as HTML (issue #45): the SEO and AEO audits of a crawl from a site's
 * homepage, each with its score, its findings across the site and its findings on the pages
 * grouped by rule, then the homepage's own findings with their edits, and every page with its
 * scores. Also the lines the form's answer shows while the crawl runs. Everything quoted from the
 * site is escaped.
 */
import type { SiteAudits } from "../../../src/core/aeo/audit.js";
import type { ProgressEvent } from "../../../src/core/audit.js";
import { HOSTED_LIMITS } from "../../../src/core/hosted.js";
import { AEO_PAGE_RULES } from "../../../src/core/rules/index.js";
import type {
  AeoAudit,
  Finding,
  IssueRollup,
  SiteAudit,
} from "../../../src/core/types.js";
import { icon } from "../ui/icons.js";
import type { FailureKind } from "./home.js";
import { esc } from "./html.js";
import {
  aeoFacts,
  band,
  code,
  crawlersHtml,
  facts,
  findingsHtml,
  plural,
  reportData,
  reportFrame,
  scoreCard,
  seoFacts,
  severityChip,
  statusTone,
} from "./report.js";

/** The AEO rules that look at one page, as against those that look at the site's files. */
const AEO_PAGE_RULE_IDS = new Set(AEO_PAGE_RULES.map((rule) => rule.meta.id));

/**
 * A crawled page as a link to the form with its address in the field: one more run gives that
 * page's report, with the edits a roll-up leaves out. The address is the site's text, so it only
 * ever becomes a query value.
 */
const pageLink = (url: string): string =>
  `<a class="page-link" href="${esc(`/?url=${encodeURIComponent(url)}#audit`)}">${esc(url)}</a>`;

/** The findings of one rule on the pages, as a finding is shown, with the pages it is on. */
const issueHtml = (issue: IssueRollup): string => {
  const shown =
    issue.pages > issue.examples.length
      ? `, the first ${issue.examples.length}`
      : "";

  return `<details class="finding sev-${issue.severity}">
<summary>${severityChip(issue.severity)}${code(issue.rule)}<span class="msg">${esc(issue.message)}</span><span class="chip">${plural(issue.pages, "page")}</span>${icon("chevron", "chev")}</summary>
<div class="finding-body"><div class="todo"><p class="label">What to change</p><p>${esc(issue.recommendation)}</p></div><div class="examples"><p class="label">Pages${shown}</p><ul>${issue.examples.map((url) => `<li>${pageLink(url)}</li>`).join("")}</ul></div></div>
</details>`;
};

const issuesHtml = (issues: IssueRollup[]): string =>
  issues.length === 0
    ? `<p class="empty">${icon("check")}No findings on the pages.</p>`
    : `<div class="findings">${issues.map(issueHtml).join("\n")}</div>`;

const crawlSection = (seo: SiteAudit): string => {
  const { crawl, robotsTxt, sitemaps } = seo;

  return `<div class="report-section" id="crawl">
<div class="report-section-head"><h3>The crawl</h3><span class="chip">${plural(crawl.pagesCrawled, "page")}</span></div>
${facts("tiles", [
  ["Pages audited", `${crawl.pagesCrawled} of ${crawl.pagesDiscovered} found`],
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
])}
</div>`;
};

/** One audit's findings across the site, with their fixes, and its findings on the pages by rule. */
const siteSection = (
  anchor: string,
  title: string,
  factsHtml: string,
  siteFindings: Finding[],
  issues: IssueRollup[]
): string => `<div class="report-section" id="${anchor}">
<div class="report-section-head"><h3>${title}</h3><span class="chip">${plural(siteFindings.length, "site finding")}</span><span class="chip">${plural(issues.length, "rule")} on the pages</span></div>
${factsHtml}
<h4 class="report-sub">Across the site</h4>
${findingsHtml(siteFindings, "No findings across the site.")}
<h4 class="report-sub">On the pages, by rule</h4>
${issuesHtml(issues)}
</div>`;

/**
 * The homepage's own findings with their edits, as its page report has them. Its AEO findings
 * about robots.txt and llms.txt are the site's, which the AEO section shows already.
 */
const homeSection = (start: SiteAudits["start"]): string => {
  if (!start) {
    return "";
  }

  const seo = start.seo.findings;
  const aeo = start.aeo.findings.filter((f) => AEO_PAGE_RULE_IDS.has(f.rule));

  return `<div class="report-section" id="home">
<div class="report-section-head"><h3>The homepage</h3><span class="chip">${plural(seo.length + aeo.length, "finding")}</span></div>
<p class="report-lede">Every finding on ${code(start.seo.url)}, with the edits that fix it. For the edits on another page, run the audit on it: each page in the list below opens the form with its address.</p>
${seoFacts(start.seo)}
<h4 class="report-sub">SEO</h4>
${findingsHtml(seo, "No SEO findings on the homepage.")}
<h4 class="report-sub">AEO</h4>
${findingsHtml(aeo, "No AEO findings on the homepage.")}
</div>`;
};

const scoreNumber = (score: number | undefined): string =>
  score === undefined
    ? ""
    : `<span class="score-num band-${band(score)}">${score}</span>`;

const pagesSection = (seo: SiteAudit, aeo: AeoAudit): string => {
  const aeoScores = new Map((aeo.pages ?? []).map((p) => [p.url, p.score]));

  const rows = seo.pages.map((page) => {
    const status = page.response?.status;

    const answer = status
      ? `<span class="tone tone-${statusTone(status)}" aria-hidden="true"></span>${status}`
      : "No answer";

    return `<tr><th scope="row">${pageLink(page.url)}</th><td>${answer}</td><td>${page.depth ?? ""}</td><td>${scoreNumber(page.score)}</td><td>${scoreNumber(aeoScores.get(page.url))}</td></tr>`;
  });

  return `<div class="report-section" id="pages">
<div class="report-section-head"><h3>The pages</h3><span class="chip">${plural(seo.pages.length, "page")}</span></div>
<div class="table-wrap"><table class="pages-table"><thead><tr><th scope="col">Page</th><th scope="col">HTTP</th><th scope="col">Depth</th><th scope="col">SEO</th><th scope="col">AEO</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table></div>
</div>`;
};

/**
 * The report of a site's SEO and AEO audits from one crawl, to put under the audit form. `share`:
 * the Share menu, if any.
 */
export const renderSiteReport = (audits: SiteAudits, share = ""): string => {
  const { seo, aeo, start } = audits;
  const { origin, hostname } = new URL(aeo.url);

  return reportFrame({
    title: "Site audit report",
    url: aeo.url,
    share,
    data: reportData(seo, aeo, hostname),
    body: `<div class="scores">${scoreCard("seo", "SEO: search engines", seo.score, seo.counts)}${scoreCard("aeo", "AEO: AI answer engines", aeo.score, aeo.counts)}</div>
${crawlSection(seo)}
${siteSection("seo", "SEO findings", "", seo.siteFindings, seo.issues)}
${siteSection("aeo", "AEO findings", aeoFacts(aeo, "site"), aeo.findings, aeo.issues ?? [])}
${homeSection(start)}
${pagesSection(seo, aeo)}
${crawlersHtml(aeo, "the homepage")}
<div class="report-note">${icon("info")}<p>The findings on the pages are grouped by rule, with up to 10 of the pages each. Each page opens the form with its address: run the audit on it for its own findings and the edits that fix them. The crawl stops at ${HOSTED_LIMITS.maxPages} pages, ${HOSTED_LIMITS.maxDepth} links deep. For a larger site, run <code>npx @rivi-software/agentic-seo-check crawl ${esc(origin)}</code> on your machine.</p></div>`,
  });
};

/** The top of the answer while a crawl runs, with its list of progress lines open. */
export const progressOpen = (url: string): string =>
  `<section class="crawl-progress" id="progress" aria-labelledby="progress-title">
<div class="wrap">
<div class="window report-window">
<div class="report-bar"><div class="report-title"><h2 class="progress-title" id="progress-title">Crawling the site</h2><p class="report-url">${icon("globe")}<span>${esc(url)}</span></p></div></div>
<div class="report-body progress-body">
<p class="report-lede">Up to ${HOSTED_LIMITS.maxPages} pages, ${HOSTED_LIMITS.maxDepth} links deep from the homepage, then the checks across the site. The report follows here when the crawl is done, usually within a minute.</p>
<ol class="progress-lines" role="log">
`;

/** One step of the crawl: a page it requested, with its HTTP status, or what it does next. */
export const progressLine = (event: ProgressEvent): string =>
  event.phase === "crawl"
    ? `<li class="is-page"><span class="progress-count">${event.crawled ?? ""}</span><code>${esc(event.message)}</code></li>\n`
    : `<li><span class="progress-count">${icon("chevron")}</span><span>${esc(event.message)}</span></li>\n`;

/** Closes the progress lines, with why the crawl gave no report when it failed, and its kind. */
export const progressClose = (error?: string, kind?: FailureKind): string =>
  `</ol>${error ? `\n<p class="notice" role="alert"${kind ? ` data-failure="${kind}"` : ""}>${icon("error")}<span>${esc(error)}</span></p>` : ""}
</div>
</div>
</div>
</section>
`;
