import { promises as fs } from "node:fs";
import path from "node:path";

import {
  auditCrawled,
  DEFAULT_CRAWL,
  readStdin,
  resolveTarget,
  rollupIssues,
  seoCrawlOptions,
  trimFinding,
} from "../audit.js";
import type { CrawlOptions, ProgressEvent } from "../audit.js";
import { crawlSite, failedPageFindings, userPatterns } from "../crawl.js";
import type { CrawlResult, FailedPage } from "../crawl.js";
import {
  DEFAULT_USER_AGENT,
  fetchPage,
  RequestRefusedError,
  toResponseInfo,
} from "../fetch.js";
import type { FetchOptions } from "../fetch.js";
import { extractPage } from "../html/extract.js";
import {
  assignIds,
  compareWithBaseline,
  insertBefore,
  recordUrls,
  ruleRanWith,
} from "../recheck.js";
import type { Baseline } from "../recheck.js";
import { loadRobotsTxt } from "../robots.js";
import {
  AEO_PAGE_RULES,
  AEO_RULES,
  checkRuleIds,
  runPageRules,
  sortFindings,
} from "../rules/index.js";
import { robotsDirectives } from "../rules/indexing.js";
import { pageScore, siteScore } from "../score.js";
import type { PageRecord } from "../site-rules.js";
import { scanDirectory } from "../static.js";
import { countFindings, DEFAULT_THRESHOLDS } from "../types.js";
import type {
  AeoAudit,
  AeoPage,
  AiBotPurpose,
  AiCrawlerReport,
  Finding,
  LlmsTxtInfo,
  PageAudit,
  PageSource,
  Requirement,
  RobotsTxtInfo,
  SeverityCounts,
  SiteAudit,
} from "../types.js";
import { AI_BOTS, crawlerAccess } from "./bots.js";
import { loadLlmsTxt, readLlmsTxt } from "./llms-txt.js";
import { aeoPageSummary } from "./page.js";
import { probeBots } from "./probe.js";
import { aeoSiteFindings } from "./site-rules.js";

export interface AeoOptions {
  /** Crawl the site from a URL target instead of auditing one page. */
  crawl?: boolean;
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  delayMs?: number;
  respectRobots?: boolean;
  includeSubdomains?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
  /** Base URL for inline HTML, files and directories (default http://localhost/). */
  baseUrl?: string;
  /** Also request the page with each AI bot's User-Agent, to catch CDN or firewall blocks. */
  aiBots?: boolean;
  /** Include info-level findings (default true). */
  includeInfo?: boolean;
  /** Rule ids to skip. */
  disableRules?: string[];
  /** Run only these rule ids: a re-check of the rules a fix was for. */
  onlyRules?: string[];
  /**
   * The findings of an earlier AEO audit. The result then has `baseline`: the findings since
   * fixed, still open and new.
   */
  baseline?: Baseline;
  /** Site audits: "summary" keeps page findings out of `findings`; they stay rolled up in `issues`. */
  pageDetail?: "full" | "summary";
  fetch?: FetchOptions;
  onProgress?: (event: ProgressEvent) => void;
}

/** What a target gave the audit to work with, before any rule runs. */
interface Collected {
  target: string;
  url: string;
  source: AeoAudit["source"];
  pageSource: PageSource;
  records: PageRecord[];
  robots: RobotsTxtInfo | null;
  robotsText: string | null;
  llmsTxt: LlmsTxtInfo | null;
  /** The pages came over HTTP, so the bot probe can request them again. */
  live: boolean;
  /** Why the crawl stopped requesting the site before it was done (the hosted server's gate). */
  stopped?: string;
  /** Pages the audit failed on, and so left out of the crawl (issue #85). */
  failedPages?: FailedPage[];
}

/**
 * What a request for a site's file gave, or null when the gate refused it (the hosted server's): a
 * robots.txt or llms.txt that was not requested is unread, not missing.
 */
