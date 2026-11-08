import { finding, GOOGLE_DOCS } from "./rules/rule.js";
import type { Finding, PerformanceResult, RuleMeta } from "./types.js";

const meta = (
  id: string,
  severity: RuleMeta["severity"],
  description: string,
  recommendation: string,
  docs: string = GOOGLE_DOCS.cwv
): RuleMeta => ({
  id,
  category: "performance",
  severity,
  description,
  recommendation,
  docs,
  requires: "lighthouse",
});

export const PERFORMANCE_RULES: RuleMeta[] = [
  meta(
    "perf.lcp-slow",
    "warning",
    "Largest Contentful Paint above 2.5 s (poor above 4 s). Lab measurement from Lighthouse.",
    "Preload the LCP image/font, serve it from a CDN in a modern format, inline critical CSS, and cut server response time."
  ),
  meta(
    "perf.cls-high",
    "warning",
    "Cumulative Layout Shift above 0.1 (poor above 0.25).",
    "Reserve space for images, ads and embeds with width/height or aspect-ratio; avoid inserting content above existing content; use font-display: optional or size-adjusted fallbacks."
  ),
  meta(
    "perf.tbt-high",
    "warning",
    "Total Blocking Time above 200 ms (poor above 600 ms). Lab proxy for Interaction to Next Paint.",
    "Split long JavaScript tasks, defer non-critical scripts, remove unused JavaScript, and move work off the main thread."
  ),
  meta(
    "perf.fcp-slow",
    "info",
    "First Contentful Paint above 1.8 s (poor above 3 s).",
    "Eliminate render-blocking resources, inline critical CSS, and reduce server response time."
  ),
  meta(
    "perf.ttfb-slow",
    "warning",
    "Server response time (TTFB) above 800 ms.",
    "Cache HTML at the edge, avoid slow data fetches during render, and use a nearby region/CDN."
  ),
  meta(
    "perf.score-low",
    "warning",
    "Lighthouse performance score below 50.",
    "Work through the opportunities listed in the performance result, biggest savings first."
  ),
  meta(
    "perf.opportunity",
    "info",
    "A Lighthouse opportunity with measurable estimated savings.",
    "Apply the Lighthouse recommendation described in the finding."
  ),
  meta(
    "lighthouse.seo-audit-failed",
    "warning",
    "A Lighthouse SEO audit failed (rendered-DOM checks such as crawlable anchors, robots.txt validity).",
    "Follow the Lighthouse audit description in the finding.",
    "https://developer.chrome.com/docs/lighthouse/seo/"
  ),
  meta(
    "lighthouse.agentic-audit-failed",
    "info",
    "A Lighthouse agentic-browsing audit failed (llms.txt, accessibility tree quality, WebMCP). Experimental.",
    "Follow the Lighthouse audit description. These checks reflect how well AI agents can use the site and are not classic ranking factors.",
    "https://developer.chrome.com/docs/lighthouse/"
  ),
];

const byId = new Map(PERFORMANCE_RULES.map((r) => [r.id, r]));
const m = (id: string): RuleMeta => byId.get(id)!;

export function performanceFindings(result: PerformanceResult): Finding[] {
  const out: Finding[] = [];
  const url = result.finalUrl || result.requestedUrl;
  const add = (f: Finding) => out.push({ ...f, url });
  const { metrics } = result;

  if (metrics.lcpMs !== null && metrics.lcpMs > 2500) {
    add(
      finding(
        m("perf.lcp-slow"),
        `LCP is ${(metrics.lcpMs / 1000).toFixed(1)} s (${metrics.lcpMs > 4000 ? "poor" : "needs improvement"}).`,
        {
          severity: metrics.lcpMs > 4000 ? "error" : "warning",
          evidence: {
            lcpMs: Math.round(metrics.lcpMs),
            formFactor: result.formFactor,
          },
        }
      )
    );
  }

  if (metrics.cls !== null && metrics.cls > 0.1) {
    add(
      finding(
        m("perf.cls-high"),
        `CLS is ${metrics.cls.toFixed(3)} (${metrics.cls > 0.25 ? "poor" : "needs improvement"}).`,
        {
          severity: metrics.cls > 0.25 ? "error" : "warning",
          evidence: { cls: Number(metrics.cls.toFixed(3)) },
        }
      )
    );
  }

  if (metrics.tbtMs !== null && metrics.tbtMs > 200) {
    add(
      finding(
        m("perf.tbt-high"),
        `TBT is ${Math.round(metrics.tbtMs)} ms (${metrics.tbtMs > 600 ? "poor" : "needs improvement"}).`,
        {
          severity: metrics.tbtMs > 600 ? "error" : "warning",
          evidence: { tbtMs: Math.round(metrics.tbtMs) },
        }
      )
    );
  }

  if (metrics.fcpMs !== null && metrics.fcpMs > 1800) {
    add(
      finding(
        m("perf.fcp-slow"),
        `FCP is ${(metrics.fcpMs / 1000).toFixed(1)} s.`,
        {
          severity: metrics.fcpMs > 3000 ? "warning" : "info",
          evidence: { fcpMs: Math.round(metrics.fcpMs) },
        }
      )
    );
  }

  if (metrics.ttfbMs !== null && metrics.ttfbMs > 800) {
    add(
      finding(
        m("perf.ttfb-slow"),
        `Server response time is ${Math.round(metrics.ttfbMs)} ms.`,
        { evidence: { ttfbMs: Math.round(metrics.ttfbMs) } }
      )
    );
  }

  if (metrics.performanceScore !== null && metrics.performanceScore < 50) {
    add(
      finding(
        m("perf.score-low"),
        `Lighthouse performance score is ${metrics.performanceScore}/100.`,
        {
          evidence: {
            performanceScore: metrics.performanceScore,
            formFactor: result.formFactor,
          },
        }
      )
    );
  }

  for (const opp of result.opportunities.slice(0, 8)) {
    const savings = [
      opp.savingsMs ? `${Math.round(opp.savingsMs)} ms` : null,
      opp.savingsBytes ? `${Math.round(opp.savingsBytes / 1024)} KiB` : null,
    ]
      .filter(Boolean)
      .join(", ");

    add(
      finding(
        m("perf.opportunity"),
        `${opp.title}${savings ? ` (est. savings ${savings})` : ""}.`,
        {
          recommendation: opp.description,
          evidence: {
            auditId: opp.id,
            savingsMs: opp.savingsMs,
            savingsBytes: opp.savingsBytes,
            score: opp.score,
          },
        }
      )
    );
  }

  for (const audit of result.failedSeoAudits) {
    add(
      finding(
        m("lighthouse.seo-audit-failed"),
        `Lighthouse SEO audit "${audit.title}" failed${audit.displayValue ? `: ${audit.displayValue}` : ""}.`,
        {
          recommendation: audit.description,
          evidence: { auditId: audit.id, score: audit.score },
        }
      )
    );
  }

  for (const audit of result.agenticBrowsingAudits) {
    add(
      finding(
        m("lighthouse.agentic-audit-failed"),
        `Lighthouse agentic-browsing audit "${audit.title}" failed${audit.displayValue ? `: ${audit.displayValue}` : ""}.`,
        {
          recommendation: audit.description,
          evidence: { auditId: audit.id, score: audit.score },
        }
      )
    );
  }

  return out;
}
