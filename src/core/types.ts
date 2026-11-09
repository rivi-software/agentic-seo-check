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
  | "aeo"
  | "tool";

export type Requirement =
  | "render"
  | "lighthouse"
  | "crawl"
  | "keyword"
  | "ai-bots";

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
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- free-form JSON for the reader: each rule records whatever values it found
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
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the page's own JSON-LD or microdata, in whatever schema.org shape it has
  data: Record<string, unknown>;
}

export interface StructuredDataError {
  source: "json-ld";
  message: string;
  snippet: string;
}

/** A heading (or FAQ `<summary>`/`<dt>`) phrased as a question, and the text that follows it. */
export interface QuestionHeading {
  /** 1-6 for h1-h6, 0 for `<summary>` and `<dt>`. */
  level: number;
  text: string;
  /** Words between the question and the next heading or question. */
  sectionWords: number;
  /** Words in the first paragraph, list item or definition after the question, or null when there is none. */
  firstBlockWords: number | null;
}

/** What an answer engine needs from a page beyond classic SEO, read once by the extractor. */
export interface AnswerSignals {
  /** Content of each robots meta tag by name (robots, googlebot, bingbot, ...), lower-cased. */
  robotsMeta: { name: string; content: string }[];
  questions: QuestionHeading[];
  /** Lists with two or more items outside navigation, header, footer and aside. */
  lists: number;
  /** Tables with two or more rows outside navigation, header, footer and aside. */
  tables: number;
  /** Elements with `data-nosnippet`, the outermost ones only. */
  nosnippetElements: number;
  nosnippetWords: number;
  nosnippetSelectors: string[];
  /** Selector of an empty JavaScript app root (`#root`, `#__next`, ...), when the page has one. */
  emptyAppRoot: string | null;
  /** A `<noscript>` element mentions JavaScript ("please enable JavaScript"). */
  noscriptAsksForJavaScript: boolean;
  /** `<time>` elements in the body. */
  timeElements: number;
  /** The visible text contains a written date (2026-03-14, 14/03/2026, March 14, 2026, 14 March 2026). */
  mentionsDate: boolean;
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
  /** Signals the AEO audit reads; the SEO rules do not use them. */
  answer: AnswerSignals;
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

/**
 * What an AI crawler fetches pages for, which decides what blocking it costs: `search` crawlers
 * feed a search index that AI answers draw on (Google AI Overviews, Copilot), `answer` bots fetch
 * pages for an AI answer or an AI search index, `training` bots collect text to train models.
 */
export type AiBotPurpose = "search" | "answer" | "training";

/** What the server answered a request with an AI bot's User-Agent (`aiBots` only). */
export interface BotProbe {
  status: number | null;
  /** The server refused or challenged this User-Agent while the audit's own request got the page. */
  blocked: boolean;
  /** Why it counts as blocked: "HTTP 403", "challenge page", "connection failed: ...". */
  reason: string | null;
}

export interface AiBotAccess {
  /** The bot's robots.txt token, e.g. "OAI-SearchBot". */
  name: string;
  operator: string;
  purpose: AiBotPurpose;
  usedFor: string;
  /**
   * The robots.txt group the bot follows: "named" when a group names it, "googlebot" for Applebot
   * following the Googlebot group (Apple's documented fallback), "wildcard" when only
   * `User-agent: *` applies, "none" when nothing does.
   */
  robotsGroup: "named" | "googlebot" | "wildcard" | "none";
  /** robots.txt lets the bot fetch the audited page (the start page of a crawl or directory). */
  allowed: boolean;
  /**
   * Audited pages robots.txt keeps this bot from while `User-agent: *` lets crawlers fetch them.
   * Paths disallowed for every crawler are left to the SEO audit's `site.robots-blocked-pages`.
   */
  blockedPages: number;
  probe?: BotProbe;
}

/** One `Content-Signal` line of robots.txt (contentsignals.org). */
export interface ContentSignal {
  /** User agents of the robots.txt group the line sits in. */
  userAgents: string[];
  /** The path the line is limited to, or null for the whole site. */
  path: string | null;
  /** Each signal and its value as written, lower-cased: { search: "yes", "ai-input": "no" }. */
  signals: Record<string, string>;
}

export interface AiCrawlerReport {
  robotsTxt: string;
  status: "found" | "missing" | "unreachable";
  httpStatus: number | null;
  /**
   * The shared AI training preference (`User-Agent: __usage_ai-training`) for the audited page:
   * "disallowed" opts out of training, "none" when robots.txt names no such group.
   */
  trainingPreference: "allowed" | "disallowed" | "none";
  contentSignals: ContentSignal[];
  bots: AiBotAccess[];
  /** With `aiBots`: the User-Agent and status of the audit's own request, which each probe is compared with. */
  probeBaseline?: { userAgent: string; status: number | null };
}

export interface LlmsTxtInfo {
  url: string;
  status: "found" | "missing" | "invalid";
  httpStatus: number | null;
  /** The H1 line, the one part the llms.txt format requires. */
  title: string | null;
  /** The blockquote after the title. */
  summary: string | null;
  /** H2 section names (capped). */
  sections: string[];
  /** Markdown links in the file. */
  links: number;
  bytes: number;
  /** Why the file does not follow the format, when it does not. */
  problems: string[];
}

export interface AeoPageSummary {
  indexable: boolean;
  /** "blocked" by nosnippet or max-snippet:0, "limited" by a short max-snippet or data-nosnippet. */
  googleSnippets: "allowed" | "limited" | "blocked";
  /** "excluded" by noarchive or noindex, "snippet-only" by nocache (Bing's rules for Copilot). */
  copilotAnswers: "allowed" | "snippet-only" | "excluded";
  wordCount: number;
  questions: number;
  structuredDataTypes: string[];
  author: string | null;
  datePublished: string | null;
  dateModified: string | null;
}

export interface AeoPage {
  url: string;
  depth?: number;
  score: number;
  counts: SeverityCounts;
  summary: AeoPageSummary;
}

export interface AeoSummary {
  pages: number;
  /** null when the target has no site to read robots.txt from (an HTML string or a single file). */
  robotsTxt: "found" | "missing" | "unreachable" | null;
  searchCrawlersBlocked: string[];
  answerBotsBlocked: string[];
  trainingBotsBlocked: string[];
  trainingPreference: "allowed" | "disallowed" | "none" | null;
  /** Bots the server refused or challenged, with `aiBots`; null without it. */
  blockedByServer: string[] | null;
  llmsTxt: "found" | "missing" | "invalid" | null;
  /** The audited page, or the start page of a crawl or directory. */
  page: AeoPageSummary | null;
}

/**
 * An answer engine optimization audit: can AI crawlers reach the site, may answer engines quote
 * it, and is the content easy to lift into an answer. Its score counts AEO findings only.
 */
export interface AeoAudit {
  schemaVersion: 1;
  kind: "aeo";
  target: string;
  url: string;
  source: PageSource | "crawl" | "directory";
  /** 0-100. Indicative only: the average page score minus weighted site-wide findings. */
  score: number;
  counts: SeverityCounts;
  auditedAt: string;
  summary: AeoSummary;
  /**
   * Site-wide findings (robots.txt, llms.txt, bot probes), then the page findings: all of them for
   * one page or with `pageDetail: "full"`, none for a site with `pageDetail: "summary"` (see `issues`).
   */
  findings: Finding[];
  crawlers: AiCrawlerReport | null;
  llmsTxt: LlmsTxtInfo | null;
  /** Crawl and directory audits: each page's score and summary. */
  pages?: AeoPage[];
  /** Crawl and directory audits: page findings rolled up by rule. */
  issues?: IssueRollup[];
}

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

export const emptyCounts = (): SeverityCounts => ({
  error: 0,
  warning: 0,
  info: 0,
});

export const countFindings = (findings: Finding[]): SeverityCounts => {
  const counts = emptyCounts();

  for (const f of findings) {
    counts[f.severity] += 1;
  }

  return counts;
};
