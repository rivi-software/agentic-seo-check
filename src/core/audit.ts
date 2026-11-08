import { promises as fs } from "node:fs";
import path from "node:path";

import { crawlSite } from "./crawl.js";
import type {
  CrawlOptions as InternalCrawlOptions,
  CrawlResult,
  ProgressEvent,
} from "./crawl.js";
import { DEFAULT_USER_AGENT, fetchPage, toResponseInfo } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import { extractPage } from "./html/extract.js";
import { runLighthouse, LighthouseUnavailableError } from "./lighthouse.js";
import { performanceFindings } from "./performance-rules.js";
import { compareRender } from "./render-rules.js";
import { renderPage, RenderUnavailableError } from "./render.js";
import { runPageRules, sortFindings } from "./rules/index.js";
import { pageScore, siteScore } from "./score.js";
import { runSiteRules } from "./site-rules.js";
import type { PageRecord } from "./site-rules.js";
import { scanDirectory } from "./static.js";
import { buildSummary } from "./summary.js";
import { countFindings, DEFAULT_THRESHOLDS } from "./types.js";
import type {
  Audit,
  Finding,
  IssueRollup,
  PageAudit,
  PageSource,
  ResponseInfo,
  SiteAudit,
  Thresholds,
} from "./types.js";
import { isHttpUrl } from "./url.js";

export type { ProgressEvent } from "./crawl.js";

export interface AuditOptions {
  /** Target keyword/phrase for the keyword.* rules. */
  keyword?: string;
  /** Render with headless Chromium (Playwright) and compare against the server HTML. */
  render?: boolean;
  /** Run Lighthouse (performance + SEO + agentic-browsing categories). */
  lighthouse?: boolean;
  formFactor?: "mobile" | "desktop";
  /** Include info-level findings (default true). */
  includeInfo?: boolean;
  /** Rule ids to skip. */
  disableRules?: string[];
  thresholds?: Partial<Thresholds>;
  fetch?: FetchOptions;
  /** Base URL for inline HTML, files and directories (default http://localhost/). */
  baseUrl?: string;
  includeSubdomains?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

export interface CrawlOptions extends AuditOptions {
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  delayMs?: number;
  respectRobots?: boolean;
  checkExternalLinks?: boolean;
  maxLinkChecks?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  /** How much per-page detail to keep in the site result. */
  pageDetail?: "full" | "summary";
}

export interface HtmlAuditInput {
  url?: string;
  response?: ResponseInfo;
  source?: PageSource;
  target?: string;
  depth?: number;
}

export const DEFAULT_CRAWL = {
  maxPages: 50,
  maxDepth: 3,
  concurrency: 5,
  delayMs: 0,
  maxLinkChecks: 200,
} as const;

/** Audit an HTML string. `url` is used to resolve links and for display. */
export async function auditHtml(
  html: string,
  input: HtmlAuditInput = {},
  options: AuditOptions = {}
): Promise<PageAudit> {
  const url = input.url ?? options.baseUrl ?? "http://localhost/";

  const page = extractPage(html, {
    url,
    includeSubdomains: options.includeSubdomains,
  });

  const source = input.source ?? "html";
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };

  let findings = runPageRules(
    {
      page,
      source,
      response: input.response,
      keyword: options.keyword,
      thresholds,
      depth: input.depth,
    },
    { disable: new Set(options.disableRules ?? []) }
  );

  if (options.includeInfo === false) {
    findings = findings.filter((f) => f.severity !== "info");
  }

  const audit: PageAudit = {
    schemaVersion: 1,
    kind: "page",
    target: input.target ?? url,
    url: input.response?.finalUrl ?? url,
    source,
    auditedAt: new Date().toISOString(),
    summary: buildSummary(page, input.response),
    findings,
    counts: countFindings(findings),
    score: 0,
  };

  if (input.response) {
    audit.response = input.response;
  }

  if (input.depth !== undefined) {
    audit.depth = input.depth;
  }

  audit.score = pageScore(audit.counts);

  return audit;
}

/** Fetch and audit one URL. Optionally render and/or run Lighthouse. */
export async function auditUrl(
  url: string,
  options: AuditOptions = {}
): Promise<PageAudit> {
  const res = await fetchPage(url, options.fetch ?? {});
  const response = toResponseInfo(res);

  const audit = await auditHtml(
    res.body ?? "",
    { url: res.finalUrl, response, source: "url", target: url },
    options
  );

  if (res.error) {
    audit.findings.unshift({
      rule: "response.fetch-failed",
      severity: "error",
      category: "response",
      message: `Could not fetch ${url}: ${res.error}`,
      recommendation:
        "Check that the URL is reachable from this machine (DNS, TLS, firewall, dev server running) and that it responds within the timeout.",
      url,
      evidence: { error: res.error, redirectChain: res.redirectChain },
    });
    audit.counts = countFindings(audit.findings);
    audit.score = pageScore(audit.counts);

    return audit;
  }

  await enrichPage(audit, options);

  return audit;
}