const unlessRefused = async <T>(pending: Promise<T>): Promise<T | null> => {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof RequestRefusedError) {
      return null;
    }

    throw error;
  }
};

interface EvaluatedPage {
  record: PageRecord;
  findings: Finding[];
  /** Info findings `includeInfo: false` left out: still on the page, for the re-check. */
  hidden: Finding[];
  counts: SeverityCounts;
  score: number;
}

const userAgentOf = (options: AeoOptions): string =>
  options.fetch?.userAgent ?? DEFAULT_USER_AGENT;

/** robots.txt and llms.txt of the origin a page is served from. */
const loadOrigin = async (pageUrl: string, options: AeoOptions) => {
  const { origin } = new URL(pageUrl);

  options.onProgress?.({
    phase: "robots",
    message: `Fetching ${origin}/robots.txt and ${origin}/llms.txt`,
  });

  const [robots, llmsTxt] = await Promise.all([
    unlessRefused(loadRobotsTxt(origin, userAgentOf(options), options.fetch)),
    unlessRefused(loadLlmsTxt(origin, options.fetch)),
  ]);

  return {
    robots: robots?.info ?? null,
    robotsText: robots?.text ?? null,
    llmsTxt,
  };
};

const collectUrl = async (
  url: string,
  options: AeoOptions
): Promise<Collected> => {
  const res = await fetchPage(url, options.fetch ?? {});

  const page = extractPage(res.body ?? "", {
    url: res.finalUrl,
    includeSubdomains: options.includeSubdomains,
  });

  // A page that never answered says nothing about the site; its robots.txt would fail the same way.
  const site =
    res.status === null ? null : await loadOrigin(res.finalUrl, options);

  return {
    target: url,
    url: res.finalUrl,
    source: "url",
    pageSource: "url",
    records: [
      {
        url: res.finalUrl,
        requestedUrl: url,
        page,
        response: toResponseInfo(res),
        depth: 0,
      },
    ],
    robots: site?.robots ?? null,
    robotsText: site?.robotsText ?? null,
    llmsTxt: site?.llmsTxt ?? null,
    live: true,
  };
};

/** What a crawl that has run gives the AEO audit: its pages and robots.txt, and the site's llms.txt. */
const collectCrawled = async (
  result: CrawlResult,
  url: string,
  options: AeoOptions
): Promise<Collected> => {
  options.onProgress?.({ phase: "llms-txt", message: "Fetching llms.txt" });
  const { origin } = new URL(result.startUrl);
  const request = () => loadLlmsTxt(origin, options.fetch);

  return {
    target: url,
    url: result.startUrl,
    source: "crawl",
    pageSource: "url",
    records: result.records,
    robots: result.robots,
    robotsText: result.robotsText ?? null,
    // Not requested at all once the crawl's own requests to the site were refused.
    llmsTxt: await (result.refusals
      ? result.refusals.run(`${origin}/llms.txt`, request)
      : request()),
    live: true,
    stopped: result.stopped?.message,
    failedPages: result.failedPages,
  };
};

const collectSite = async (
  url: string,
  options: AeoOptions
): Promise<Collected> => {
  const result = await crawlSite(url, {
    maxPages: options.maxPages ?? DEFAULT_CRAWL.maxPages,
    maxDepth: options.maxDepth ?? DEFAULT_CRAWL.maxDepth,
    concurrency: options.concurrency ?? DEFAULT_CRAWL.concurrency,
    delayMs: options.delayMs ?? DEFAULT_CRAWL.delayMs,
    respectRobots: options.respectRobots ?? true,
    includeSubdomains: options.includeSubdomains ?? false,
    checkExternalLinks: false,
    // The AEO audit reads pages; broken links, sitemaps and redirect probes are the SEO crawl's job.
    maxLinkChecks: 0,
    siteChecks: false,
    includePatterns: userPatterns(options.includePatterns, "include"),
    excludePatterns: userPatterns(options.excludePatterns, "exclude"),
    fetch: { ...options.fetch, userAgent: userAgentOf(options) },
    onProgress: options.onProgress,
  });

  return collectCrawled(result, url, options);
};

