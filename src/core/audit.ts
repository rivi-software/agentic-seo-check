import { promises as fs } from "node:fs";
import path from "node:path";

import { crawlSite, failedPageFindings, userPatterns } from "./crawl.js";
import type {
  CrawlOptions as InternalCrawlOptions,
  CrawlResult,
  ProgressEvent,
} from "./crawl.js";
import { caughtError, ExpectedError } from "./errors.js";
import { DEFAULT_USER_AGENT, fetchPage, toResponseInfo } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import { extractPage } from "./html/extract.js";
import { runLighthouse, LighthouseUnavailableError } from "./lighthouse.js";
import { performanceFindings } from "./performance-rules.js";
import {
  assignIds,
  compareWithBaseline,
  insertBefore,
  recordUrls,
  ruleRanWith,
} from "./recheck.js";
import type { Baseline } from "./recheck.js";
import { compareRender } from "./render-rules.js";
import { renderPage, RenderUnavailableError } from "./render.js";
import {
  checkRuleIds,
  runPageRules,
  SEO_RULES,
  sortFindings,
} from "./rules/index.js";
import { pageScore, siteScore } from "./score.js";
import { runSiteRules } from "./site-rules.js";
import type { PageRecord } from "./site-rules.js";
import { scanDirectory } from "./static.js";
import { buildSummary } from "./summary.js";
import { countFindings, DEFAULT_THRESHOLDS } from "./types.js";
import type {
  Audit,
  BaselineComparison,
  Finding,
  IssueRollup,
  PageAudit,
  PageSource,
  Requirement,
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
  /** Run only these rule ids: a re-check of the rules a fix was for. */
  onlyRules?: string[];
  /**
   * The findings of an earlier audit. The result then has `baseline`: the findings since fixed,
   * still open and new.
   */
  baseline?: Baseline;
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
  /** Sitemap files to read at most, sitemap indexes included (default 25). */
  maxSitemaps?: number;
  /** The most of one sitemap to read, uncompressed (default 15 MB). */
  maxSitemapBytes?: number;
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

const toolFinding = (rule: string, message: string, url: string): Finding => ({
  rule,
  severity: "info",
  category: "tool",
  message,
  recommendation:
    "Install the optional dependency (see message) or run without this option. The rest of the audit is complete.",
  url,
});

/**
 * Info findings that `includeInfo: false` left out of an audit. They are still on the page, so the
 * re-check keeps them: an earlier finding that is only hidden now is not fixed.
 */
const hiddenInfo = new WeakMap<PageAudit | SiteAudit, Finding[]>();

const hiddenOf = (audit: PageAudit | SiteAudit): Finding[] => {
  let hidden = hiddenInfo.get(audit);

  if (!hidden) {
    hidden = [];
    hiddenInfo.set(audit, hidden);
  }

  return hidden;
};

/**
 * Findings the options leave in: not disabled, among `onlyRules`, and info only when asked for.
 * The info findings left out go to `hidden`.
 */
const selected = (
  findings: Finding[],
  options: AuditOptions,
  hidden: Finding[]
): Finding[] => {
  const disabled = new Set(options.disableRules);
  const only = options.onlyRules ? new Set(options.onlyRules) : null;
  const shown: Finding[] = [];

  for (const f of findings) {
    if (disabled.has(f.rule) || (only && !only.has(f.rule))) {
      continue;
    }

    (options.includeInfo === false && f.severity === "info"
      ? hidden
      : shown
    ).push(f);
  }

  return shown;
};

const ruleFilter = (options: AuditOptions) => ({
  disable: new Set(options.disableRules),
  only: options.onlyRules ? new Set(options.onlyRules) : undefined,
});

/** The capabilities an SEO audit ran with, which decide the rules that ran. */
const seoCapabilities = (
  options: AuditOptions,
  site: boolean
): Set<Requirement> => {
  const active = new Set<Requirement>();

  if (site) {
    active.add("crawl");
  }

  if (options.render) {
    active.add("render");
  }

  if (options.lighthouse) {
    active.add("lighthouse");
  }

  if (options.keyword) {
    active.add("keyword");
  }

  return active;
};

/**
 * Gives every finding its id and, with `baseline`, compares them with the earlier audit's.
 * `urls` are the pages this audit checked, in every form a finding may name them.
 */
const recheck = (
  findings: Finding[],
  options: AuditOptions,
  scope: { urls: Iterable<string>; site: boolean; hidden: Finding[] }
): BaselineComparison | null => {
  assignIds([...findings, ...scope.hidden]);

  if (!options.baseline) {
    return null;
  }

  return compareWithBaseline(findings, options.baseline, {
    urls: scope.urls,
    site: scope.site,
    hidden: scope.hidden,
    ruleRan: ruleRanWith(
      {
        onlyRules: options.onlyRules,
        disableRules: options.disableRules,
        active: seoCapabilities(options, scope.site),
      },
      SEO_RULES
    ),
  });
};

const finishPage = (audit: PageAudit, options: AuditOptions): PageAudit => {
  const urls = [audit.url, audit.target];

  if (audit.response) {
    urls.push(audit.response.finalUrl);
  }

  const comparison = recheck(audit.findings, options, {
    urls,
    site: false,
    hidden: hiddenInfo.get(audit) ?? [],
  });

  return comparison
    ? insertBefore(audit, "findings", "baseline", comparison)
    : audit;
};

const finishSite = (
  site: SiteAudit,
  options: AuditOptions,
  urls: Iterable<string>
): SiteAudit => {
  const comparison = recheck(
    [...site.siteFindings, ...site.pages.flatMap((p) => p.findings)],
    options,
    {
      urls,
      site: true,
      hidden: [site, ...site.pages].flatMap((a) => hiddenInfo.get(a) ?? []),
    }
  );

  return comparison
    ? insertBefore(site, "siteFindings", "baseline", comparison)
    : site;
};

/** Fails on `onlyRules` that name no SEO rule. */
const checkOptions = (options: AuditOptions): void => {
  if (options.onlyRules) {
    checkRuleIds(options.onlyRules, SEO_RULES, "SEO");
  }
};

// The raw HTML is not kept on the audit (too large); re-fetch it for the render comparison.
const rawHtmlFor = async (
  audit: PageAudit,
  options: AuditOptions
): Promise<string> => {
  const res = await fetchPage(
    audit.response?.finalUrl ?? audit.url,
    options.fetch ?? {}
  );

  return res.body ?? "";
};

/** Renders the page in Chromium and compares it with the server HTML, on `audit.rendering`. */
const renderFindings = async (
  audit: PageAudit,
  options: AuditOptions,
  url: string
): Promise<Finding[]> => {
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

    return findings;
  } catch (error) {
    // A finding for the user, and maybe a bug of ours (issue #60): the CLI's and the MCP server's
    // error tracking hears it, unless it is an expected failure.
    caughtError(error);

    return [
      toolFinding(
        "tool.render-unavailable",
        error instanceof RenderUnavailableError
          ? error.message
          : `Rendering failed: ${error instanceof Error ? error.message : String(error)}`,
        url
      ),
    ];
  }
};

