/**
 * The page of a shared report (shared-reports.ts): the website's own report of the two audits,
 * under a note that says who ran them, and how long the link lasts. It is kept out of search, and
 * its address is the secret: the routes send it with no referrer, so a link in the report does not
 * hand it to the audited site.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import type { StoredReport } from "../shared-reports.js";
import { reportPath } from "../shared-reports.js";
import type { CheckedReport } from "../shared-schema.js";
import { icon } from "../ui/icons.js";
import { layout, publisher } from "./layout.js";
import { renderReport } from "./report.js";
import { dayText } from "./share.js";
import { renderSiteReport } from "./site-report.js";

/** The report of a shared page or site, as the form would show it, with no Share menu. */
export const sharedReportHtml = (report: CheckedReport): string =>
  report.kind === "page"
    ? renderReport(report.seo, report.aeo)
    : renderSiteReport({
        seo: report.seo,
        aeo: report.aeo,
        start: report.start,
      });

/** Who ran the audits, and so how far the report can be taken as the site's own word. */
const SOURCE_TEXT: Record<StoredReport["source"], string> = {
  upload: `Someone ran ${PRODUCT_NAME} on their own machine and uploaded the result: this website did not request the pages itself.`,
  hosted: `${PRODUCT_NAME}'s hosted MCP server ran these audits for an AI assistant, from Cloudflare's network.`,
};

export const sharedReportPage = (stored: StoredReport): string => {
  const shared = dayText(stored.sharedAt.slice(0, 10));
  const expires = dayText(stored.expiresAt.slice(0, 10));
  const what = stored.report.kind;
  const title = `Shared ${what} report | ${PRODUCT_NAME}`;
  const description = `An SEO and AEO report shared with ${PRODUCT_NAME} on ${shared}.`;

  return layout({
    path: reportPath(stored.id),
    title,
    description,
    noindex: true,
    data: { "@type": "WebPage", name: title, description, publisher },
    body: `<section class="shared-head" aria-labelledby="shared-title">
<div class="wrap">
<p class="kicker">Shared report</p>
<h1 id="shared-title">A ${what} report, shared on ${shared}.</h1>
<div class="report-note">${icon("info")}<p>${SOURCE_TEXT[stored.source]} Anyone with this link can read the report until ${expires}, when it is deleted. <a href="/">Audit your own ${what}</a>.</p></div>
</div>
</section>
${sharedReportHtml(stored.report)}`,
  });
};
