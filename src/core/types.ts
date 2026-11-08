/**
 * Shared types for the SEO audit core. These shapes are the public contract
 * of the CLI JSON output and the MCP tool results (`schemaVersion: 1`).
 */

export type Severity = "error" | "warning" | "info";

export const SEVERITY_RANK: Record<Severity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

export type Category =
  | "title"
  | "meta"
  | "headings"
  | "canonical"
  | "indexing"
  | "document"
  | "social"
  | "images"
  | "links"
  | "international"
  | "structured-data"
  | "content"
  | "keyword"
  | "response"
  | "rendering"
  | "performance"
  | "site"
  | "tool";

export type Requirement = "render" | "lighthouse" | "crawl" | "keyword";

/** Static description of a rule, exposed through `seo_list_rules` / `agentic-seo-check rules`. */
export interface RuleMeta {
  id: string;
  category: Category;
  /** Typical severity. Individual findings may escalate or downgrade. */
  severity: Severity;
  description: string;
  recommendation: string;
  docs?: string;
  /** Only runs when this capability/mode is active. */
  requires?: Requirement;
}

/** One actionable problem. Designed to be read by an agent that will edit code. */
export interface Finding {
  rule: string;
  severity: Severity;
  category: Category;
  /** What is wrong, stated as a fact about this page/site. */
  message: string;
  /** What to change. Concrete and framework-agnostic. */
  recommendation: string;
  /** Page URL or file path the finding belongs to (absent for site-wide findings that list pages in evidence). */
  url?: string;
  /** CSS selector or location hint for where the problem lives in the HTML. */
  selector?: string;
  /** Current values, counts, offending items (capped lists). */
  evidence?: Record<string, unknown>;
  docs?: string;
}

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
}

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface ImageInfo {
  src: string | null;
  alt: string | null;
  width: string | null;
  height: string | null;
  loading: string | null;
}

export interface LinkInfo {
  href: string;
  /** Absolute resolved URL, or null if it could not be resolved (mailto:, javascript:, malformed). */
  url: string | null;
  text: string;
  rel: string | null;
  internal: boolean;
  nofollow: boolean;
  /** True when the link has visible text, an aria-label, a title, or an image with alt text. */
  hasAccessibleName: boolean;
}

export interface HreflangInfo {
  lang: string;
  href: string;
  url: string | null;
}

export interface StructuredDataItem {
  source: "json-ld" | "microdata";
  types: string[];
  context: string | null;
  data: Record<string, unknown>;
}

export interface StructuredDataError {
  source: "json-ld";
  message: string;
  snippet: string;
}

/** Everything the extractor pulls out of one HTML document. Rules read only this. */
export interface ExtractedPage {
  /** URL used to resolve relative links (the final URL after redirects, or the base URL for files/inline HTML). */
  url: string;
  hasDoctype: boolean;
  lang: string | null;
  charset: string | null;
  viewport: string | null;
  titles: string[];
  title: string | null;
  metaDescriptions: string[];
  metaDescription: string | null;
  /** Content of <meta name="robots"> and <meta name="googlebot">, lower-cased. */
  metaRobots: string[];
  canonicals: string[];
  canonical: string | null;
  headings: HeadingInfo[];
  h1s: string[];
  og: Record<string, string>;
  twitter: Record<string, string>;
  images: ImageInfo[];
  links: LinkInfo[];
  hreflang: HreflangInfo[];
  structuredData: StructuredDataItem[];
  structuredDataErrors: StructuredDataError[];
  /** Visible text of <body> with scripts/styles removed and whitespace collapsed. */
  text: string;
  wordCount: number;
  htmlBytes: number;
  hasBaseHref: boolean;
}

export interface RedirectHop {
  url: string;
  status: number;
}

export interface ResponseInfo {
  status: number | null;
  finalUrl: string;
  redirectChain: RedirectHop[];
  timeMs: number | null;
  contentType: string | null;
  /** Lower-cased header names. Only SEO-relevant headers are kept. */
  headers: Record<string, string>;
  error?: string;
}

export interface PageSummary {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  lang: string | null;
  robots: string[];
  indexable: boolean;
  h1: string[];
  headings: HeadingInfo[];
  wordCount: number;
  images: { total: number; missingAlt: number };
  links: { internal: number; external: number; nofollow: number };
  openGraph: Record<string, string>;
  twitterCard: string | null;
  structuredDataTypes: string[];
  hreflangCount: number;
}