/** Runs Lighthouse on the page, on `audit.performance`. */
const lighthouseFindings = async (
  audit: PageAudit,
  options: AuditOptions,
  url: string
): Promise<Finding[]> => {
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

    return performanceFindings(perf);
  } catch (error) {
    // As in renderFindings.
    caughtError(error);

    return [
      toolFinding(
        "tool.lighthouse-unavailable",
        error instanceof LighthouseUnavailableError
          ? error.message
          : `Lighthouse failed: ${error instanceof Error ? error.message : String(error)}`,
        url
      ),
    ];
  }
};

const enrichPage = async (
  audit: PageAudit,
  options: AuditOptions
): Promise<void> => {
  const url = audit.response?.finalUrl ?? audit.url;
  const extra: Finding[] = [];

  if (options.render) {
    extra.push(...(await renderFindings(audit, options, url)));
  }

  if (options.lighthouse) {
    extra.push(...(await lighthouseFindings(audit, options, url)));
  }

  if (extra.length) {
    for (const f of extra) {
      f.url ??= url;
    }

    const filtered = selected(extra, options, hiddenOf(audit));

    audit.findings = sortFindings([...audit.findings, ...filtered]);
    audit.counts = countFindings(audit.findings);
    audit.score = pageScore(audit.counts);
  }
};

