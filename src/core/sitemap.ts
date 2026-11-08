import { XMLParser } from "fast-xml-parser";

import { fetchPage } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import type { SitemapInfo } from "./types.js";

export interface SitemapLimits {
  maxSitemaps?: number;
  maxUrls?: number;
}

export interface ParsedSitemap {
  kind: "urlset" | "sitemapindex" | "text" | "unknown";
  locs: string[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === "url" || name === "sitemap",
});

/**
 * The parts of fast-xml-parser's output that a sitemap is read for. The parser checks no schema,
 * so every value is unknown until the guards below look at it.
 */
interface SitemapXml {
  sitemapindex?: { sitemap?: unknown };
  urlset?: { url?: unknown };
}

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

const isEntry = (value: unknown): value is { loc?: unknown } =>
  Boolean(value) && typeof value === "object";

const locsOf = (entries: unknown[]): string[] => {
  const out: string[] = [];

  for (const e of entries) {
    const loc = isEntry(e) ? e.loc : undefined;

    if (isString(loc) && loc.trim()) {
      out.push(loc.trim());
    } else if (isNumber(loc)) {
      out.push(String(loc));
    }
  }

  return out;
};

export const parseSitemap = (
  body: string,
  contentType: string | null = null
): ParsedSitemap => {
  const trimmed = body.trim();

  if (!trimmed) {
    return { kind: "unknown", locs: [] };
  }

  if (!trimmed.startsWith("<")) {
    if (
      (contentType ?? "").includes("text/plain") ||
      /^https?:\/\//mu.test(trimmed)
    ) {
      return {
        kind: "text",
        locs: trimmed
          .split(/\r?\n/u)
          .map((l) => l.trim())
          .filter((l) => /^https?:\/\//iu.test(l)),
      };
    }

    return { kind: "unknown", locs: [] };
  }

  let doc: SitemapXml;

  try {
    doc = parser.parse(trimmed);
  } catch {
    return { kind: "unknown", locs: [] };
  }

  if (doc.sitemapindex) {
    const entries = doc.sitemapindex.sitemap;

    return {
      kind: "sitemapindex",
      locs: Array.isArray(entries) ? locsOf(entries) : [],
    };
  }

  if (doc.urlset) {
    const entries = doc.urlset.url;

    return {
      kind: "urlset",
      locs: Array.isArray(entries) ? locsOf(entries) : [],
    };
  }

  return { kind: "unknown", locs: [] };
};

/** What fetching one sitemap gave: one to read, an error to report, or nothing to say. */
type SitemapFetch =
  | { kind: "parsed"; parsed: ParsedSitemap }
  | { kind: "error"; message: string }
  | { kind: "skip" };

const fetchSitemap = async (
  url: string,
  candidates: string[],
  options: FetchOptions
): Promise<SitemapFetch> => {
  if (url.endsWith(".gz")) {
    return {
      kind: "error",
      message: `${url}: gzip sitemaps are not supported yet`,
    };
  }

  const res = await fetchPage(url, {
    ...options,
    timeoutMs: Math.min(options.timeoutMs ?? 15_000, 20_000),
    maxBodyBytes: 15_000_000,
  });

  if (res.error) {
    return { kind: "error", message: `${url}: ${res.error}` };
  }

  if (res.status !== 200 || res.body === null) {
    // A sitemap that answers 404 is passed over without an error.
    if (res.status !== 404) {
      return { kind: "error", message: `${url}: HTTP ${res.status}` };
    }

    return { kind: "skip" };
  }

  const parsed = parseSitemap(res.body, res.contentType);

  if (parsed.kind !== "unknown") {
    return { kind: "parsed", parsed };
  }

  if (!/<html/iu.test(res.body.slice(0, 1000))) {
    return { kind: "error", message: `${url}: could not parse as a sitemap` };
  }

  // The one guessed /sitemap.xml answered with an SPA's fallback page: there is no sitemap.
  if (candidates.includes(url) && candidates.length === 1) {
    return { kind: "skip" };
  }

  return { kind: "error", message: `${url}: returned an HTML page, not XML` };
};

/** Fetch sitemap candidates (following sitemap indexes) and collect page URLs. */
export const loadSitemaps = async (
  candidates: string[],
  options: FetchOptions = {},
  limits: SitemapLimits = {}
): Promise<SitemapInfo> => {
  const maxSitemaps = limits.maxSitemaps ?? 25;
  const maxUrls = limits.maxUrls ?? 5000;
  const info: SitemapInfo = { sources: [], urls: [], urlCount: 0, errors: [] };
  const queue = [...new Set(candidates)];
  const seen = new Set<string>();
  const urls = new Set<string>();

  while (
    queue.length > 0 &&
    info.sources.length < maxSitemaps &&
    urls.size < maxUrls
  ) {
    const url = queue.shift();

    if (url === undefined || seen.has(url)) {
      continue;
    }

    seen.add(url);

    // oxlint-disable-next-line eslint/no-await-in-loop -- a sitemap index adds the sitemaps to fetch next, and the limits count what the earlier ones gave
    const fetched = await fetchSitemap(url, candidates, options);

    if (fetched.kind === "error") {
      info.errors.push(fetched.message);
    }

    if (fetched.kind !== "parsed") {
      continue;
    }

    const { parsed } = fetched;
    info.sources.push(url);

    if (parsed.kind === "sitemapindex") {
      queue.push(...parsed.locs);
    } else {
      for (const loc of parsed.locs) {
        if (urls.size < maxUrls) {
          urls.add(loc);
        }
      }
    }
  }

  info.urls = [...urls];
  info.urlCount = urls.size;

  return info;
};