const collectDirectory = async (
  dir: string,
  options: AeoOptions
): Promise<Collected> => {
  const baseUrl = options.baseUrl ?? "http://localhost/";

  const result = await scanDirectory(dir, {
    baseUrl,
    includeSubdomains: options.includeSubdomains ?? false,
    maxPages: options.maxPages ?? 500,
    userAgent: options.fetch?.userAgent,
  });

  return {
    target: dir,
    url: dir,
    source: "directory",
    pageSource: "file",
    records: result.records,
    robots: result.robots,
    robotsText: result.robotsText ?? null,
    llmsTxt: await readLlmsTxt(dir, baseUrl),
    live: false,
  };
};

/** One page from HTML in hand: no site around it, so no robots.txt or llms.txt. */
const collectHtml = (
  html: string,
  url: string,
  target: string,
  source: "html" | "file",
  options: AeoOptions
): Collected => ({
  target,
  url,
  source,
  pageSource: source,
  records: [
    {
      url,
      requestedUrl: url,
      page: extractPage(html, {
        url,
        includeSubdomains: options.includeSubdomains,
      }),
      depth: 0,
    },
  ],
  robots: null,
  robotsText: null,
  llmsTxt: null,
  live: false,
});

/**
 * Findings the options leave in: not disabled, among `onlyRules`, and info only when asked for.
 * The info findings left out go to `hidden`: still there, so a re-check never calls them fixed.
 */