const auditRecord = (
  record: PageRecord,
  source: PageSource,
  options: CrawlOptions
): PageAudit => {
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
    ruleFilter(options)
  );

  const hidden: Finding[] = [];
  findings = selected(findings, options, hidden);

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

  hiddenInfo.set(audit, hidden);

  if (record.response) {
    audit.response = record.response;
  }

  audit.score = pageScore(audit.counts);

  return audit;
};

export const rollupIssues = (
  pages: Pick<PageAudit, "url" | "findings">[]
): IssueRollup[] => {
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

      entry.pages += 1;
      entry.urls.add(page.url);
    }
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;

  return [...map.values()]
    .toSorted(
      (a, b) => rank[a.severity] - rank[b.severity] || b.pages - a.pages
    )
    .map(({ urls, ...rest }) => ({
      ...rest,
      examples: [...urls].slice(0, 10),
    }));
};

export const recomputeSite = (site: SiteAudit): void => {
  const counts = countFindings(site.siteFindings);

  for (const p of site.pages) {
    counts.error += p.counts.error;
    counts.warning += p.counts.warning;
    counts.info += p.counts.info;
  }

  site.counts = counts;
  site.issues = rollupIssues(site.pages);
  site.score = siteScore(site.pages, site.siteFindings);
};

const buildSiteAudit = (
  result: CrawlResult,
  source: "crawl" | "directory",
  target: string,
  options: CrawlOptions
): SiteAudit => {
  options.onProgress?.({
    phase: "rules",
    message: `Evaluating rules for ${result.records.length} pages`,
  });

  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };

  const pages = result.records.map((record) =>
    auditRecord(record, source === "directory" ? "file" : "url", options)
  );

  let siteFindings = runSiteRules({
    startUrl: result.startUrl,
    source,
    pages: result.records,
    linkChecks: result.linkChecks,
    linkSources: result.linkSources,
    externalChecks: result.externalChecks,
    externalSources: result.externalSources,
    robots: result.robots,
    robotsText: result.robotsText ?? null,
    robotsAllows: result.robotsAllows,
    blockedByRobots: result.blockedByRobots,
    sitemaps: result.sitemaps,
    probes: result.probes,
    crawl: result.stats,
    thresholds,
    pathOnly: source === "directory",
    unlinkedPages: result.unlinkedPages,
    imageChecks: result.imageChecks,
    imageSources: result.imageSources,
    crawlStopped: result.stopped?.message,
  });

  siteFindings.push(...failedPageFindings(result.failedPages));

  const hiddenSite: Finding[] = [];
  siteFindings = sortFindings(selected(siteFindings, options, hiddenSite));

  const site: SiteAudit = {
    schemaVersion: 1,
    kind: "site",
    target,
    source,
    auditedAt: new Date().toISOString(),
    crawl: result.stats,
    robotsTxt: result.robots,
    sitemaps: { ...result.sitemaps, urls: result.sitemaps.urls.slice(0, 200) },
    pages: pages.toSorted(
      (a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.score - b.score
    ),
    siteFindings,
    issues: [],
    counts: { error: 0, warning: 0, info: 0 },
    score: 0,
  };

  hiddenInfo.set(site, hiddenSite);
  recomputeSite(site);

  return site;
};

/** Keeps only each page's summary when the caller asked for `pageDetail: "summary"`. */
const applyPageDetail = (site: SiteAudit, options: CrawlOptions): SiteAudit => {
  if (options.pageDetail === "summary") {
    site.pages = site.pages.map((p) => ({
      ...p,
      findings: [],
      summary: { ...p.summary, headings: [], openGraph: {} },
    }));
  }

  return site;
};

/** The page audit of an HTML string, before ids and the baseline comparison. */
const auditHtmlPage = (
  html: string,
  input: HtmlAuditInput,
  options: AuditOptions
): PageAudit => {
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
    ruleFilter(options)
  );

  const hidden: Finding[] = [];
  findings = selected(findings, options, hidden);

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

  hiddenInfo.set(audit, hidden);

  if (input.response) {
    audit.response = input.response;
  }

  if (input.depth !== undefined) {
    audit.depth = input.depth;
  }

  audit.score = pageScore(audit.counts);

  return audit;
};

