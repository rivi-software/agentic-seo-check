import { mapConcurrent, sleep } from "./concurrency.js";
import {
  DEFAULT_USER_AGENT,
  fetchPage,
  isHtmlResponse,
  probeUrl,
  toResponseInfo,
} from "./fetch.js";
import type { FetchOptions, FetchResult } from "./fetch.js";
import { extractPage } from "./html/extract.js";
import { loadRobotsTxt } from "./robots.js";
import { isLocalHost } from "./rules/canonical.js";
import type { LinkCheck, PageRecord, ProbeResults } from "./site-rules.js";
import { loadSitemaps } from "./sitemap.js";
import type {
  CrawlStats,
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
    | "lighthouse";
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
}

export interface CrawlResult {
  startUrl: string;
  records: PageRecord[];
  linkChecks: Map<string, LinkCheck>;
  linkSources: Map<string, Set<string>>;
  externalChecks?: Map<string, LinkCheck>;
  externalSources?: Map<string, Set<string>>;
  robots: RobotsTxtInfo | null;
  robotsAllows: ((url: string) => boolean) | null;
  blockedByRobots: string[];
  sitemaps: SitemapInfo;
  probes: ProbeResults;
  stats: CrawlStats;
  unlinkedPages?: string[];
}

interface QueueItem {
  url: string;
  depth: number;
}

/**
 * Works through a queue that grows while it runs: each crawled page can add the links it found.
 * At most `concurrency` items run at once, and with `delayMs` each slot waits that long after its
 * item before it takes the next one. An item that throws is left out; the rest go on.
 */
const runQueue = async (
  queue: QueueItem[],
  concurrency: number,
  delayMs: number,
  work: (item: QueueItem) => Promise<void>
): Promise<void> => {
  const limit = Math.max(1, concurrency);
  const running = new Set<Promise<void>>();

  const launch = (item: QueueItem): void => {
    const task = (async () => {
      try {
        await work(item);
      } catch {
        // The page is left out of the crawl; the rest of the queue goes on.
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

const runProbes = async (
  startUrl: string,
  fetchOpts: FetchOptions
): Promise<ProbeResults> => {
  const probes: ProbeResults = {};
  const url = new URL(startUrl);

  const soft404Url = new URL(
    `/agentic-seo-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    url.origin
  ).href;

  const soft = await probeUrl(soft404Url, fetchOpts);
  probes.soft404 = soft.error ? null : { url: soft404Url, status: soft.status };

  if (isLocalHost(startUrl)) {
    return probes;
  }

  if (url.protocol === "https:") {
    const httpUrl = `http://${url.host}/`;
    const res = await probeUrl(httpUrl, { ...fetchOpts, timeoutMs: 10_000 });
    probes.httpRedirect = res.error
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
  const res = await probeUrl(variantUrl, { ...fetchOpts, timeoutMs: 10_000 });
  probes.hostVariant = res.error
    ? null
    : {
        url: variantUrl,
        status: res.status,
        finalUrl: res.finalUrl,
        redirectsToMain: (hostOf(res.finalUrl) ?? "") === host,
      };

  return probes;
};

/** The progress callback of a caller that does not listen for progress. */
const ignoreProgress = (): void => {
  // Nobody to tell.
};

export const crawlSite = async (
  startInput: string,
  options: CrawlOptions
): Promise<CrawlResult> => {
  const started = performance.now();
  const progress = options.onProgress ?? ignoreProgress;
  const startUrl = normalizeUrl(startInput) ?? startInput;
  const { origin } = new URL(startUrl);
  const startHost = hostOf(startUrl) ?? "";
  const userAgent = options.fetch.userAgent ?? DEFAULT_USER_AGENT;

  progress({ phase: "robots", message: `Fetching ${origin}/robots.txt` });
  const robots = await loadRobotsTxt(origin, userAgent, options.fetch);
  const allows = options.respectRobots ? robots.allows : () => true;

  progress({ phase: "sitemap", message: "Fetching sitemaps" });

  const sitemapCandidates = [
    ...new Set([...robots.info.sitemaps, new URL("/sitemap.xml", origin).href]),
  ];

  const sitemaps = await loadSitemaps(sitemapCandidates, options.fetch);

  const visited = new Set<string>([startUrl]);
  const discovered = new Set<string>([startUrl]);
  const linkChecks = new Map<string, LinkCheck>();
  const linkSources = new Map<string, Set<string>>();
  const externalSources = new Map<string, Set<string>>();
  const records: PageRecord[] = [];
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

    const page = extractPage(res.body ?? "", {
      url: res.finalUrl,
      siteHost: startHost,
      includeSubdomains: options.includeSubdomains,
    });

    records.push({
      url: finalKey,
      requestedUrl: item.url,
      page,
      response: toResponseInfo(res),
      depth: item.depth,
    });
  };

  const processItem = async (item: QueueItem): Promise<void> => {
    if (!allows(item.url)) {
      blocked.push(item.url);

      return;
    }

    const res = await fetchPage(item.url, options.fetch);
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

    const page = extractPage(res.body, {
      url: res.finalUrl,
      siteHost: startHost,
      includeSubdomains: options.includeSubdomains,
    });

    records.push({
      url: finalKey,
      requestedUrl: item.url,
      page,
      response: toResponseInfo(res),
      depth: item.depth,
    });

    followLinks(page.links, finalKey, item.depth);
  };

  await runQueue(queue, options.concurrency, options.delayMs, processItem);

  /* Check internal link targets that were discovered but not crawled (limits, depth, non-HTML). */
  progress({ phase: "links", message: "Checking internal link targets" });

  const toCheck = [...linkSources.keys()]
    .filter((u) => !linkChecks.has(u) && allows(u))
    .slice(0, options.maxLinkChecks);

  const sitemapExtra = sitemaps.urls
    .map((u) => normalizeUrl(u) ?? u)
    .filter(
      (u) =>
        isSameSite(u, startHost, options.includeSubdomains) &&
        !linkChecks.has(u) &&
        !toCheck.includes(u) &&
        allows(u)
    )
    .slice(0, Math.max(0, options.maxLinkChecks - toCheck.length));

  for (const target of [...linkSources.keys()].filter((u) => !allows(u))) {
    if (!blocked.includes(target)) {
      blocked.push(target);
    }
  }

  await mapConcurrent(
    [...toCheck, ...sitemapExtra],
    options.concurrency,
    async (u) => {
      const res = await probeUrl(u, options.fetch);
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
    const checks = new Map<string, LinkCheck>();
    externalChecks = checks;
    const targets = [...externalSources.keys()].slice(0, options.maxLinkChecks);
    await mapConcurrent(
      targets,
      Math.min(options.concurrency, 4),
      async (u) => {
        const res = await probeUrl(u, {
          ...options.fetch,
          timeoutMs: Math.min(options.fetch.timeoutMs ?? 15_000, 10_000),
        });

        checks.set(u, {
          url: u,
          status: res.status,
          finalUrl: res.finalUrl,
          redirectChain: res.redirectChain,
          error: res.error,
        });
      }
    );
  }

  progress({ phase: "probes", message: "Probing soft-404 and host redirects" });
  const probes = await runProbes(startUrl, options.fetch);

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
    robotsAllows: robots.info.found ? robots.allows : null,
    blockedByRobots: blocked,
    sitemaps,
    probes,
    stats,
  };
};
