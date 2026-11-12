/**
 * The report of a site audit as HTML (issue #45): the SEO and AEO audits of a crawl from a site's
 * homepage, in sections of cards as a page's report is. The overview has what to fix first, an
 * index of the findings, the crawl and the site's AEO facts; each audit's section has its findings across the site and its
 * findings on the pages by rule, grouped by category; then the homepage's own findings with their
 * edits, every page with its scores, and the AI crawlers. Also the lines the form's answer shows
 * while the crawl runs. Everything quoted from the site is escaped.
 */
import type { SiteAudits } from "../../../src/core/aeo/audit.js";
import type { ProgressEvent } from "../../../src/core/audit.js";
import { HOSTED_LIMITS } from "../../../src/core/hosted.js";
import {
  band,
  CATEGORY_LABEL,
  plural,
} from "../../../src/core/report/labels.js";
import { sortFindings } from "../../../src/core/rules/index.js";
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
  AEO_PAGE_RULE_IDS,
  aeoFacts,
  byCategory,
  cardRow,
  categoryGroups,
  chip,
  code,
  crawlersSection,
  facts,
  fieldCard,
  findingGroup,
  findingsIndex,
  findingSummary,
  fixFirst,
  itemId,
  overviewPart,
  partsHtml,
  reportData,
  reportFrame,
  scoreCard,
  sectionsHtml,
  seoFacts,
  statusTone,
} from "./report.js";
import type { FindingGroup, FindingPart, ReportSection } from "./report.js";

/**
 * A crawled page as a link to the form with its address in the field: one more run gives that
 * page's report, with the edits a roll-up leaves out. The address is the site's text, so it only
 * ever becomes a query value.
 */
const pageLink = (url: string): string =>
  `<a class="page-link" href="${esc(`/?url=${encodeURIComponent(url)}#audit`)}">${esc(url)}</a>`;

/** The findings of one rule on the pages, as a finding is shown, with the pages it is on. */
const issueHtml = (issue: IssueRollup, id: string): string => {
  const shown =
    issue.pages > issue.examples.length
      ? `, the first ${issue.examples.length}`
      : "";

  return `<details class="finding sev-${issue.severity}" id="${id}">
${findingSummary(issue, chip(plural(issue.pages, "page")))}
<div class="finding-body"><div class="todo"><p class="label">What to change</p><p>${esc(issue.recommendation)}</p></div><div class="examples"><p class="label">Pages${shown}</p><ul>${issue.examples.map((url) => `<li>${pageLink(url)}</li>`).join("")}</ul></div></div>
</details>`;
};

/** Findings on the pages by rule as one group, or no group when there are none. */
const issueGroup = (
  id: string,
  label: string,
  issues: IssueRollup[]
): FindingGroup[] =>
  issues.length === 0
    ? []
    : [
        {
          id,
          label,
          items: issues.map(({ severity, rule, message, pages }, index) => ({
            id: itemId(id, index),
            severity,
            rule,
            message,
            pages,
          })),
          html: `<div class="findings">${issues.map((issue, index) => issueHtml(issue, itemId(id, index))).join("\n")}</div>`,
        },
      ];

/** Findings on the pages by rule, grouped by category at the anchors `<prefix>-<category>`. */
const issueGroups = (prefix: string, issues: IssueRollup[]): FindingGroup[] =>
  byCategory(issues).flatMap(([category, group]) =>
    issueGroup(`${prefix}-${category}`, CATEGORY_LABEL[category], group)
  );

/**
 * One audit's findings across the site, with their fixes, then its findings on the pages: by
 * category, or with `categories` false in one group, as the AEO rules all share one category.
 */