/** Audit an HTML string. `url` is used to resolve links and for display. */
// oxlint-disable-next-line eslint/require-await -- public API: it returns a promise like the other audit functions, so a throw reaches callers as a rejection
export const auditHtml = async (
  html: string,
  input: HtmlAuditInput = {},
  options: AuditOptions = {}
): Promise<PageAudit> => {
  checkOptions(options);

  return finishPage(auditHtmlPage(html, input, options), options);
};

/** Fetch and audit one URL. Optionally render and/or run Lighthouse. */
export const auditUrl = async (
  url: string,
  options: AuditOptions = {}
): Promise<PageAudit> => {
  checkOptions(options);
  const res = await fetchPage(url, options.fetch ?? {});
  const response = toResponseInfo(res);

  const audit = auditHtmlPage(
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
      fix: [
        {
          in: "http",
          action: "add",
          at: "response",
          code: "HTTP/1.1 200 OK\nContent-Type: text/html; charset=utf-8",
          write: `Make the URL answer from this machine within the timeout: start the dev server, or fix the DNS record, TLS certificate or firewall rule behind "${res.error}".`,
        },
      ],
      url,
      evidence: { error: res.error, redirectChain: res.redirectChain },
    });
    audit.counts = countFindings(audit.findings);
    audit.score = pageScore(audit.counts);

    return finishPage(audit, options);
  }

  await enrichPage(audit, options);

  return finishPage(audit, options);
};

/** Audit a single .html file from disk. */
export const auditFile = async (
  filePath: string,
  options: AuditOptions = {}
): Promise<PageAudit> => {
  const html = await fs.readFile(filePath, "utf-8");
  const base = options.baseUrl ?? "http://localhost/";

  const url = new URL(
    `/${path.basename(filePath)}`,
    base.endsWith("/") ? base : `${base}/`
  ).href;

  return auditHtml(html, { url, source: "file", target: filePath }, options);
};

/** What `crawlSite` is given for an SEO crawl with `options`. */
export const seoCrawlOptions = (
  options: CrawlOptions
): InternalCrawlOptions => {
  const fetchOpts: FetchOptions = { ...options.fetch };
  fetchOpts.userAgent ??= DEFAULT_USER_AGENT;

  return {
    maxPages: options.maxPages ?? DEFAULT_CRAWL.maxPages,
    maxDepth: options.maxDepth ?? DEFAULT_CRAWL.maxDepth,
    concurrency: options.concurrency ?? DEFAULT_CRAWL.concurrency,
    delayMs: options.delayMs ?? DEFAULT_CRAWL.delayMs,
    respectRobots: options.respectRobots ?? true,
    includeSubdomains: options.includeSubdomains ?? false,
    checkExternalLinks: options.checkExternalLinks ?? false,
    maxLinkChecks: options.maxLinkChecks ?? DEFAULT_CRAWL.maxLinkChecks,
    includePatterns: userPatterns(options.includePatterns, "include"),
    excludePatterns: userPatterns(options.excludePatterns, "exclude"),
    fetch: fetchOpts,
    onProgress: options.onProgress,
    maxSitemaps: options.maxSitemaps,
    maxSitemapBytes: options.maxSitemapBytes,
  };
};

/**
 * The SEO audit of a site that `crawlSite` crawled with `seoCrawlOptions(options)`, and the audit
 * of its start page with every finding, whatever `pageDetail` keeps of it in the site's. Another
 * audit can then read the same crawl (`auditSiteBoth`), so no page is requested twice.
 */
export const auditCrawled = async (
  result: CrawlResult,
  startUrl: string,
  options: CrawlOptions
): Promise<{ site: SiteAudit; start: PageAudit | null }> => {
  const site = buildSiteAudit(result, "crawl", startUrl, options);
  // Render/Lighthouse are expensive: apply them to the start page only.
  const startPage = site.pages.find((p) => p.depth === 0) ?? site.pages[0];

  if (startPage && (options.render || options.lighthouse)) {
    await enrichPage(startPage, options);
    recomputeSite(site);
  }

  return {
    // applyPageDetail gives the site copies of its pages, so startPage keeps its findings.
    site: applyPageDetail(
      finishSite(site, options, recordUrls(result.records)),
      options
    ),
    start: startPage ?? null,
  };
};

