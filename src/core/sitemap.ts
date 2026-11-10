import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { XMLParser } from "fast-xml-parser";

import { fetchPage } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import type { Refusals } from "./refusals.js";
import type { SitemapExamples, SitemapInfo, SitemapProblems } from "./types.js";
import { isSameSite } from "./url.js";

/** One sitemap file may hold this many URLs (sitemaps.org; Google applies the same limits). */
export const SITEMAP_MAX_URLS = 50_000;

/** And this many bytes, uncompressed. */
export const SITEMAP_MAX_BYTES = 52_428_800;

/** The most of one sitemap this audit reads, uncompressed; parsing more would cost too much memory. */
export const SITEMAP_READ_BYTES = 15_000_000;

/** A byte count in megabytes, as the findings write it ("15 MB"). */
export const megabytes = (bytes: number): string =>
  `${Number((bytes / 1_000_000).toFixed(1))} MB`;

export interface SitemapLimits {
  maxSitemaps?: number;
  maxUrls?: number;
  /** The most of one sitemap to read, uncompressed (default `SITEMAP_READ_BYTES`). */
  maxBytes?: number;
  /** The crawl's refusals: a sitemap the gate refuses is left unread, and not called missing. */
  refusals?: Refusals;
  /**
   * The audited site's host. A sitemap the site's robots.txt names may list its URLs from another
   * host (Google allows it), so URLs are compared with this host, not the sitemap's.
   */
  siteHost?: string;
  includeSubdomains?: boolean;
}

export interface ParsedSitemap {
  kind: "urlset" | "sitemapindex" | "text" | "unknown";
  locs: string[];
  /** The <lastmod> of each entry in `locs`, or null where it has none. */
  lastmods: (string | null)[];
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
  // An empty element (<urlset></urlset>) parses as "", which is still a sitemap, with no entries.
  sitemapindex?: { sitemap?: unknown } | "";
  urlset?: { url?: unknown } | "";
}

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

/** One <url> or <sitemap> element as the parser gives it: its children are unchecked. */
interface SitemapEntry {
  loc?: unknown;
  lastmod?: unknown;
}

const isEntry = (value: unknown): value is SitemapEntry =>
  Boolean(value) && typeof value === "object";

/** The text of one child element; the parser turns a number-like text into a number. */
const textOf = (
  entry: SitemapEntry,
  child: keyof SitemapEntry
): string | null => {
  const value = entry[child];

  if (isString(value) && value.trim()) {
    return value.trim();
  }

  return isNumber(value) ? String(value) : null;
};

const entriesOf = (
  entries: unknown[]
): Pick<ParsedSitemap, "locs" | "lastmods"> => {
  const locs: string[] = [];
  const lastmods: (string | null)[] = [];

  for (const e of entries) {
    const loc = isEntry(e) ? textOf(e, "loc") : null;

    if (loc) {
      locs.push(loc);
      lastmods.push(isEntry(e) ? textOf(e, "lastmod") : null);
    }
  }

  return { locs, lastmods };
};

export const parseSitemap = (
  body: string,
  contentType: string | null = null
): ParsedSitemap => {
  const trimmed = body.trim();

  if (!trimmed) {
    return { kind: "unknown", locs: [], lastmods: [] };
  }

  if (!trimmed.startsWith("<")) {
    if (
      (contentType ?? "").includes("text/plain") ||
      /^https?:\/\//mu.test(trimmed)
    ) {
      const locs = trimmed
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter((l) => /^https?:\/\//iu.test(l));

      return { kind: "text", locs, lastmods: locs.map(() => null) };
    }

    return { kind: "unknown", locs: [], lastmods: [] };
  }

  let doc: SitemapXml;

  try {
    doc = parser.parse(trimmed);
  } catch {
    return { kind: "unknown", locs: [], lastmods: [] };
  }

  if (doc.sitemapindex !== undefined) {
    const entries =
      doc.sitemapindex === "" ? undefined : doc.sitemapindex.sitemap;

    return {
      kind: "sitemapindex",
      ...entriesOf(Array.isArray(entries) ? entries : []),
    };
  }

  if (doc.urlset !== undefined) {
    const entries = doc.urlset === "" ? undefined : doc.urlset.url;

    return {
      kind: "urlset",
      ...entriesOf(Array.isArray(entries) ? entries : []),
    };
  }

  return { kind: "unknown", locs: [], lastmods: [] };
};

const gunzipAsync = promisify(gunzip);

/**
 * A sitemap file's text: gunzipped when it is gzip (a .xml.gz file), or an error. Inflating stops
 * at the same budget a plain sitemap is read up to (`tooLarge`), so a small file that inflates to
 * gigabytes costs no more than a large plain one.
 */
export const sitemapText = async (
  bytes: Buffer,
  maxBytes = SITEMAP_READ_BYTES
): Promise<
  { text: string; bytes: number } | { error: string; tooLarge: boolean }
> => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return { text: bytes.toString("utf-8"), bytes: bytes.length };
  }

  try {
    const inflated = await gunzipAsync(bytes, {
      maxOutputLength: maxBytes + 1,
    });

    return { text: inflated.toString("utf-8"), bytes: inflated.length };
  } catch (error) {
    const tooLarge =
      error instanceof RangeError ||
      (error instanceof Error &&
        "code" in error &&
        error.code === "ERR_BUFFER_TOO_LARGE");

    return {
      error: tooLarge
        ? `inflates to more than the ${megabytes(maxBytes)} this audit reads`
        : `is not valid gzip (${error instanceof Error ? error.message : String(error)})`,
      tooLarge,
    };
  }
};