/** Audit a single .html file from disk. */
export async function auditFile(
  filePath: string,
  options: AuditOptions = {}
): Promise<PageAudit> {
  const html = await fs.readFile(filePath, "utf8");
  const base = options.baseUrl ?? "http://localhost/";

  const url = new URL(
    `/${path.basename(filePath)}`,
    base.endsWith("/") ? base : `${base}/`
  ).href;

  return auditHtml(html, { url, source: "file", target: filePath }, options);
}

/** Crawl a site and audit every page plus site-level checks. */
export async function auditSite(
  startUrl: string,
  options: CrawlOptions = {}
): Promise<SiteAudit> {
  const fetchOpts: FetchOptions = { ...options.fetch };
  fetchOpts.userAgent ??= DEFAULT_USER_AGENT;

  const internal: InternalCrawlOptions = {
    maxPages: options.maxPages ?? DEFAULT_CRAWL.maxPages,
    maxDepth: options.maxDepth ?? DEFAULT_CRAWL.maxDepth,
    concurrency: options.concurrency ?? DEFAULT_CRAWL.concurrency,
    delayMs: options.delayMs ?? DEFAULT_CRAWL.delayMs,
    respectRobots: options.respectRobots ?? true,
    includeSubdomains: options.includeSubdomains ?? false,
    checkExternalLinks: options.checkExternalLinks ?? false,
    maxLinkChecks: options.maxLinkChecks ?? DEFAULT_CRAWL.maxLinkChecks,
    includePatterns: (options.includePatterns ?? []).map((p) => new RegExp(p)),
    excludePatterns: (options.excludePatterns ?? []).map((p) => new RegExp(p)),
    fetch: fetchOpts,
    onProgress: options.onProgress,
  };

  const result = await crawlSite(startUrl, internal);
  const site = await buildSiteAudit(result, "crawl", startUrl, options);
  // Render/Lighthouse are expensive: apply them to the start page only.
  const startPage = site.pages.find((p) => p.depth === 0) ?? site.pages[0];

  if (startPage && (options.render || options.lighthouse)) {
    await enrichPage(startPage, options);
    recomputeSite(site);
  }

  return shapeSite(site, options);
}

/** Audit a directory of built HTML files (dist/, out/, build/). */
export async function auditDirectory(
  dir: string,
  options: CrawlOptions = {}
): Promise<SiteAudit> {
  const result = await scanDirectory(dir, {
    baseUrl: options.baseUrl ?? "http://localhost/",
    includeSubdomains: options.includeSubdomains ?? false,
    maxPages: options.maxPages ?? 500,
    userAgent: options.fetch?.userAgent,
  });

  const site = await buildSiteAudit(result, "directory", dir, options);

  return shapeSite(site, options);
}

/**
 * Auto-detect the target type: http(s) URL, directory, .html file, or "-" for stdin.
 * `crawl` forces a site crawl for URLs.
 */
export async function auditTarget(
  target: string,
  options: CrawlOptions & { crawl?: boolean; stdinHtml?: string } = {}
): Promise<Audit> {
  if (target === "-" || options.stdinHtml !== undefined) {
    const html = options.stdinHtml ?? (await readStdin());

    return auditHtml(
      html,
      { url: options.baseUrl, source: "html", target: "stdin" },
      options
    );
  }

  if (isHttpUrl(target)) {
    return options.crawl
      ? auditSite(target, options)
      : auditUrl(target, options);
  }

  if (
    /^localhost(:\d+)?(\/|$)/i.test(target) ||
    /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(target)
  ) {
    const url = `http${/^localhost/i.test(target) ? "" : "s"}://${target}`;

    return options.crawl ? auditSite(url, options) : auditUrl(url, options);
  }

  const stat = await fs.stat(target).catch(() => null);

  if (!stat) {
    throw new Error(`Target "${target}" is not a URL, file or directory.`);
  }

  if (stat.isDirectory()) {
    return auditDirectory(target, options);
  }

  return auditFile(target, options);
}