export interface LighthouseMetrics {
  performanceScore: number | null;
  seoScore: number | null;
  agenticBrowsingScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  ttfbMs: number | null;
  inpMs: number | null;
}

export interface LighthouseOpportunity {
  id: string;
  title: string;
  description: string;
  score: number | null;
  savingsMs: number | null;
  savingsBytes: number | null;
}

export interface LighthouseAuditSummary {
  id: string;
  title: string;
  description: string;
  score: number | null;
  displayValue: string | null;
}

export interface PerformanceResult {
  tool: "lighthouse";
  lighthouseVersion: string;
  formFactor: "mobile" | "desktop";
  requestedUrl: string;
  finalUrl: string;
  metrics: LighthouseMetrics;
  opportunities: LighthouseOpportunity[];
  failedSeoAudits: LighthouseAuditSummary[];
  agenticBrowsingAudits: LighthouseAuditSummary[];
}

export interface RenderComparison {
  tool: "playwright";
  renderedUrl: string;
  consoleErrors: string[];
  raw: RenderSnapshot;
  rendered: RenderSnapshot;
}

export interface RenderSnapshot {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robots: string[];
  h1Count: number;
  wordCount: number;
  internalLinks: number;
  structuredDataCount: number;
}

export type PageSource = "url" | "file" | "html";

export interface PageAudit {
  schemaVersion: 1;
  kind: "page";
  /** What the caller asked for (URL, path, or "inline-html"). */
  target: string;
  /** Final URL after redirects, or the file path. */
  url: string;
  source: PageSource;
  auditedAt: string;
  response?: ResponseInfo;
  summary: PageSummary;
  findings: Finding[];
  counts: SeverityCounts;
  /** 0-100. Indicative only: 100 minus weighted deductions per finding. */
  score: number;
  performance?: PerformanceResult;
  rendering?: RenderComparison;
  /** Crawl depth from the start URL (site audits only). */
  depth?: number;
}

export interface RobotsTxtInfo {
  url: string;
  status: number | null;
  found: boolean;
  sitemaps: string[];
  /** Raw text, capped. */
  text: string | null;
  error?: string;
}

export interface SitemapInfo {
  /** Sitemap (and sitemap index) URLs that were fetched. */
  sources: string[];
  /** Page URLs listed across all sitemaps (capped). */
  urls: string[];
  urlCount: number;
  errors: string[];
}

export interface CrawlStats {
  pagesCrawled: number;
  pagesDiscovered: number;
  linksChecked: number;
  maxPages: number;
  maxDepth: number;
  hitPageLimit: boolean;
  durationMs: number;
  respectedRobots: boolean;
}

export interface IssueRollup {
  rule: string;
  severity: Severity;
  category: Category;
  pages: number;
  message: string;
  recommendation: string;
  /** Up to 10 example URLs. */
  examples: string[];
}

export interface SiteAudit {
  schemaVersion: 1;
  kind: "site";
  target: string;
  source: "crawl" | "directory";
  auditedAt: string;
  crawl: CrawlStats;
  robotsTxt: RobotsTxtInfo | null;
  sitemaps: SitemapInfo;
  pages: PageAudit[];
  /** Findings that span pages (duplicates, broken links, sitemap mismatches, ...). */
  siteFindings: Finding[];
  /** Page-level findings rolled up by rule, most severe and most frequent first. */
  issues: IssueRollup[];
  counts: SeverityCounts;
  score: number;
}

export type Audit = PageAudit | SiteAudit;

export interface Thresholds {
  titleMinChars: number;
  titleMaxChars: number;
  descriptionMinChars: number;
  descriptionMaxChars: number;
  h1MaxChars: number;
  thinContentWords: number;
  slowResponseMs: number;
  deepPageDepth: number;
  maxKeywordDensityPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  titleMinChars: 30,
  titleMaxChars: 60,
  descriptionMinChars: 70,
  descriptionMaxChars: 160,
  h1MaxChars: 70,
  thinContentWords: 300,
  slowResponseMs: 2000,
  deepPageDepth: 3,
  maxKeywordDensityPercent: 3,
};

export function emptyCounts(): SeverityCounts {
  return { error: 0, warning: 0, info: 0 };
}

export function countFindings(findings: Finding[]): SeverityCounts {
  const counts = emptyCounts();

  for (const f of findings) {
    counts[f.severity]++;
  }

  return counts;
}