/** How the sitemaps behind one audit's `problems` were read. */
export interface SitemapReading {
  /** The most of one file the audit read, which its finding about larger sitemaps names. */
  maxBytes: number;
  /** Sitemaps a gate kept the audit from requesting (the hosted server's), so they were not read. */
  refused: string[];
}

const readings = new WeakMap<SitemapProblems, SitemapReading>();

/**
 * How the sitemaps behind `problems` were read. Kept beside the problems, like the layout, so the
 * JSON stays as it is.
 */
export const sitemapReading = (problems: SitemapProblems): SitemapReading =>
  readings.get(problems) ?? { maxBytes: SITEMAP_READ_BYTES, refused: [] };

/**
 * Which sitemap file lists what, for fixes that name the file to edit. It is kept beside the
 * audit's `problems` rather than in it, so the JSON stays as it is.
 */
export interface SitemapLayout {
  /** The sitemap each page URL is listed in (the first one read, when several list it). */
  sitemapOf: Map<string, string>;
  /** The sitemaps each sitemap index lists. */
  children: Map<string, string[]>;
  /** The sitemap index that lists a sitemap. */
  parentOf: Map<string, string>;
  /** Sitemaps with <urlset>, in the order they were read. */
  urlsets: string[];
}

const layouts = new WeakMap<SitemapProblems, SitemapLayout>();

/** The layout `inspectSitemap` recorded for the sitemaps behind `problems`. */
export const sitemapLayout = (problems: SitemapProblems): SitemapLayout => {
  let layout = layouts.get(problems);

  if (!layout) {
    layout = {
      sitemapOf: new Map(),
      children: new Map(),
      parentOf: new Map(),
      urlsets: [],
    };
    layouts.set(problems, layout);
  }

  return layout;
};

const recordLayout = (
  problems: SitemapProblems,
  sitemap: string,
  parsed: ParsedSitemap
): void => {
  const layout = sitemapLayout(problems);

  if (parsed.kind === "sitemapindex") {
    layout.children.set(sitemap, parsed.locs);

    for (const loc of parsed.locs) {
      if (!layout.parentOf.has(loc)) {
        layout.parentOf.set(loc, sitemap);
      }
    }

    return;
  }

  layout.urlsets.push(sitemap);

  for (const loc of parsed.locs) {
    if (!layout.sitemapOf.has(loc)) {
      layout.sitemapOf.set(loc, sitemap);
    }
  }
};

export const emptySitemapProblems = (): SitemapProblems => ({
  oversized: [],
  nestedIndexes: [],
  invalidLastmod: { count: 0, examples: [] },
  futureLastmod: { count: 0, examples: [] },
  otherHost: { count: 0, examples: [] },
});

/*
 * W3C Datetime: a year, a month, a day, then a time with an optional time zone. A time without a
 * zone breaks the format but is common, and search engines read it, so it passes.
 */
const W3C_DATETIME =
  /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?)?)?$/u;

/** A day of slack, so a lastmod written in a time zone ahead of the audit's is not "future". */
const FUTURE_SLACK_MS = 86_400_000;

const note = (list: SitemapExamples, example: string): void => {
  list.count += 1;

  if (list.examples.length < 10) {
    list.examples.push(example.slice(0, 300));
  }
};

export interface InspectOptions {
  /** The sitemap was listed by a sitemap index. */
  fromIndex: boolean;
  /** The audited site's host, to compare each URL with, or null to skip that (build output on a placeholder host). */
  siteHost: string | null;
  includeSubdomains?: boolean;
  now: number;
}

/** Record where one parsed sitemap file breaks the protocol. */
export const inspectSitemap = (
  problems: SitemapProblems,
  sitemap: string,
  parsed: ParsedSitemap,
  bytes: number,
  options: InspectOptions
): void => {
  recordLayout(problems, sitemap, parsed);

  if (parsed.kind === "sitemapindex" && options.fromIndex) {
    problems.nestedIndexes.push(sitemap);
  }

  if (parsed.locs.length > SITEMAP_MAX_URLS || bytes > SITEMAP_MAX_BYTES) {
    problems.oversized.push({
      sitemap,
      urls: parsed.locs.length,
      bytes,
      overLimit: true,
    });
  }

  if (parsed.kind !== "urlset") {
    return;
  }

  const { siteHost } = options;

  for (const [i, loc] of parsed.locs.entries()) {
    const lastmod = parsed.lastmods[i];

    if (lastmod) {
      const value = lastmod.slice(0, 64);

      if (!W3C_DATETIME.test(value)) {
        note(problems.invalidLastmod, `${loc} (${value})`);
      } else if (Date.parse(value) > options.now + FUTURE_SLACK_MS) {
        note(problems.futureLastmod, `${loc} (${value})`);
      }
    }

    if (siteHost && !isSameSite(loc, siteHost, options.includeSubdomains)) {
      note(problems.otherHost, `${loc} (in ${sitemap})`);
    }
  }
};

