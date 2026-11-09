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

/**
 * What a fix edits: `html` is the page as served (change the template, component or file that
 * renders it), `http` the server's response for a URL (status line, headers, redirects: server, CDN
 * or framework config), `robots.txt`, `sitemap` and `llms.txt` those files, and `asset` another file
 * the site serves, such as an image or a script.
 */
export type FixTarget =
  | "html"
  | "http"
  | "robots.txt"
  | "sitemap"
  | "llms.txt"
  | "asset";

/**
 * One edit of a fix. `current` is quoted from what the server sent, so an agent can find it in the
 * source; `code` is what to write instead. A quote cut short at 500 characters ends in "…".
 */
export interface FixEdit {
  in: FixTarget;
  /** `replace` swaps `current` for `code`, `add` writes `code` at `at`, `remove` deletes `current`. */
  action: "add" | "replace" | "remove";
  /** The URL whose file or response to change, when it is not the finding's own page. */
  url?: string;
  /**
   * Where in the file: a CSS selector in HTML ("head" for an edit that adds to <head>), a header
   * name, a robots.txt group ("User-agent: *"), a JSON-LD object ("Product").
   */
  at?: string;
  /** What is there now: the tag, header, line or value to replace or remove, as the server sent it. */
  current?: string;
  /**
   * The code to write. Text in `{{` `}}` is a slot for words only the author can write, such as a
   * title; `write` says what goes in it. Everything else is exact.
   */
  code?: string;
  /** What goes in the `{{…}}` slots, or the part of the edit code cannot show. */
  write?: string;
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
  /**
   * The edits that resolve this finding on this page or site; apply all of them. At most 10: a
   * re-check shows what is left. Absent when there is nothing on the site to change.
   */
  fix?: FixEdit[];
  /** CSS selector or location hint for where the problem lives in the HTML. */
  selector?: string;
  /** Current values, counts, offending items (capped lists). */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- free-form JSON for the reader: each rule records whatever values it found
  evidence?: Record<string, unknown>;
  docs?: string;
  /** Page URL or file path the finding belongs to (absent for site-wide findings that list pages in evidence). */
  url?: string;
  /**
   * Stable across audits of the same page: `rule@hash`, from the rule, the URL and what the finding
   * is about. A re-check with `baseline` matches findings by it. Findings the rule cannot tell
   * apart are numbered (`~1`, `~2`), and a re-check never calls those fixed.
   */
  id?: string;
}

/** A finding of the earlier audit that this one no longer reports. */
export interface FixedFinding {
  id: string;
  rule: string;
  /** Known when the baseline was an audit rather than a list of ids. */
  url?: string;
  message?: string;
}

/**
 * How this audit compares with an earlier one (`baseline`): which findings a fix resolved, which
 * are still open and which are new. Only findings this audit could check are compared: those whose
 * rule ran again on a page it audited again.
 */
export interface BaselineComparison {
  fixed: FixedFinding[];
  /** Ids of findings both audits report. */
  open: string[];
  /** Ids of findings only this audit reports: a new problem, or one a fix caused. */
  new: string[];
  /** Findings of the earlier audit this one did not check: their rule did not run, or their page was not audited. */
  notChecked: number;
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
  srcset: string | null;
  /** The image sits in a <picture>, whose <source> elements offer other sizes or formats. */
  inPicture: boolean;
  fetchpriority: string | null;
  /** The `<img>` tag as the HTML writes it, for a fix to quote. */
  tag: string;
  /**
   * Words of visible text before the image, a rough measure of how far down the page it is; null
   * for an image that does not render where it is written (inside <template>, <noscript>, <svg>).
   */
  wordsBefore: number | null;
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
  /** The `<a>` start tag as the HTML writes it, for a fix to quote. */
  tag: string;
  /** The whole `<a>` element as the HTML writes it, cut at 500 characters. */
  outer: string;
}

export interface HreflangInfo {
  lang: string;
  href: string;
  url: string | null;
  /** The `<link>` tag as the HTML writes it, for a fix to quote. */
  tag: string;
}

