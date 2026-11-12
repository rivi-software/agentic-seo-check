import { REPOSITORY_URL } from "../brand.js";
import { mapConcurrent, sleep } from "./concurrency.js";
import { caughtError, ExpectedError } from "./errors.js";
import {
  DEFAULT_USER_AGENT,
  fetchPage,
  forAuditOf,
  isHtmlResponse,
  probeUrl,
  toResponseInfo,
} from "./fetch.js";
import type {
  FetchOptions,
  FetchResult,
  RequestRefusedError,
} from "./fetch.js";
import { extractPage } from "./html/extract.js";
import { trackRefusals } from "./refusals.js";
import type { Refusals } from "./refusals.js";
import { loadRobotsTxt, robotsUserAgentToken } from "./robots.js";
import type { RobotsResult } from "./robots.js";
import { isLocalHost } from "./rules/canonical.js";
import { cap } from "./rules/rule.js";
import { checkImages, probeUrlVariants } from "./site-probes.js";
import type { ImageCheckResult, ProbeOptions } from "./site-probes.js";
import type { LinkCheck, PageRecord, ProbeResults } from "./site-rules.js";
import { emptySitemapProblems, loadSitemaps } from "./sitemap.js";
import type {
  CrawlStats,
  Finding,
  LinkInfo,
  RobotsTxtInfo,
  SitemapInfo,
} from "./types.js";
import {
  hostOf,
  isSameSite,
  looksLikeHtml,
  normalizeUrl,
  stripWww,
} from "./url.js";

export interface ProgressEvent {
  phase:
    | "robots"
    | "sitemap"
    | "crawl"
    | "links"
    | "probes"
    | "rules"
    | "render"
    | "lighthouse"
    | "field-data"
    | "llms-txt"
    | "ai-bots"
    | "compare";
  message: string;
  crawled?: number;
  discovered?: number;
  url?: string;
}

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  delayMs: number;
  respectRobots: boolean;
  includeSubdomains: boolean;
  checkExternalLinks: boolean;
  maxLinkChecks: number;
  includePatterns: RegExp[];
  excludePatterns: RegExp[];
  fetch: FetchOptions;
  onProgress?: (event: ProgressEvent) => void;
  /** Fetch sitemaps and probe soft 404s and host redirects (default true); the AEO audit needs neither. */
  siteChecks?: boolean;
  /** Sitemap files to read at most, sitemap indexes included (default 25). */
  maxSitemaps?: number;
  /** The most of one sitemap to read, uncompressed (default 15 MB). */
  maxSitemapBytes?: number;
}

export interface CrawlResult {
  startUrl: string;
  records: PageRecord[];
  linkChecks: Map<string, LinkCheck>;
  linkSources: Map<string, Set<string>>;
  externalChecks?: Map<string, LinkCheck>;
  externalSources?: Map<string, Set<string>>;
  robots: RobotsTxtInfo | null;
  /** The robots.txt text up to 500 KiB (`robots.text` stops at 20,000 characters), for checks per user agent. */
  robotsText?: string | null;
  robotsAllows: ((url: string) => boolean) | null;
  blockedByRobots: string[];
  sitemaps: SitemapInfo;
  probes: ProbeResults;
  stats: CrawlStats;
  unlinkedPages?: string[];
  imageChecks?: Map<string, LinkCheck>;
  imageSources?: Map<string, Set<string>>;
  /** The requests the gate refused (the hosted server's), for the requests that follow the crawl. */
  refusals?: Refusals;
  /** The refusal that ended the requests to the site before the crawl was done. */
  stopped?: RequestRefusedError;
  /** Pages the audit failed on, and so left out of the crawl (issue #85). */
  failedPages?: FailedPage[];
}

/** A page the crawl left out because the audit threw on it: a bug of the tool's, not the site's. */
export interface FailedPage {
  url: string;
  /** The error's message, for the user's finding (never for error tracking, which cleans it). */
  error: string;
}