async function enrichPage(
  audit: PageAudit,
  options: AuditOptions
): Promise<void> {
  const url = audit.response?.finalUrl ?? audit.url;
  const extra: Finding[] = [];

  if (options.render) {
    options.onProgress?.({
      phase: "render",
      message: `Rendering ${url} with Playwright`,
    });

    try {
      const rendered = await renderPage(url, {
        timeoutMs: Math.max(options.fetch?.timeoutMs ?? 0, 30_000),
        userAgent: options.fetch?.userAgent,
        headers: options.fetch?.headers,
      });

      const rawPage = extractPage(await rawHtmlFor(audit, options), {
        url,
        includeSubdomains: options.includeSubdomains,
      });

      const renderedPage = extractPage(rendered.html, {
        url: rendered.finalUrl,
        siteHost: new URL(url).hostname,
        includeSubdomains: options.includeSubdomains,
      });

      const { comparison, findings } = compareRender(
        rawPage,
        renderedPage,
        rendered.finalUrl,
        rendered.consoleErrors,
        audit.response
      );

      audit.rendering = comparison;
      extra.push(...findings);
    } catch (err) {
      extra.push(
        toolFinding(
          "tool.render-unavailable",
          err instanceof RenderUnavailableError
            ? err.message
            : `Rendering failed: ${(err as Error).message}`,
          url
        )
      );
    }
  }

  if (options.lighthouse) {
    options.onProgress?.({
      phase: "lighthouse",
      message: `Running Lighthouse (${options.formFactor ?? "mobile"}) on ${url}`,
    });

    try {
      const perf = await runLighthouse(url, {
        formFactor: options.formFactor ?? "mobile",
        userAgent: options.fetch?.userAgent,
        headers: options.fetch?.headers,
      });

      audit.performance = perf;
      extra.push(...performanceFindings(perf));
    } catch (err) {
      extra.push(
        toolFinding(
          "tool.lighthouse-unavailable",
          err instanceof LighthouseUnavailableError
            ? err.message
            : `Lighthouse failed: ${(err as Error).message}`,
          url
        )
      );
    }
  }

  if (extra.length) {
    const filtered =
      options.includeInfo === false
        ? extra.filter((f) => f.severity !== "info")
        : extra;

    audit.findings = sortFindings([...audit.findings, ...filtered]);
    audit.counts = countFindings(audit.findings);
    audit.score = pageScore(audit.counts);
  }
}

// The raw HTML is not kept on the audit (too large); re-fetch it for the render comparison.
async function rawHtmlFor(
  audit: PageAudit,
  options: AuditOptions
): Promise<string> {
  const res = await fetchPage(
    audit.response?.finalUrl ?? audit.url,
    options.fetch ?? {}
  );

  return res.body ?? "";
}

function toolFinding(rule: string, message: string, url: string): Finding {
  return {
    rule,
    severity: "info",
    category: "tool",
    message,
    recommendation:
      "Install the optional dependency (see message) or run without this option. The rest of the audit is complete.",
    url,
  };
}

async function buildSiteAudit(
  result: CrawlResult,
  source: "crawl" | "directory",
  target: string,
  options: CrawlOptions
): Promise<SiteAudit> {
  options.onProgress?.({
    phase: "rules",
    message: `Evaluating rules for ${result.records.length} pages`,
  });
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const pages: PageAudit[] = [];

  for (const record of result.records) {
    const audit = await auditRecord(
      record,
      source === "directory" ? "file" : "url",
      options
    );

    pages.push(audit);
  }

  let siteFindings = runSiteRules({
    startUrl: result.startUrl,
    source,
    pages: result.records,
    linkChecks: result.linkChecks,
    linkSources: result.linkSources,
    externalChecks: result.externalChecks,
    externalSources: result.externalSources,
    robots: result.robots,
    robotsAllows: result.robotsAllows,
    blockedByRobots: result.blockedByRobots,
    sitemaps: result.sitemaps,
    probes: result.probes,
    crawl: result.stats,
    thresholds,
    pathOnly: source === "directory",
    unlinkedPages: result.unlinkedPages,
  });

  const disabled = new Set(options.disableRules ?? []);
  siteFindings = sortFindings(
    siteFindings.filter((f) => !disabled.has(f.rule))
  );

  if (options.includeInfo === false) {
    siteFindings = siteFindings.filter((f) => f.severity !== "info");
  }

  const site: SiteAudit = {
    schemaVersion: 1,
    kind: "site",
    target,
    source,
    auditedAt: new Date().toISOString(),
    crawl: result.stats,
    robotsTxt: result.robots,
    sitemaps: { ...result.sitemaps, urls: result.sitemaps.urls.slice(0, 200) },
    pages: pages.sort(
      (a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.score - b.score
    ),
    siteFindings,
    issues: [],
    counts: { error: 0, warning: 0, info: 0 },
    score: 0,
  };

  recomputeSite(site);

  return site;
}

async function auditRecord(
  record: PageRecord,
  source: PageSource,
  options: CrawlOptions
): Promise<PageAudit> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };

  let findings = runPageRules(
    {
      page: record.page,
      source,
      response: record.response,
      keyword: options.keyword,
      thresholds,
      depth: record.depth,
    },
    { disable: new Set(options.disableRules ?? []) }
  );

  if (options.includeInfo === false) {
    findings = findings.filter((f) => f.severity !== "info");
  }

  const audit: PageAudit = {
    schemaVersion: 1,
    kind: "page",
    target: record.file ?? record.requestedUrl,
    url: record.file ?? record.url,
    source,
    auditedAt: new Date().toISOString(),
    summary: buildSummary(record.page, record.response),
    findings,
    counts: countFindings(findings),
    score: 0,
    depth: record.depth,
  };

  if (record.response) {
    audit.response = record.response;
  }

  audit.score = pageScore(audit.counts);

  return audit;
}