const selected = (
  findings: Finding[],
  options: AeoOptions,
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

const evaluatePage = (
  record: PageRecord,
  source: PageSource,
  options: AeoOptions
): EvaluatedPage => {
  const hidden: Finding[] = [];

  const findings = selected(
    runPageRules(
      {
        page: record.page,
        source,
        response: record.response,
        thresholds: DEFAULT_THRESHOLDS,
        depth: record.depth,
      },
      {
        disable: new Set(options.disableRules),
        only: options.onlyRules ? new Set(options.onlyRules) : undefined,
        rules: AEO_PAGE_RULES,
      }
    ),
    options,
    hidden
  );

  const counts = countFindings(findings);

  return { record, findings, hidden, counts, score: pageScore(counts) };
};

/**
 * Requests the start page as each AI bot and records the answers on `crawlers`. Returns why the
 * probe could not run, when it could not.
 */
const runProbe = async (
  c: Collected,
  start: EvaluatedPage | undefined,
  crawlers: AiCrawlerReport | null,
  options: AeoOptions
): Promise<string | undefined> => {
  const response = start?.record.response;

  if (!c.live || !response) {
    return "it needs a live URL, and this target is HTML, a file or a directory";
  }

  if (response.error || response.status === null || response.status >= 400) {
    return `the audit's own request got ${response.status === null ? "no answer" : `HTTP ${response.status}`}, so a refusal could not be told apart from a page that fails for everyone`;
  }

  if (!crawlers) {
    return "robots.txt could not be read";
  }

  options.onProgress?.({
    phase: "ai-bots",
    message: `Requesting ${response.finalUrl} with AI bot User-Agents`,
  });

  const probes = await probeBots(response.finalUrl, AI_BOTS, options.fetch);
  crawlers.probeBaseline = {
    userAgent: userAgentOf(options),
    status: response.status,
  };

  for (const bot of crawlers.bots) {
    const probe = probes.get(bot.name);

    if (probe) {
      bot.probe = probe;
    }
  }

  return undefined;
};

const blockedBots = (
  crawlers: AiCrawlerReport | null,
  purpose: AiBotPurpose
): string[] =>
  crawlers
    ? crawlers.bots
        .filter(
          (b) => b.purpose === purpose && (!b.allowed || b.blockedPages > 0)
        )
        .map((b) => b.name)
    : [];

const pageEntry = (p: EvaluatedPage): AeoPage => {
  // url and depth lead the entry, the way a reader scans a list of pages.
  const head: Pick<AeoPage, "url" | "depth"> = {
    url: p.record.file ?? p.record.url,
  };

  if (p.record.depth >= 0) {
    head.depth = p.record.depth;
  }

  return {
    ...head,
    score: p.score,
    counts: p.counts,
    summary: aeoPageSummary(p.record.page, p.record.response),
  };
};

/** Fails on `onlyRules` that name no AEO rule, before any request goes out. */
const checkOptions = (options: AeoOptions): void => {
  if (options.onlyRules) {
    checkRuleIds(options.onlyRules, AEO_RULES, "AEO");
  }
};

/**
 * Gives every finding its id and, with `baseline`, compares them with the earlier audit's. Site
 * rules ran when the target had a site to read robots.txt and llms.txt from.
 */
const recheck = (
  c: Collected,
  findings: Finding[],
  hidden: Finding[],
  options: AeoOptions
) => {
  assignIds([...findings, ...hidden]);

  if (!options.baseline) {
    return null;
  }

  const site = c.robots !== null || c.llmsTxt !== null;
  const active = new Set<Requirement>(site ? ["crawl"] : []);

  if (options.aiBots) {
    active.add("ai-bots");
  }

  return compareWithBaseline(findings, options.baseline, {
    // robots.txt and llms.txt findings name those files, not a page.
    urls: [
      c.url,
      c.target,
      ...recordUrls(c.records),
      ...(c.robots ? [c.robots.url] : []),
      ...(c.llmsTxt ? [c.llmsTxt.url] : []),
    ],
    site,
    hidden,
    ruleRan: ruleRanWith(
      {
        onlyRules: options.onlyRules,
        disableRules: options.disableRules,
        active,
      },
      AEO_RULES
    ),
  });
};

/** A build's error page (404.html, 500.html, 404/index.html, _not-found.html): never a page to list. */
const ERROR_PAGE_FILE =
  /(?:^|[/\\])(?:[45]\d{2}|_?not-found|_error)(?:[/\\]index)?\.html?$/iu;

/**
 * The pages an llms.txt fix may link to: those that answered below 400, are not set to noindex,
 * and are not a build's error page. A crawl records the HTML of a 404 or 500 page too.
 */
const listablePages = (
  records: PageRecord[]
): { url: string; title: string | null }[] =>
  records.flatMap((r) =>
    (r.response?.status ?? 200) < 400 &&
    !robotsDirectives(r.page, r.response).noindex &&
    !(r.file && ERROR_PAGE_FILE.test(r.file))
      ? [{ url: r.url, title: r.page.title }]
      : []
  );

const buildAudit = async (
  c: Collected,
  options: AeoOptions
): Promise<AeoAudit> => {
  const isSite = c.source === "crawl" || c.source === "directory";
  const pages = c.records.map((r) => evaluatePage(r, c.pageSource, options));
  const start = pages.find((p) => p.record.depth === 0) ?? pages[0];

  const crawlers = c.robots
    ? crawlerAccess(
        c.robots,
        c.robotsText,
        start?.record.url ?? c.url,
        c.records.map((r) => r.url)
      )
    : null;

  const probeSkipped = options.aiBots
    ? await runProbe(c, start, crawlers, options)
    : undefined;

  const hiddenSite: Finding[] = [];

  const siteFindings = selected(
    [
      ...aeoSiteFindings({
        crawlers,
        llmsTxt: c.llmsTxt,
        pages: listablePages(c.records),
        pageCount: pages.length,
        probeSkipped,
        crawlStopped: c.stopped,
      }),
      ...failedPageFindings(c.failedPages),
    ],
    options,
    hiddenSite
  );

  const pageFindings = pages.flatMap((p) => p.findings);

  const comparison = recheck(
    c,
    [...siteFindings, ...pageFindings],
    [...hiddenSite, ...pages.flatMap((p) => p.hidden)],
    options
  );

  let audit: AeoAudit = {
    schemaVersion: 1,
    kind: "aeo",
    target: c.target,
    url: c.url,
    source: c.source,
    score: siteScore(pages, siteFindings),
    counts: countFindings([...siteFindings, ...pageFindings]),
    auditedAt: new Date().toISOString(),
    summary: {
      pages: pages.length,
      robotsTxt: crawlers?.status ?? null,
      searchCrawlersBlocked: blockedBots(crawlers, "search"),
      answerBotsBlocked: blockedBots(crawlers, "answer"),
      trainingBotsBlocked: blockedBots(crawlers, "training"),
      trainingPreference: crawlers?.trainingPreference ?? null,
      blockedByServer: crawlers?.probeBaseline
        ? crawlers.bots.filter((b) => b.probe?.blocked).map((b) => b.name)
        : null,
      llmsTxt: c.llmsTxt?.status ?? null,
      page: start
        ? aeoPageSummary(start.record.page, start.record.response)
        : null,
    },
    findings: sortFindings(
      isSite && options.pageDetail === "summary"
        ? siteFindings
        : [...siteFindings, ...pageFindings]
    ),
    crawlers,
    llmsTxt: c.llmsTxt,
  };

  if (comparison) {
    audit = insertBefore(audit, "findings", "baseline", comparison);
  }

  if (isSite) {
    audit.pages = pages
      .toSorted((a, b) => a.record.depth - b.record.depth || a.score - b.score)
      .map(pageEntry);
    audit.issues = rollupIssues(
      pages.map((p) => ({
        url: p.record.file ?? p.record.url,
        findings: p.findings,
      }))
    );
  }

  return audit;
};

/** AEO audit of an HTML string. `url` is where the HTML would be served, for links and display. */
// oxlint-disable-next-line eslint/require-await -- public API: it returns a promise like the other audit functions, so a throw reaches callers as a rejection
export const auditAeoHtml = async (
  html: string,
  input: { url?: string; target?: string } = {},
  options: AeoOptions = {}
): Promise<AeoAudit> => {
  checkOptions(options);
  const url = input.url ?? options.baseUrl ?? "http://localhost/";

  return buildAudit(
    collectHtml(html, url, input.target ?? url, "html", options),
    options
  );
};

/** AEO audit of one live page, with its site's robots.txt and llms.txt. */
export const auditAeoUrl = async (
  url: string,
  options: AeoOptions = {}
): Promise<AeoAudit> => {
  checkOptions(options);

  return buildAudit(await collectUrl(url, options), options);
};

/** AEO audit of a site, crawled from `startUrl`. */
export const auditAeoSite = async (
  startUrl: string,
  options: AeoOptions = {}
): Promise<AeoAudit> => {
  checkOptions(options);

  return buildAudit(await collectSite(startUrl, options), options);
};

/** What `auditSiteBoth` takes: the crawl's options, which both audits share. */
export type SiteAuditsOptions = Pick<
  CrawlOptions,
  | "maxPages"
  | "maxDepth"
  | "concurrency"
  | "delayMs"
  | "respectRobots"
  | "includeSubdomains"
  | "checkExternalLinks"
  | "maxLinkChecks"
  | "includePatterns"
  | "excludePatterns"
  | "maxSitemaps"
  | "maxSitemapBytes"
  | "includeInfo"
  | "pageDetail"
  | "fetch"
  | "onProgress"
>;

/** The two audits of a site from one crawl, and those of its start page. */
export interface SiteAudits {
  /** The SEO audit, as auditSite gives it. */
  seo: SiteAudit;
  /** The AEO audit, as auditAeoSite gives it. */
  aeo: AeoAudit;
  /**
   * The start page's own audits, with every finding on it and its fix, as auditUrl and auditAeoUrl
   * give them; null when the crawl recorded no page.
   */
  start: { seo: PageAudit; aeo: AeoAudit } | null;
}

/**
 * The SEO and the AEO audit of a site from one crawl (issue #45): each page is requested once and
 * both audits read it, where auditSite and auditAeoSite would each request it. The AEO audit adds
 * llms.txt. For the website's form; src/index.ts does not export it.
 */
export const auditSiteBoth = async (
  startUrl: string,
  options: SiteAuditsOptions = {}
): Promise<SiteAudits> => {
  const result = await crawlSite(startUrl, seoCrawlOptions(options));
  const seo = await auditCrawled(result, startUrl, options);

  const aeoOptions: AeoOptions = {
    includeInfo: options.includeInfo,
    pageDetail: options.pageDetail,
    fetch: options.fetch,
    onProgress: options.onProgress,
  };

  const c = await collectCrawled(result, startUrl, aeoOptions);
  const aeo = await buildAudit(c, aeoOptions);
  const startRecord = c.records.find((r) => r.depth === 0) ?? c.records[0];

  if (!(seo.start && startRecord)) {
    return { seo: seo.site, aeo, start: null };
  }

  // The start page alone, as auditAeoUrl reads it: the site's robots.txt and llms.txt, one page.
  const startAeo = await buildAudit(
    {
      ...c,
      target: startRecord.requestedUrl,
      url: startRecord.url,
      source: "url",
      records: [startRecord],
      stopped: undefined,
      failedPages: undefined,
    },
    { ...aeoOptions, pageDetail: "full" }
  );

  return { seo: seo.site, aeo, start: { seo: seo.start, aeo: startAeo } };
};

/** AEO audit of a directory of built HTML, with the robots.txt and llms.txt in it. */
export const auditAeoDirectory = async (
  dir: string,
  options: AeoOptions = {}
): Promise<AeoAudit> => {
  checkOptions(options);

  return buildAudit(await collectDirectory(dir, options), options);
};

/** AEO audit of a URL (a crawl with `crawl`), a directory, an .html file, or "-" for stdin. */
export const auditAeoTarget = async (
  target: string,
  options: AeoOptions & { stdinHtml?: string } = {}
): Promise<AeoAudit> => {
  checkOptions(options);

  if (target === "-" || options.stdinHtml !== undefined) {
    const html = options.stdinHtml ?? (await readStdin());

    return auditAeoHtml(
      html,
      { url: options.baseUrl, target: "stdin" },
      options
    );
  }

  const resolved = await resolveTarget(target);

  switch (resolved.kind) {
    case "url": {
      return options.crawl
        ? auditAeoSite(resolved.url, options)
        : auditAeoUrl(resolved.url, options);
    }

    case "directory": {
      return auditAeoDirectory(resolved.path, options);
    }

    default: {
      const base = options.baseUrl ?? "http://localhost/";

      const url = new URL(
        `/${path.basename(target)}`,
        base.endsWith("/") ? base : `${base}/`
      ).href;

      return buildAudit(
        collectHtml(
          await fs.readFile(target, "utf-8"),
          url,
          target,
          "file",
          options
        ),
        options
      );
    }
  }
};

/** Drops bulky detail to save tokens when an LLM reads the result. */
export const compactAeoAudit = (audit: AeoAudit): AeoAudit => ({
  ...audit,
  findings: audit.findings.map(trimFinding),
  crawlers: audit.crawlers
    ? {
        ...audit.crawlers,
        contentSignals: audit.crawlers.contentSignals.slice(0, 3),
      }
    : null,
  llmsTxt: audit.llmsTxt
    ? { ...audit.llmsTxt, sections: audit.llmsTxt.sections.slice(0, 5) }
    : null,
});