const siteParts = (
  prefix: string,
  siteFindings: Finding[],
  issues: IssueRollup[],
  categories = true
): FindingPart[] => {
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

const crawlFacts = (seo: SiteAudit): string => {
  const { crawl, robotsTxt, sitemaps } = seo;

  return facts("tiles", [
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
  ]);
};

/** What one audit's section lists: its findings across the site and its rules on the pages. */
const listed = (
  siteFindings: Finding[],
  issues: IssueRollup[]
): Pick<ReportSection, "count" | "errors" | "chips"> => ({
  count: siteFindings.length + issues.length,
  errors: [...siteFindings, ...issues].some(
    (item) => item.severity === "error"
  ),
  chips: `${chip(plural(siteFindings.length, "site finding"))}${chip(`${plural(issues.length, "rule")} on the pages`)}`,
});

/**
 * The homepage's own findings with their edits, as its page report has them, by category. Its AEO
 * findings about robots.txt and llms.txt are the site's, which the AEO section shows already.
 */
const homeSection = (start: SiteAudits["start"]): ReportSection[] => {
  if (!start) {
    return [];
  }

  // Each audit's findings come sorted, the two together do not: sorted again, the group with the
  // worst finding comes first whichever audit it is from.
  const findings = sortFindings([
    ...start.seo.findings,
    ...start.aeo.findings.filter((f) => AEO_PAGE_RULE_IDS.has(f.rule)),
  ]);

  return [
    {
      id: "home",
      tab: "The homepage",
      count: findings.length,
      errors: findings.some((finding) => finding.severity === "error"),
      title: "The homepage",
      chips: chip(plural(findings.length, "finding")),
      body: `<p class="report-lede">Every finding on ${code(start.seo.url)}, with its fix. Open a page in the list of pages to audit it.</p>
${overviewPart("The page", seoFacts(start.seo))}
${partsHtml([{ groups: categoryGroups("home", findings) }], "No findings on the homepage.")}`,
    },
  ];
};

const scoreNumber = (score: number | undefined): string =>
  score === undefined
    ? ""
    : `<span class="score-num band-${band(score)}">${score}</span>`;

const pagesSection = (seo: SiteAudit, aeo: AeoAudit): ReportSection => {
  const aeoScores = new Map((aeo.pages ?? []).map((p) => [p.url, p.score]));

  const rows = seo.pages.map((page) => {
    const status = page.response?.status;

    const answer = status
      ? `<span class="tone tone-${statusTone(status)}" aria-hidden="true"></span>${status}`
      : "No answer";

    return `<tr><th scope="row">${pageLink(page.url)}</th><td>${answer}</td><td>${page.depth ?? ""}</td><td>${scoreNumber(page.score)}</td><td>${scoreNumber(aeoScores.get(page.url))}</td></tr>`;
  });

  return {
    id: "pages",
    tab: "Pages",
    count: seo.pages.length,
    title: "The pages",
    chips: chip(plural(seo.pages.length, "page")),
    body: `<div class="table-wrap"><table class="pages-table"><thead><tr><th scope="col">Page</th><th scope="col">HTTP</th><th scope="col">Depth</th><th scope="col">SEO</th><th scope="col">AEO</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table></div>`,
  };
};

/**
 * The report of a site's SEO and AEO audits from one crawl, to put under the audit form. `share`:
 * the Share menu, if any.
 */
export const renderSiteReport = (audits: SiteAudits, share = ""): string => {
  const { seo, aeo, start } = audits;
  const { origin, hostname } = new URL(aeo.url);
  const aeoIssues = aeo.issues ?? [];
  const seoParts = siteParts("seo", seo.siteFindings, seo.issues);
  const aeoParts = siteParts("aeo", aeo.findings, aeoIssues, false);

  const sections: ReportSection[] = [
    {
      id: "overview",
      tab: "Overview",
      title: "Overview",
      body: [
        fixFirst(seoParts, aeoParts),
        findingsIndex(seoParts, aeoParts),
        cardRow([
          overviewPart("The crawl", crawlFacts(seo), "crawl"),
          overviewPart("For AI answer engines", aeoFacts(aeo, "site")),
        ]),
        // The homepage's, or its origin's: the crawl asks the origin for the start page alone.
        fieldCard(start?.seo.fieldData),
      ].join("\n"),
    },
    {
      id: "seo",
      tab: "SEO",
      ...listed(seo.siteFindings, seo.issues),
      title: "SEO findings",
      body: partsHtml(
        seoParts,
        "No SEO findings across the site or on its pages."
      ),
    },
    {
      id: "aeo",
      tab: "AEO",
      ...listed(aeo.findings, aeoIssues),
      title: "AEO findings",
      body: partsHtml(
        aeoParts,
        "No AEO findings across the site or on its pages."
      ),
    },
    ...homeSection(start),
    pagesSection(seo, aeo),
    ...crawlersSection(aeo, "the homepage"),
  ];

  return reportFrame({
    title: "Site audit report",
    url: aeo.url,
    auditedAt: seo.auditedAt,
    share,
    data: reportData(seo, aeo, hostname),
    body: `<div class="scores">${scoreCard("seo", "SEO: search engines", seo.score, seo.counts)}${scoreCard("aeo", "AEO: AI answer engines", aeo.score, aeo.counts)}</div>
${sectionsHtml(sections)}
<div class="report-note">${icon("info")}<p>Findings on the pages are grouped by rule, with up to 10 pages each; open a page for its own fixes. The crawl stops at ${HOSTED_LIMITS.maxPages} pages, ${HOSTED_LIMITS.maxDepth} links deep. For a larger site, run <code>npx @rivi-software/agentic-seo-check crawl ${esc(origin)}</code>.</p></div>`,
  });
};

/** The top of the answer while a crawl runs, with its list of progress lines open. */
export const progressOpen = (url: string): string =>
  `<section class="crawl-progress" id="progress" aria-labelledby="progress-title">
<div class="wrap">
<div class="window report-window">
<div class="report-bar"><div class="report-title"><h2 class="progress-title" id="progress-title">Crawling the site</h2><p class="report-url">${icon("globe")}<span>${esc(url)}</span></p></div></div>
<div class="report-body progress-body">
<p class="report-lede">Up to ${HOSTED_LIMITS.maxPages} pages, ${HOSTED_LIMITS.maxDepth} links deep. The report follows here, usually within a minute.</p>
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