/** What fetching one sitemap gave: one to read, an error to report, or nothing to say. */
type SitemapFetch =
  | { kind: "parsed"; parsed: ParsedSitemap; bytes: number }
  | { kind: "error"; message: string }
  | { kind: "oversized"; bytes: number | null; overLimit: boolean }
  | { kind: "skip" };

const fetchSitemap = async (
  url: string,
  candidates: string[],
  options: FetchOptions,
  maxBytes: number
): Promise<SitemapFetch> => {
  const res = await fetchPage(url, {
    ...options,
    timeoutMs: Math.min(options.timeoutMs ?? 15_000, 20_000),
    maxBodyBytes: maxBytes,
    keepBytes: true,
  });

  if (res.error) {
    return { kind: "error", message: `${url}: ${res.error}` };
  }

  if (res.status !== 200 || res.body === null || !res.bytes) {
    // A sitemap that answers 404 is passed over without an error.
    if (res.status !== 404) {
      return { kind: "error", message: `${url}: HTTP ${res.status}` };
    }

    return { kind: "skip" };
  }

  if (res.truncated) {
    const declared = Number(res.headers["content-length"]);
    const known = Number.isFinite(declared) && declared > 0 ? declared : null;

    // Content-Length counts compressed bytes for a Content-Encoding response or a gzip file; the
    // uncompressed size is then unknown, though it can only be larger.
    const compressed =
      Boolean(res.headers["content-encoding"]) ||
      (res.bytes[0] === 0x1f && res.bytes[1] === 0x8b);

    return {
      kind: "oversized",
      bytes: compressed ? null : known,
      overLimit: known !== null && known > SITEMAP_MAX_BYTES,
    };
  }

  const text = await sitemapText(res.bytes, maxBytes);

  if ("error" in text) {
    return text.tooLarge
      ? { kind: "oversized", bytes: null, overLimit: false }
      : { kind: "error", message: `${url}: ${text.error}` };
  }

  const parsed = parseSitemap(text.text, res.contentType);

  if (parsed.kind !== "unknown") {
    return { kind: "parsed", parsed, bytes: text.bytes };
  }

  if (!/<html/iu.test(text.text.slice(0, 1000))) {
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
  const maxBytes = limits.maxBytes ?? SITEMAP_READ_BYTES;

  const info: SitemapInfo = {
    sources: [],
    urls: [],
    urlCount: 0,
    errors: [],
    problems: emptySitemapProblems(),
  };

  const reading: SitemapReading = { maxBytes, refused: [] };
  readings.set(info.problems, reading);

  const queue = [...new Set(candidates)].map((url) => ({
    url,
    fromIndex: false,
  }));

  const seen = new Set<string>();
  const urls = new Set<string>();
  const now = Date.now();

  const fetchOne = (url: string) => {
    const request = () => fetchSitemap(url, candidates, options, maxBytes);

    return limits.refusals ? limits.refusals.run(url, request) : request();
  };

  // Count every download, not only the sitemaps that parsed: one over the read limit still costs its full read.
  while (queue.length > 0 && seen.size < maxSitemaps && urls.size < maxUrls) {
    const next = queue.shift();

    if (next === undefined || seen.has(next.url)) {
      continue;
    }

    const { url, fromIndex } = next;
    seen.add(url);

    // oxlint-disable-next-line eslint/no-await-in-loop -- a sitemap index adds the sitemaps to fetch next, and the limits count what the earlier ones gave
    const fetched = await fetchOne(url);

    if (fetched === null) {
      reading.refused.push(url);
      continue;
    }

    if (fetched.kind === "error") {
      info.errors.push(fetched.message);
    }

    if (fetched.kind === "oversized") {
      info.problems.oversized.push({
        sitemap: url,
        urls: null,
        bytes: fetched.bytes,
        overLimit: fetched.overLimit,
      });
    }

    if (fetched.kind !== "parsed") {
      continue;
    }

    const { parsed } = fetched;
    info.sources.push(url);
    inspectSitemap(info.problems, url, parsed, fetched.bytes, {
      fromIndex,
      siteHost: limits.siteHost ?? null,
      includeSubdomains: limits.includeSubdomains,
      now,
    });

    if (parsed.kind === "sitemapindex") {
      queue.push(...parsed.locs.map((loc) => ({ url: loc, fromIndex: true })));
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