/** Crawl a site and audit every page plus site-level checks. */
export const auditSite = async (
  startUrl: string,
  options: CrawlOptions = {}
): Promise<SiteAudit> => {
  checkOptions(options);
  const result = await crawlSite(startUrl, seoCrawlOptions(options));
  const { site } = await auditCrawled(result, startUrl, options);

  return site;
};

/** Audit a directory of built HTML files (dist/, out/, build/). */
export const auditDirectory = async (
  dir: string,
  options: CrawlOptions = {}
): Promise<SiteAudit> => {
  checkOptions(options);

  const result = await scanDirectory(dir, {
    baseUrl: options.baseUrl ?? "http://localhost/",
    includeSubdomains: options.includeSubdomains ?? false,
    maxPages: options.maxPages ?? 500,
    userAgent: options.fetch?.userAgent,
  });

  const site = buildSiteAudit(result, "directory", dir, options);

  return applyPageDetail(
    finishSite(site, options, recordUrls(result.records)),
    options
  );
};

export type ResolvedTarget =
  | { kind: "stdin" }
  | { kind: "url"; url: string }
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string };

/**
 * What a target names: "-" for stdin, an http(s) URL, a bare host such as `example.com/page` or
 * `localhost:3000`, a directory or a file.
 */
export const resolveTarget = async (
  target: string
): Promise<ResolvedTarget> => {
  if (target === "-") {
    return { kind: "stdin" };
  }

  if (isHttpUrl(target)) {
    return { kind: "url", url: target };
  }

  if (
    /^localhost(?::\d+)?(?:\/|$)/iu.test(target) ||
    /^[\w.-]+\.[a-z]{2,}(?:\/|$)/iu.test(target)
  ) {
    return {
      kind: "url",
      url: `http${/^localhost/iu.test(target) ? "" : "s"}://${target}`,
    };
  }

  const stat = await fs.stat(target).catch(() => null);

  if (!stat) {
    throw new ExpectedError(
      `Target "${target}" is not a URL, file or directory.`
    );
  }

  return stat.isDirectory()
    ? { kind: "directory", path: target }
    : { kind: "file", path: target };
};

/** HTML piped to the process. */
export const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
};

/**
 * Auto-detect the target type: http(s) URL, directory, .html file, or "-" for stdin.
 * `crawl` forces a site crawl for URLs.
 */
export const auditTarget = async (
  target: string,
  options: CrawlOptions & { crawl?: boolean; stdinHtml?: string } = {}
): Promise<Audit> => {
  const resolved: ResolvedTarget =
    options.stdinHtml === undefined
      ? await resolveTarget(target)
      : { kind: "stdin" };

  switch (resolved.kind) {
    case "stdin": {
      const html = options.stdinHtml ?? (await readStdin());

      return auditHtml(
        html,
        { url: options.baseUrl, source: "html", target: "stdin" },
        options
      );
    }

    case "url": {
      return options.crawl
        ? auditSite(resolved.url, options)
        : auditUrl(resolved.url, options);
    }

    case "directory": {
      return auditDirectory(resolved.path, options);
    }

    default: {
      return auditFile(resolved.path, options);
    }
  }
};

/** Keeps the first three items of every evidence list. */
export const trimFinding = (f: Finding): Finding => {
  if (!f.evidence) {
    return f;
  }

  const evidence: NonNullable<Finding["evidence"]> = {};

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

/** Drop bulky, low-value fields to save tokens when the result is consumed by an LLM. */
export const compactAudit = <T extends Audit>(audit: T): T => {
  if (audit.kind === "page") {
    // SAFETY: T is the page audit here (kind is "page"), and trimPage returns a page audit with
    // every field it was given.
    return trimPage(audit) as T;
  }

  // SAFETY: T is the site audit here; the spread keeps every field and only shortens lists.
  return {
    ...audit,
    robotsTxt: audit.robotsTxt ? { ...audit.robotsTxt, text: null } : null,
    sitemaps: { ...audit.sitemaps, urls: audit.sitemaps.urls.slice(0, 20) },
    pages: audit.pages.map(trimPage),
    siteFindings: audit.siteFindings.map(trimFinding),
  } as T;
};