export function recomputeSite(site: SiteAudit): void {
  const counts = countFindings(site.siteFindings);

  for (const p of site.pages) {
    counts.error += p.counts.error;
    counts.warning += p.counts.warning;
    counts.info += p.counts.info;
  }

  site.counts = counts;
  site.issues = rollupIssues(site.pages);
  site.score = siteScore(site.pages, site.siteFindings);
}

export function rollupIssues(pages: PageAudit[]): IssueRollup[] {
  const map = new Map<string, IssueRollup & { urls: Set<string> }>();

  for (const page of pages) {
    const seenHere = new Set<string>();

    for (const f of page.findings) {
      if (seenHere.has(f.rule)) {
        continue;
      }

      seenHere.add(f.rule);
      let entry = map.get(f.rule);

      if (!entry) {
        entry = {
          rule: f.rule,
          severity: f.severity,
          category: f.category,
          pages: 0,
          message: f.message,
          recommendation: f.recommendation,
          examples: [],
          urls: new Set(),
        };
        map.set(f.rule, entry);
      }

      entry.pages++;
      entry.urls.add(page.url);
    }
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;

  return [...map.values()]
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.pages - a.pages)
    .map(({ urls, ...rest }) => ({
      ...rest,
      examples: [...urls].slice(0, 10),
    }));
}

function shapeSite(site: SiteAudit, options: CrawlOptions): SiteAudit {
  if (options.pageDetail === "summary") {
    site.pages = site.pages.map((p) => ({
      ...p,
      findings: [],
      summary: { ...p.summary, headings: [], openGraph: {} },
    }));
  }

  return site;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** Drop bulky, low-value fields to save tokens when the result is consumed by an LLM. */
export function compactAudit<T extends Audit>(audit: T): T {
  const trimFinding = (f: Finding): Finding => {
    if (!f.evidence) {
      return f;
    }

    const evidence: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(f.evidence)) {
      evidence[k] = Array.isArray(v) ? v.slice(0, 3) : v;
    }

    return { ...f, evidence };
  };

  const trimPage = (p: PageAudit): PageAudit => {
    const { performance, rendering, ...rest } = p;

    const out: PageAudit = {
      ...rest,
      summary: {
        ...p.summary,
        headings: p.summary.headings.slice(0, 10),
        openGraph: {},
      },
      findings: p.findings.map(trimFinding),
    };

    if (p.response) {
      out.response = { ...p.response, headers: {} };
    }

    if (performance) {
      out.performance = {
        ...performance,
        opportunities: performance.opportunities.slice(0, 5),
        agenticBrowsingAudits: [],
        failedSeoAudits: performance.failedSeoAudits.slice(0, 5),
      };
    }

    if (rendering) {
      out.rendering = {
        ...rendering,
        consoleErrors: rendering.consoleErrors.slice(0, 3),
      };
    }

    return out;
  };

  if (audit.kind === "page") {
    return trimPage(audit) as T;
  }

  return {
    ...audit,
    robotsTxt: audit.robotsTxt ? { ...audit.robotsTxt, text: null } : null,
    sitemaps: { ...audit.sitemaps, urls: audit.sitemaps.urls.slice(0, 20) },
    pages: audit.pages.map(trimPage),
    siteFindings: audit.siteFindings.map(trimFinding),
  } as T;
}