/**
 * The `tool.page-error` finding: the pages a crawl left out because the audit failed on them. It is
 * about the audit, not the site, so it names no fix; the site's other findings are complete.
 */
export const failedPageFindings = (
  failed: readonly FailedPage[] | undefined
): Finding[] => {
  const [first] = failed ?? [];

  if (!(failed && first)) {
    return [];
  }

  return [
    {
      rule: "tool.page-error",
      severity: "info",
      category: "tool",
      message: `The audit failed on ${failed.length} page(s), which are left out of the crawl. The first, ${first.url}, failed with: ${first.error}`,
      recommendation: `Report this as a bug at ${REPOSITORY_URL}/issues, with the page's URL if you can share it. The findings of the other pages are complete.`,
      fix: [],
      evidence: { count: failed.length, pages: cap([...failed]) },
    },
  ];
};

/** A crawl's `includePatterns` or `excludePatterns` entry that is no regular expression. */
export class InvalidPatternError extends ExpectedError {
  override name = "InvalidPatternError";
}

/**
 * The crawl's include or exclude patterns, compiled. A pattern that is no regular expression is
 * the caller's mistake, said before any request goes out, and no bug (issue #85).
 */
export const userPatterns = (
  patterns: readonly string[] | undefined,
  which: "include" | "exclude"
): RegExp[] =>
  (patterns ?? []).map((pattern) => {
    try {
      // oxlint-disable-next-line eslint/require-unicode-regexp -- the user's own patterns, in JavaScript's default syntax; the u flag would reject some of them
      return new RegExp(pattern);
    } catch (error) {
      throw new InvalidPatternError(
        `The ${which} pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

/** Image URLs a crawl requests at most, the ones shown on most pages first. */
const MAX_IMAGE_CHECKS = 100;

interface QueueItem {
  url: string;
  depth: number;
}

/**
 * The crawled pages in the order a one-at-a-time breadth-first crawl reaches them: from the start
 * page, through each page's links in the order the page lists them. Worked out from the recorded
 * links after the crawl, so it does not depend on which parallel request finished first. Pages no
 * link reached (a redirect target already crawled under another URL) follow, by URL.
 */
const inCrawlOrder = (
  records: PageRecord[],
  startUrl: string
): PageRecord[] => {
  const byUrl = new Map<string, PageRecord>();

  for (const r of records) {
    byUrl.set(r.requestedUrl, r);
    byUrl.set(r.url, r);
  }

  const start = byUrl.get(startUrl) ?? records.find((r) => r.depth === 0);
  const ordered: PageRecord[] = start ? [start] : [];
  const placed = new Set(ordered);

  // `ordered` grows while it is read, and for...of reads what is pushed: the breadth-first queue.
  for (const record of ordered) {
    for (const link of record.page.links) {
      const target = link.url ? normalizeUrl(link.url) : null;
      const linked = target ? byUrl.get(target) : undefined;

      if (linked && !placed.has(linked)) {
        placed.add(linked);
        ordered.push(linked);
      }
    }
  }

  const rest = records
    .filter((r) => !placed.has(r))
    .toSorted((a, b) => a.url.localeCompare(b.url));

  return [...ordered, ...rest];
};

/**
 * Works through a queue that grows while it runs: each crawled page can add the links it found.
 * At most `concurrency` items run at once, and with `delayMs` each slot waits that long after its
 * item before it takes the next one. An item that throws is left out and given to `failed`; the
 * rest go on.
 */
const runQueue = async (
  queue: QueueItem[],
  concurrency: number,
  delayMs: number,
  work: (item: QueueItem) => Promise<void>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until `failed` reads it
  failed: (item: QueueItem, error: unknown) => void
): Promise<void> => {
  const limit = Math.max(1, concurrency);
  const running = new Set<Promise<void>>();

  const launch = (item: QueueItem): void => {
    const task = (async () => {
      try {
        await work(item);
      } catch (error) {
        // The page is left out of the crawl; the rest of the queue goes on.
        failed(item, error);
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    })().finally(() => running.delete(task));

    running.add(task);
  };

  for (;;) {
    while (running.size < limit) {
      const item = queue.shift();

      if (!item) {
        break;
      }

      launch(item);
    }

    if (running.size === 0) {
      return;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- the queue grows as pages finish, so what to start next is only known once a slot frees
    await Promise.race(running);
  }
};

/** Adds `source` to the set of pages that link to `target`. */
const addSource = (
  sources: Map<string, Set<string>>,
  target: string,
  source: string
): void => {
  let set = sources.get(target);

  if (!set) {
    set = new Set();
    sources.set(target, set);
  }

  set.add(source);
};

/**
 * The soft-404, http and host variant probes, each only where robots.txt lets the crawl request
 * it. The http and www probes ask for `/` under another scheme or host, which should redirect to
 * this one, so this origin's robots.txt decides for them. Probes that failed or were refused say
 * nothing, so they are left out (null); those robots.txt kept out are not run.
 */
const runProbes = async (
  options: ProbeOptions,
  refusals: Refusals
): Promise<ProbeResults> => {
  const probes: ProbeResults = {};
  const { startUrl, fetch: fetchOpts, allows } = options;
  const url = new URL(startUrl);

  const probe = (target: string, fetchOptions: FetchOptions) =>
    refusals.run(target, () => probeUrl(target, fetchOptions));

  const soft404Url = new URL(
    `/agentic-seo-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    url.origin
  ).href;

  if (allows(soft404Url)) {
    const soft = await probe(soft404Url, fetchOpts);

    probes.soft404 =
      !soft || soft.error ? null : { url: soft404Url, status: soft.status };
  }

  if (isLocalHost(startUrl) || !allows(new URL("/", url.origin).href)) {
    return probes;
  }

  if (url.protocol === "https:") {
    const httpUrl = `http://${url.host}/`;
    const res = await probe(httpUrl, { ...fetchOpts, timeoutMs: 10_000 });
    probes.httpRedirect =
      !res || res.error
        ? null
        : {
            url: httpUrl,
            status: res.status,
            finalUrl: res.finalUrl,
            redirectsToHttps: res.finalUrl.startsWith("https://"),
          };
  }

  const host = url.hostname;
  const variantHost = host.startsWith("www.") ? stripWww(host) : `www.${host}`;
  const variantUrl = `${url.protocol}//${variantHost}/`;
  const res = await probe(variantUrl, { ...fetchOpts, timeoutMs: 10_000 });
  probes.hostVariant =
    !res || res.error
      ? null
      : {
          url: variantUrl,
          status: res.status,
          finalUrl: res.finalUrl,
          redirectsToMain: (hostOf(res.finalUrl) ?? "") === host,
        };

  return probes;
};

/** The sitemaps robots.txt names, and /sitemap.xml; none for a crawl without site checks. */
// oxlint-disable-next-line eslint/require-await -- the crawl awaits the sitemaps either way
const crawlSitemaps = async (
  robots: RobotsResult,
  startUrl: string,
  options: CrawlOptions,
  refusals: Refusals
): Promise<SitemapInfo> => {
  if (!(options.siteChecks ?? true)) {
    return {
      sources: [],
      urls: [],
      urlCount: 0,
      errors: [],
      problems: emptySitemapProblems(),
    };
  }

  const { origin } = new URL(startUrl);
  options.onProgress?.({ phase: "sitemap", message: "Fetching sitemaps" });

  const candidates = [
    ...new Set([...robots.info.sitemaps, new URL("/sitemap.xml", origin).href]),
  ];

  return loadSitemaps(candidates, options.fetch, {
    siteHost: hostOf(startUrl) ?? "",
    includeSubdomains: options.includeSubdomains,
    maxSitemaps: options.maxSitemaps,
    maxBytes: options.maxSitemapBytes,
    refusals,
  });
};

interface SiteChecks {
  images?: ImageCheckResult;
  probes: ProbeResults;
  /** The refusal that ended the requests to the site before the crawl was done. */
  stopped?: RequestRefusedError;
}

/**
 * The checks after the pages and their links: the images, then the soft-404, host redirect and URL
 * variant probes, for a crawl with site checks. The probes ask how the server answers URLs nobody
 * links to, not for the site's pages and links, so a refusal they meet does not make the crawl one
 * that stopped early: that is decided before them.
 */
const checkSite = async (
  records: PageRecord[],
  crawl: CrawlOptions,
  options: ProbeOptions,
  refusals: Refusals
): Promise<SiteChecks> => {
  const startHost = hostOf(options.startUrl) ?? "";

  const isSite = (host: string) =>
    isSameSite(`https://${host}/`, startHost, options.includeSubdomains);

  // The crawl still answers, so the gate hears from it which refusal stopped it (issue #94).
  const stoppedEarly = (): RequestRefusedError | undefined => {
    const refusal = refusals.stopped(isSite);

    if (refusal) {
      options.fetch.gate?.crawlStopped?.(refusal);
    }

    return refusal;
  };

  if (!(crawl.siteChecks ?? true)) {
    return { probes: {}, stopped: stoppedEarly() };
  }

  crawl.onProgress?.({ phase: "links", message: "Checking images" });

  const images = await checkImages(
    records,
    Math.min(MAX_IMAGE_CHECKS, crawl.maxLinkChecks),
    options
  );

  const stopped = stoppedEarly();

  crawl.onProgress?.({
    phase: "probes",
    message: "Probing soft-404, host redirects and URL variants",
  });

  const probes = await runProbes(options, refusals);
  probes.urlVariants = await probeUrlVariants(
    records,
    options.startUrl,
    options
  );

  return { images, probes, stopped };
};

/** Requests external link targets (checkExternalLinks); one the gate refused is left unchecked. */
const checkExternalTargets = async (
  targets: string[],
  options: CrawlOptions,
  refusals: Refusals
): Promise<Map<string, LinkCheck>> => {
  const checks = new Map<string, LinkCheck>();

  const fetchOptions: FetchOptions = {
    ...options.fetch,
    timeoutMs: Math.min(options.fetch.timeoutMs ?? 15_000, 10_000),
  };

  await mapConcurrent(targets, Math.min(options.concurrency, 4), async (u) => {
    const res = await refusals.run(u, () => probeUrl(u, fetchOptions));

    if (res) {
      checks.set(u, {
        url: u,
        status: res.status,
        finalUrl: res.finalUrl,
        redirectChain: res.redirectChain,
        error: res.error,
      });
    }
  });

  return checks;
};

/**
 * What the crawl may request: robots.txt's group for its product token when it obeys robots.txt,
 * or everything. Throws when that group keeps it from the start URL while the rules the site rules
 * judge by allow it: the site asks this crawler to stay out, which is not a finding about the site.
 */
const crawlPolicy = (
  robots: RobotsResult,
  startUrl: string,
  options: { respectRobots: boolean; userAgent: string; gated: boolean }
): ((url: string) => boolean) => {
  if (!options.respectRobots) {
    return () => true;
  }

  if (!robots.crawlerAllows(startUrl) && robots.allows(startUrl)) {
    const token = robotsUserAgentToken(options.userAgent);
    const reason = `${robots.info.url} asks ${token} not to crawl ${startUrl} (in a User-agent: ${token} group), so there is nothing to crawl.`;

    // A gate (the hosted server's) obeys robots.txt for every request, with no way to turn that
    // off: it gives the site's reason and nothing more.
    throw new ExpectedError(
      options.gated
        ? reason
        : `${reason} Audit single pages instead; for a site of your own, crawl without obeying robots.txt (respectRobots: false with the local server, --ignore-robots with the CLI).`
    );
  }

  return robots.crawlerAllows;
};

/** Same-site URLs the crawled pages name as canonical or as hreflang alternates, normalized. */
const metadataTargets = (
  records: PageRecord[],
  startHost: string,
  includeSubdomains: boolean
): string[] => {
  const out = new Set<string>();

  for (const r of records) {
    for (const url of [
      r.page.canonical,
      ...r.page.hreflang.map((h) => h.url),
    ]) {
      const target = url ? normalizeUrl(url) : null;

      if (target && isSameSite(target, startHost, includeSubdomains)) {
        out.add(target);
      }
    }
  }

  return [...out];
};

/** The progress callback of a caller that does not listen for progress. */
const ignoreProgress = (): void => {
  // Nobody to tell.
};

export const crawlSite = async (
  startInput: string,
  input: CrawlOptions
): Promise<CrawlResult> => {
  const refusals = trackRefusals();

  // Every request also goes past the refusals, so a redirect to a host that refused the crawl is
  // not sent again.
  // The user's headers are for the origin the crawl starts at, whatever its pages link to.
  const options: CrawlOptions = {
    ...input,
    fetch: refusals.guard(
      forAuditOf(input.fetch, normalizeUrl(startInput) ?? startInput)
    ),
  };

  const started = performance.now();
  const progress = options.onProgress ?? ignoreProgress;
  const startUrl = normalizeUrl(startInput) ?? startInput;
  const { origin } = new URL(startUrl);
  const startHost = hostOf(startUrl) ?? "";
  const userAgent = options.fetch.userAgent ?? DEFAULT_USER_AGENT;

  progress({ phase: "robots", message: `Fetching ${origin}/robots.txt` });
  // Without robots.txt the crawl cannot tell what it may request, so a refusal here ends it.
  const robots = await loadRobotsTxt(origin, userAgent, options.fetch);

  const fetchable = crawlPolicy(robots, startUrl, {
    respectRobots: options.respectRobots,
    userAgent,
    gated: options.fetch.gate !== undefined,
  });

  /**
   * Whether robots.txt keeps the crawl from `url` and the site rules report it: only when the
   * rules they judge by block it too, not when the site keeps out this tool alone.
   */
  const isBlocked = (url: string): boolean =>
    !fetchable(url) && !robots.allows(url);

  const sitemaps = await crawlSitemaps(robots, startUrl, options, refusals);

  const visited = new Set<string>([startUrl]);
  const discovered = new Set<string>([startUrl]);
  const linkChecks = new Map<string, LinkCheck>();
  const linkSources = new Map<string, Set<string>>();
  const externalSources = new Map<string, Set<string>>();
  const records: PageRecord[] = [];
  /** Final URLs with a record. A redirect and a link can lead to the same page at once. */
  const recorded = new Set<string>();
  const blocked: string[] = [];
  let limitSkips = 0;

  const accepts = (url: string): boolean => {
    if (
      options.includePatterns.length &&
      !options.includePatterns.some((re) => re.test(url))
    ) {
      return false;
    }

    if (options.excludePatterns.some((re) => re.test(url))) {
      return false;
    }

    return true;
  };

  const queue: QueueItem[] = [{ url: startUrl, depth: 0 }];

  /** Queues the internal links a crawled page has, and remembers every link's sources. */
  const followLinks = (
    links: LinkInfo[],
    from: string,
    depth: number
  ): void => {
    for (const link of links) {
      const target = link.url ? normalizeUrl(link.url) : null;

      if (!target) {
        continue;
      }

      if (!link.internal) {
        addSource(externalSources, target, from);
        continue;
      }

      addSource(linkSources, target, from);

      if (
        !looksLikeHtml(target) ||
        !accepts(target) ||
        discovered.has(target)
      ) {
        continue;
      }

      discovered.add(target);

      if (depth + 1 > options.maxDepth) {
        continue;
      }

      if (visited.size >= options.maxPages) {
        limitSkips += 1;
        continue;
      }

      visited.add(target);
      queue.push({ url: target, depth: depth + 1 });
    }
  };

  /**
   * Records where a redirected request ended. False when there is nothing more to crawl there:
   * the redirect led to a page crawled already, or off the site.
   */
  const keepsRedirectTarget = (res: FetchResult, finalKey: string): boolean => {
    if (!linkChecks.has(finalKey)) {
      linkChecks.set(finalKey, {
        url: res.finalUrl,
        status: res.status,
        finalUrl: res.finalUrl,
        redirectChain: [],
        error: res.error,
      });
    }

    if (visited.has(finalKey) && records.some((r) => r.url === finalKey)) {
      return false;
    }

    visited.add(finalKey);

    return isSameSite(finalKey, startHost, options.includeSubdomains);
  };

  /** A response that is no HTML page: an asset is skipped, an error page may still be recorded. */
  const recordUnreadable = (
    item: QueueItem,
    res: FetchResult,
    finalKey: string
  ): void => {
    const isAsset =
      res.status !== null &&
      res.status < 400 &&
      !res.error &&
      res.body !== null &&
      !isHtmlResponse(res);

    // Record error pages so page-level findings (response.error-status) appear for the start URL.
    if (isAsset || (item.depth !== 0 && res.status !== null)) {
      return;
    }

    if (recorded.has(finalKey)) {
      return;
    }

    recorded.add(finalKey);

    const page = extractPage(res.body ?? "", {
      url: res.finalUrl,
      siteHost: startHost,
      includeSubdomains: options.includeSubdomains,
    });

    const record: PageRecord = {
      url: finalKey,
      requestedUrl: item.url,
      page,
      response: toResponseInfo(res),
      depth: item.depth,
    };

    records.push(record);
  };

  const processItem = async (item: QueueItem): Promise<void> => {
    if (!fetchable(item.url)) {
      if (isBlocked(item.url)) {
        blocked.push(item.url);
      }

      return;
    }

    const res = await refusals.run(item.url, () =>
      fetchPage(item.url, options.fetch)
    );

    // A page the gate refused was not requested: it is neither crawled nor broken.
    if (!res) {
      return;
    }

    const requestedKey = item.url;
    const finalKey = normalizeUrl(res.finalUrl) ?? res.finalUrl;

    linkChecks.set(requestedKey, {
      url: item.url,
      status: res.status,
      finalUrl: res.finalUrl,
      redirectChain: res.redirectChain,
      error: res.error,
    });

    if (finalKey !== requestedKey && !keepsRedirectTarget(res, finalKey)) {
      return;
    }

    progress({
      phase: "crawl",
      message: `${res.status ?? "ERR"} ${res.finalUrl}`,
      crawled: records.length + 1,
      discovered: discovered.size,
      url: res.finalUrl,
    });

    if (res.error || res.body === null || !isHtmlResponse(res)) {
      recordUnreadable(item, res, finalKey);

      return;
    }

    // Nothing awaits between the fetch ending and this check, so two requests that end at the
    // same page cannot both pass it.
    if (recorded.has(finalKey)) {
      return;
    }

    recorded.add(finalKey);

    const page = extractPage(res.body, {
      url: res.finalUrl,
      siteHost: startHost,
      includeSubdomains: options.includeSubdomains,
    });

    const record: PageRecord = {
      url: finalKey,
      requestedUrl: item.url,
      page,
      response: toResponseInfo(res),
      depth: item.depth,
    };

    records.push(record);

    followLinks(page.links, finalKey, item.depth);
  };

  // A network failure is a result and a refusal is handled in `processItem`, so what throws here
  // is a bug of the audit's: the user is told which pages it left out, and error tracking hears it.
  const failedPages: FailedPage[] = [];

  await runQueue(
    queue,
    options.concurrency,
    options.delayMs,
    processItem,
    (item, error) => {
      caughtError(error);
      failedPages.push({
        url: item.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );

  // With the start page refused there is no site to audit: the refusal says why.
  const startRefusal = refusals.of(startUrl);

  if (records.length === 0 && startRefusal) {
    throw startRefusal;
  }

  // Site rules that keep the first of a group (the page a spelling variant duplicates, the page
  // a duplicate's canonical should name) then pick the same page on every run.
  // One at a time: spreading 100,000 records into splice() overflows the stack.
  for (const [i, record] of inCrawlOrder(records, startUrl).entries()) {
    records[i] = record;
  }

  /* Check internal link targets that were discovered but not crawled (limits, depth, non-HTML). */
  progress({ phase: "links", message: "Checking internal link targets" });

  const toCheck = [...linkSources.keys()]
    .filter((u) => !linkChecks.has(u) && fetchable(u))
    .slice(0, options.maxLinkChecks);

  const sitemapExtra = sitemaps.urls
    .map((u) => normalizeUrl(u) ?? u)
    .filter(
      (u) =>
        isSameSite(u, startHost, options.includeSubdomains) &&
        !linkChecks.has(u) &&
        !toCheck.includes(u) &&
        fetchable(u)
    )
    .slice(0, Math.max(0, options.maxLinkChecks - toCheck.length));

  // Canonical and hreflang targets no link led to: the site rules check where they point.
  const metadataExtra = metadataTargets(
    records,
    startHost,
    options.includeSubdomains
  )
    .filter(
      (u) =>
        !linkChecks.has(u) &&
        !toCheck.includes(u) &&
        !sitemapExtra.includes(u) &&
        fetchable(u)
    )
    .slice(
      0,
      Math.max(0, options.maxLinkChecks - toCheck.length - sitemapExtra.length)
    );

  for (const target of [...linkSources.keys()].filter(isBlocked)) {
    if (!blocked.includes(target)) {
      blocked.push(target);
    }
  }

  await mapConcurrent(
    [...toCheck, ...sitemapExtra, ...metadataExtra],
    options.concurrency,
    async (u) => {
      const res = await refusals.run(u, () => probeUrl(u, options.fetch));

      // A link the gate refused is left unchecked, never broken.
      if (!res) {
        return;
      }

      linkChecks.set(u, {
        url: u,
        status: res.status,
        finalUrl: res.finalUrl,
        redirectChain: res.redirectChain,
        error: res.error,
      });

      if (options.delayMs) {
        await sleep(options.delayMs);
      }
    }
  );

  let externalChecks: Map<string, LinkCheck> | undefined;

  if (options.checkExternalLinks) {
    progress({
      phase: "links",
      message: `Checking ${Math.min(externalSources.size, options.maxLinkChecks)} external links`,
    });
    externalChecks = await checkExternalTargets(
      [...externalSources.keys()].slice(0, options.maxLinkChecks),
      options,
      refusals
    );
  }

  const probeOptions: ProbeOptions = {
    fetch: options.fetch,
    concurrency: options.concurrency,
    delayMs: options.delayMs,
    allows: fetchable,
    startUrl,
    includeSubdomains: options.includeSubdomains,
    checkExternal: options.checkExternalLinks,
    refusals,
  };

  const { images, probes, stopped } = await checkSite(
    records,
    options,
    probeOptions,
    refusals
  );

  const stats: CrawlStats = {
    pagesCrawled: records.length,
    pagesDiscovered: discovered.size,
    linksChecked: linkChecks.size + (externalChecks?.size ?? 0),
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
    hitPageLimit: limitSkips > 0,
    durationMs: Math.round(performance.now() - started),
    respectedRobots: options.respectRobots,
  };

  return {
    startUrl,
    records,
    linkChecks,
    linkSources,
    externalChecks,
    externalSources: options.checkExternalLinks ? externalSources : undefined,
    robots: robots.info,
    robotsText: robots.text,
    robotsAllows: robots.info.found ? robots.allows : null,
    blockedByRobots: blocked,
    sitemaps,
    probes,
    stats,
    imageChecks: images?.imageChecks,
    imageSources: images?.imageSources,
    refusals,
    stopped,
    failedPages: failedPages.length > 0 ? failedPages : undefined,
  };
};
