import type { Finding, PageAudit, SeverityCounts } from "./types.js";

const PAGE_WEIGHTS = { error: 15, warning: 5, info: 1 } as const;
const SITE_WEIGHTS = { error: 10, warning: 3, info: 0.5 } as const;

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

export const pageScore = (counts: SeverityCounts): number => {
  const deduction =
    counts.error * PAGE_WEIGHTS.error +
    counts.warning * PAGE_WEIGHTS.warning +
    counts.info * PAGE_WEIGHTS.info;

  return clamp(Math.round(100 - deduction));
};

export const siteScore = (
  pages: PageAudit[],
  siteFindings: Finding[]
): number => {
  const avg = pages.length
    ? pages.reduce((sum, p) => sum + p.score, 0) / pages.length
    : 100;

  const deduction = siteFindings.reduce(
    (sum, f) => sum + SITE_WEIGHTS[f.severity],
    0
  );

  return clamp(Math.round(avg - deduction));
};