export interface StructuredDataItem {
  source: "json-ld" | "microdata";
  types: string[];
  context: string | null;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the page's own JSON-LD or microdata, in whatever schema.org shape it has
  data: Record<string, unknown>;
  /** JSON-LD: the text of the <script> the item comes from, as written (cut at 20,000 characters), for a fix to quote. */
  scriptText?: string;
}

export interface StructuredDataError {
  source: "json-ld";
  message: string;
  snippet: string;
  /** Which `<script type="application/ld+json">` of the page it is, counted from 0 (the index into `markup.jsonLd`). */
  script: number;
  /** The script's text as written (cut at 20,000 characters), for a fix to quote. */
  text: string;
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

/** A subresource the page requests: a script, stylesheet, frame, image or media file. */
export interface ResourceInfo {
  /**
   * What browsers do with it on an https page: they upgrade `image` and `media` (audio, video) to
   * https and block the rest, including a `responsive-image` (an image with srcset or in a
   * <picture>) and a `track` (subtitles).
   */
  kind:
    | "script"
    | "stylesheet"
    | "frame"
    | "object"
    | "image"
    | "responsive-image"
    | "media"
    | "track";
  /** Absolute http(s) URL. */
  url: string;
  /** The URL as the attribute writes it, before it is resolved, for a fix to quote. */
  raw: string;
  /** The element that loads it ("script", "img", ...) and the attribute the URL is in ("src", "srcset", ...). */
  element: string;
  attribute: string;
}

/** A `<meta http-equiv="refresh">`: reload or redirect after a number of seconds. */
export interface MetaRefresh {
  /** Seconds before it acts, or null when the content does not start with a number. */
  seconds: number | null;
  /** Where it redirects to as written, or null when it only reloads the page. */
  url: string | null;
}

/** How <head> reads to a parser, and the metadata that sits outside it. */
export interface HeadSignals {
  /**
   * The element or text that ended <head> before the author's `</head>` or `<body>`, quoted from
   * the source (`<img src="/pixel.gif">`, `text "Loading"`), or null when <head> holds only
   * elements that belong there.
   */
  closedBy: string | null;
  /** `closedBy` sits in a `<noscript>`, which only parsers that do not run JavaScript read as markup. */
  closedInNoscript: boolean;
  /** Metadata written after `closedBy`, which a parser then puts in <body>: `<link rel="canonical">`. */
  afterClose: string[];
  /** Metadata written in <body> itself (after `</head>` or `<body>`). */
  inBody: string[];
  /**
   * Metadata in <body> inside a hidden element: how React streams tags (Next.js streaming metadata)
   * that its JavaScript then moves into <head>.
   */
  streamedInBody: string[];
  refresh: MetaRefresh[];
  /** Byte offset where the element declaring the character encoding ends, or null when none does. */
  charsetEndByte: number | null;
  /** `src` of scripts in <head> without async, defer or type="module", which stop the parser. */
  blockingScripts: string[];
  /** `href` of icon links: rel icon, shortcut icon, apple-touch-icon(-precomposed). */
  icons: string[];
  /** The source of what the fields above describe, as the HTML writes it, for a fix to quote. */
  sources: HeadSources;
}

/**
 * Source quotes for `HeadSignals`, cut to 500 characters with a trailing "…" like the rest of
 * `PageMarkup`.
 */
export interface HeadSources {
  /**
   * What to move out of <head>: the element that ended it (whole), the text, or, when it sat in a
   * <noscript>, that whole <noscript> block. Null when nothing ended <head> early.
   */
  closedBy: string | null;
  /** Each element of `inBody`, in the same order. */
  inBody: string[];
  /** Each element of `streamedInBody`, in the same order. */
  streamedInBody: string[];
  /** Each `<meta http-equiv="refresh">` of `refresh`, in the same order. */
  refresh: string[];
  /** Each `<script>` start tag of `blockingScripts`, in the same order. */
  blockingScripts: string[];
}

/** A paragraph-like element of the body (`<p>`, `<li>`, `<td>`, ...) that holds no other such element. */
export interface TextBlock {
  /** Its visible text, whitespace collapsed. */
  text: string;
  /** The whole element as written, cut at 500 characters (a cut quote ends in "…"). */
  outer: string;
  /** Its start tag as written. */
  tag: string;
  /** The element name, for its end tag. */
  name: string;
}

/**
 * Tags as the HTML writes them, so a fix can quote what to replace. Elements the parser added
 * itself (an `<html>` or `<head>` the page leaves out) have no tag: null.
 */
export interface PageMarkup {
  /** The `<html>` start tag. */
  html: string | null;
  /** The `<head>` start tag. */
  head: string | null;
  /** Each `<title>` element, in the order of `titles`. */
  titles: string[];
  /** Each meta description tag, in the order of `metaDescriptions`. */
  metaDescriptions: string[];
  /** Each robots meta tag (robots, googlebot, googlebot-news, bingbot), empty ones included. */
  metaRobots: string[];
  /** Each `<link rel="canonical">`, in the order of `canonicals`. */
  canonicals: string[];
  /** Each heading element, in the order of `headings`. */
  headings: string[];
  viewport: string | null;
  /** The `<meta charset>` or `<meta http-equiv="content-type">` tag. */
  charset: string | null;
  /** The tag of each Open Graph and Twitter property, keyed as in `og` and `twitter` with its prefix ("og:image"). */
  social: Record<string, string>;
  /** Each `<script type="application/ld+json">` start tag, in document order. */
  jsonLd: string[];
  /** The body's text blocks in document order, the first 300, for a fix that rewrites a passage. */
  blocks: TextBlock[];
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
  /** Scripts, stylesheets, frames, images and media the page requests. */
  resources: ResourceInfo[];
  /** A Content-Security-Policy meta tag tells browsers to upgrade the page's http:// requests to https. */
  upgradesInsecureRequests: boolean;
  /** `href="#name"` values with no element on the page whose id (or `<a name>`) is that name. */
  missingFragments: string[];
  structuredData: StructuredDataItem[];
  structuredDataErrors: StructuredDataError[];
  /** Visible text of <body> with scripts/styles removed and whitespace collapsed. */
  text: string;
  wordCount: number;
  htmlBytes: number;
  hasBaseHref: boolean;
  head: HeadSignals;
  markup: PageMarkup;
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
  /** With `baseline`: what changed since the earlier audit. */
  baseline?: BaselineComparison;
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
  /** Size of the file in bytes, or null when there is none. */
  bytes: number | null;
  error?: string;
}

/** A count of sitemap entries with one problem, and the first few of them. */
export interface SitemapExamples {
  count: number;
  /** "URL (value)" for the first 10. */
  examples: string[];
}

/** Where the sitemaps break the sitemap protocol or what Google reads of it. */
export interface SitemapProblems {
  /**
   * Sitemaps over 50,000 URLs or 50 MB uncompressed (`overLimit`), or larger than the 15 MB this
   * audit reads, which it could not check.
   */
  oversized: {
    sitemap: string;
    urls: number | null;
    bytes: number | null;
    overLimit: boolean;
  }[];
  /** Sitemap indexes that another sitemap index lists, which Google does not read. */
  nestedIndexes: string[];
  /** URLs whose <lastmod> is not a W3C Datetime such as 2026-11-09 or 2026-11-09T10:00:00+01:00. */
  invalidLastmod: SitemapExamples;
  /** URLs whose <lastmod> is later than the time of the audit. */
  futureLastmod: SitemapExamples;
  /** URLs on another host than the audited site. */
  otherHost: SitemapExamples;
}

export interface SitemapInfo {
  /** Sitemap (and sitemap index) URLs that were fetched. */
  sources: string[];
  /** Page URLs listed across all sitemaps (capped). */
  urls: string[];
  urlCount: number;
  errors: string[];
  problems: SitemapProblems;
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
  /** With `baseline`: what changed since the earlier audit, over site and page findings. */
  baseline?: BaselineComparison;
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
  /** With `baseline`: what changed since the earlier audit, over site and page findings. */
  baseline?: BaselineComparison;
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
