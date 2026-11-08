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

export function parseSitemap(
  body: string,
  contentType: string | null = null
): ParsedSitemap {
  const trimmed = body.trim();

  if (!trimmed) {
    return { kind: "unknown", locs: [] };
  }

  if (!trimmed.startsWith("<")) {
    if (
      (contentType ?? "").includes("text/plain") ||
      /^https?:\/\//m.test(trimmed)
    ) {
      return {
        kind: "text",
        locs: trimmed
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^https?:\/\//i.test(l)),
      };
    }

    return { kind: "unknown", locs: [] };
  }

  let doc: Record<string, unknown>;

  try {
    doc = parser.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { kind: "unknown", locs: [] };
  }

  const index = doc["sitemapindex"] as Record<string, unknown> | undefined;

  if (index) {
    return { kind: "sitemapindex", locs: locsOf(index["sitemap"]) };
  }

  const urlset = doc["urlset"] as Record<string, unknown> | undefined;

  if (urlset) {
    return { kind: "urlset", locs: locsOf(urlset["url"]) };
  }

  return { kind: "unknown", locs: [] };
}

function locsOf(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const out: string[] = [];

  for (const e of entries) {
    const loc =
      e && typeof e === "object"
        ? (e as Record<string, unknown>)["loc"]
        : undefined;

    if (typeof loc === "string" && loc.trim()) {
      out.push(loc.trim());
    } else if (typeof loc === "number") {
      out.push(String(loc));
    }
  }

  return out;
}

/** Fetch sitemap candidates (following sitemap indexes) and collect page URLs. */
export async function loadSitemaps(
  candidates: string[],
  options: FetchOptions = {},
  limits: SitemapLimits = {}
): Promise<SitemapInfo> {
  const maxSitemaps = limits.maxSitemaps ?? 25;
  const maxUrls = limits.maxUrls ?? 5000;
  const info: SitemapInfo = { sources: [], urls: [], urlCount: 0, errors: [] };
  const queue = [...new Set(candidates)];
  const seen = new Set<string>();
  const urls = new Set<string>();

  while (
    queue.length &&
    info.sources.length < maxSitemaps &&
    urls.size < maxUrls
  ) {
    const url = queue.shift()!;

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);

    if (url.endsWith(".gz")) {
      info.errors.push(`${url}: gzip sitemaps are not supported yet`);
      continue;
    }

    const res = await fetchPage(url, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? 15_000, 20_000),
      maxBodyBytes: 15_000_000,
    });

    if (res.error) {
      info.errors.push(`${url}: ${res.error}`);
      continue;
    }

    if (res.status !== 200 || typeof res.body !== "string") {
      // A missing default /sitemap.xml is not an error; a declared one is.
      if (
        res.status !== 404 ||
        candidates.indexOf(url) === -1 ||
        candidates.length > 1
      ) {
        if (res.status !== 404) {
          info.errors.push(`${url}: HTTP ${res.status}`);
        }
      }

      continue;
    }

    const parsed = parseSitemap(res.body, res.contentType);

    if (parsed.kind === "unknown") {
      if (/<html/i.test(res.body.slice(0, 1000))) {
        if (
          res.status === 200 &&
          candidates.includes(url) &&
          candidates.length === 1
        ) {
          continue;
        } // SPA fallback page for /sitemap.xml

        info.errors.push(`${url}: returned an HTML page, not XML`);
      } else {
        info.errors.push(`${url}: could not parse as a sitemap`);
      }

      continue;
    }

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
}
