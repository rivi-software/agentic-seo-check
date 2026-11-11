/**
 * The words the reports for people use: the website's HTML report and the CLI's text report say
 * the same things, so both read them from here.
 */
import type { AiBotPurpose, Category, FixEdit, Severity } from "../types.js";

/** The severities, most severe first: the order every report lists them in. */
export const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];

/** A score's band, as Lighthouse draws them: good from 90, fair from 50, poor below. */
export type Band = "good" | "fair" | "poor";

/** Lighthouse's bands: 90 and up is good, under 50 is poor. */
export const band = (score: number): Band => {
  if (score >= 90) {
    return "good";
  }

  return score >= 50 ? "fair" : "poor";
};

export const ACTION_LABEL: Record<FixEdit["action"], string> = {
  add: "Add",
  replace: "Replace",
  remove: "Remove",
};

export const TARGET_LABEL: Record<FixEdit["in"], string> = {
  html: "the page's HTML",
  http: "the HTTP response",
  "robots.txt": "robots.txt",
  sitemap: "the sitemap",
  "llms.txt": "llms.txt",
  asset: "a file the site serves",
};

/** What each kind of AI crawler fetches pages for, as the reports group them. */
export const PURPOSE_LABEL: Record<AiBotPurpose, string> = {
  search: "Search index",
  answer: "AI answers",
  training: "Model training",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  title: "Titles",
  meta: "Meta descriptions",
  headings: "Headings",
  canonical: "Canonical URLs",
  indexing: "Indexing and robots",
  document: "The document",
  social: "Open Graph and Twitter cards",
  images: "Images",
  links: "Links",
  international: "hreflang and languages",
  "structured-data": "Structured data",
  content: "Content",
  keyword: "Keywords",
  response: "The HTTP response",
  rendering: "JavaScript rendering",
  performance: "Performance",
  site: "Site-wide checks",
  aeo: "AI answer engines",
  tool: "The audit itself",
};

/** "1 page", "2 pages". */
export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "1 error", "2 errors"; info has no plural. */
export const countLabel = (severity: Severity, count: number): string =>
  severity === "info" ? `${count} info` : plural(count, severity);
