import { robotsDirectives } from "./rules/indexing.js";
import type { ExtractedPage, PageSummary, ResponseInfo } from "./types.js";

export function buildSummary(
  page: ExtractedPage,
  response?: ResponseInfo
): PageSummary {
  const robots = robotsDirectives(page, response);

  return {
    title: page.title,
    titleLength: page.title?.length ?? 0,
    metaDescription: page.metaDescription,
    metaDescriptionLength: page.metaDescription?.length ?? 0,
    canonical: page.canonical,
    lang: page.lang,
    robots: robots.directives,
    indexable: !robots.noindex && (response?.status ?? 200) < 400,
    h1: page.h1s,
    headings: page.headings.slice(0, 40),
    wordCount: page.wordCount,
    images: {
      total: page.images.length,
      missingAlt: page.images.filter((i) => i.alt === null).length,
    },
    links: {
      internal: page.links.filter((l) => l.internal).length,
      external: page.links.filter((l) => l.url && !l.internal).length,
      nofollow: page.links.filter((l) => l.nofollow).length,
    },
    openGraph: page.og,
    twitterCard: page.twitter["card"] ?? null,
    structuredDataTypes: [
      ...new Set(page.structuredData.flatMap((i) => i.types)),
    ],
    hreflangCount: page.hreflang.length,
  };
}
