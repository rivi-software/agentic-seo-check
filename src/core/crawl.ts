import { mapConcurrent, sleep } from "./concurrency.js";
import {
  DEFAULT_USER_AGENT,
  fetchPage,
  isHtmlResponse,
  probeUrl,
  toResponseInfo,
} from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import { extractPage } from "./html/extract.js";
import { loadRobotsTxt } from "./robots.js";
import { isLocalHost } from "./rules/canonical.js";
import type { LinkCheck, PageRecord, ProbeResults } from "./site-rules.js";
import { loadSitemaps } from "./sitemap.js";
import type { CrawlStats, RobotsTxtInfo, SitemapInfo } from "./types.js";
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

export async function crawlSite(
  startInput: string,
  options: CrawlOptions
): Promise<CrawlResult> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => undefined);
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

    if (finalKey !== requestedKey) {
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
        return;
      }

      visited.add(finalKey);

      if (!isSameSite(finalKey, startHost, options.includeSubdomains)) {
        return;
      } // redirected off-site
    }

    progress({
      phase: "crawl",
      message: `${res.status ?? "ERR"} ${res.finalUrl}`,
      crawled: records.length + 1,
      discovered: discovered.size,
      url: res.finalUrl,
    });

    if (res.error || typeof res.body !== "string" || !isHtmlResponse(res)) {
      if (
        res.status !== null &&
        res.status < 400 &&
        !res.error &&
        typeof res.body === "string" &&
        !isHtmlResponse(res)
      ) {
        return;
      } // non-HTML asset

      // Record error pages so page-level findings (response.error-status) appear for the start URL.
      if (item.depth === 0 || res.status === null) {
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
      }

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

    for (const link of page.links) {
      if (!link.url) {
        continue;
      }

      const target = normalizeUrl(link.url);

      if (!target) {
        continue;
      }

      if (!link.internal) {
        if (!externalSources.has(target)) {
          externalSources.set(target, new Set());
        }

        externalSources.get(target)!.add(finalKey);
        continue;
      }

      if (!linkSources.has(target)) {
        linkSources.set(target, new Set());
      }

      linkSources.get(target)!.add(finalKey);

      if (!looksLikeHtml(target) || !accepts(target)) {
        continue;
      }

      if (discovered.has(target)) {
        continue;
      }

      discovered.add(target);

      if (item.depth + 1 > options.maxDepth) {
        continue;
      }

      if (visited.size >= options.maxPages) {
        limitSkips++;
        continue;
      }

      visited.add(target);
      queue.push({ url: target, depth: item.depth + 1 });
    }
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

  for (const u of [...linkSources.keys()].filter((u) => !allows(u))) {
    if (!blocked.includes(u)) {
      blocked.push(u);
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
    externalChecks = new Map();
    const targets = [...externalSources.keys()].slice(0, options.maxLinkChecks);
    await mapConcurrent(
      targets,
      Math.min(options.concurrency, 4),
      async (u) => {
        const res = await probeUrl(u, {
          ...options.fetch,
          timeoutMs: Math.min(options.fetch.timeoutMs ?? 15_000, 10_000),
        });

        externalChecks!.set(u, {
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
}

async function runQueue(
  queue: QueueItem[],
  concurrency: number,
  delayMs: number,
  work: (item: QueueItem) => Promise<void>
): Promise<void> {
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (active < Math.max(1, concurrency) && queue.length) {
        const item = queue.shift()!;
        active++;
        work(item)
          .catch(() => undefined)
          .finally(() => {
            active--;

            if (delayMs > 0) {
              setTimeout(pump, delayMs);
            } else {
              pump();
            }
          });
      }

      if (active === 0 && queue.length === 0) {
        resolve();
      }
    };

    pump();
  });
}

async function runProbes(
  startUrl: string,
  fetchOpts: FetchOptions
): Promise<ProbeResults> {
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
}
