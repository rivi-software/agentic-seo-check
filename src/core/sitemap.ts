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
  /**
   * A Google News sitemap: its entries date themselves with <news:publication_date>, so a
   * missing or shared <lastmod> says nothing about them.
   */
  news?: boolean;
}

/** The namespace of Google News sitemaps. */
const NEWS_NAMESPACE = "www.google.com/schemas/sitemap-news/0.9";

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
    const list = Array.isArray(entries) ? entries : [];

    // The parser drops attributes, so the namespace is read from the opening tags as written.
    const news =
      trimmed.slice(0, 4096).includes(NEWS_NAMESPACE) ||
      list.some((e) => isEntry(e) && "news:news" in e);

    const parsed: ParsedSitemap = { kind: "urlset", ...entriesOf(list) };

    if (news) {
      parsed.news = true;
    }

    return parsed;
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

/** The sitemap protocol wants every <loc> "less than 2,048 characters". */
export const MAX_LOC_LENGTH = 2048;

/**
 * Whether a <loc> (or a robots.txt Sitemap: value) is a URL search engines read: absolute, with
 * http or https. Google crawls a sitemap's URLs "exactly as listed", so it drops "/about/".
 */
export const isAbsoluteHttpUrl = (value: string): boolean => {
  if (!/^https?:\/\//iu.test(value)) {
    return false;
  }

  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
};

/** A <loc> search engines drop, and the sitemap that lists it. */
export interface InvalidLoc {
  sitemap: string;
  /** The value as the sitemap writes it, cut at 600 characters. */
  loc: string;
  length: number;
  /** `relative`: no protocol and host; `too-long`: 2,048 characters or more. */
  reason: "relative" | "too-long";
}

/** A sitemap whose <lastmod> values tell crawlers nothing about which pages changed. */
export interface LastmodGap {
  sitemap: string;
  /** How many URLs it lists. */
  urls: number;
  /** Its first few URLs, for a fix to name entries by. */
  locs: string[];
  /** The one value every entry has, for a sitemap that gives them all the same. */
  lastmod?: string;
}

/**
 * What a sitemap's entries say beyond `SitemapProblems`. Kept beside the audit's `problems`, like
 * the layout, so the JSON stays as it is.
 */
export interface SitemapEntryProblems {
  invalidLocs: { count: number; examples: InvalidLoc[] };
  /** Sitemaps (<urlset>) that list URLs and give none of them a <lastmod>. */
  missingLastmod: LastmodGap[];
  /** Sitemaps of `UNIFORM_LASTMOD_MIN_URLS` or more URLs that give each the same date and time. */
  uniformLastmod: LastmodGap[];
}

const entryProblems = new WeakMap<SitemapProblems, SitemapEntryProblems>();

/** The entry problems `inspectSitemap` recorded for the sitemaps behind `problems`. */
export const sitemapEntryProblems = (
  problems: SitemapProblems
): SitemapEntryProblems => {
  let entries = entryProblems.get(problems);

  if (!entries) {
    entries = {
      invalidLocs: { count: 0, examples: [] },
      missingLastmod: [],
      uniformLastmod: [],
    };
    entryProblems.set(problems, entries);
  }

  return entries;
};

/**
 * A sitemap this small may have gone live in one go, every page on the same day; past it, one
 * time on every URL is the build's.
 */
export const UNIFORM_LASTMOD_MIN_URLS = 10;

/** URLs a lastmod gap keeps for its fix. */
const GAP_LOCS = 3;

/** Why search engines drop a <loc>, or null when they read it. */
const locProblem = (loc: string): InvalidLoc["reason"] | null => {
  if (!isAbsoluteHttpUrl(loc)) {
    return "relative";
  }

  return loc.length >= MAX_LOC_LENGTH ? "too-long" : null;
};

const noteLoc = (
  entries: SitemapEntryProblems,
  sitemap: string,
  loc: string,
  reason: InvalidLoc["reason"]
): void => {
  entries.invalidLocs.count += 1;

  if (entries.invalidLocs.examples.length < 10) {
    entries.invalidLocs.examples.push({
      sitemap,
      loc: loc.slice(0, 600),
      length: loc.length,
      reason,
    });
  }
};

/**
 * A lastmod with a time of day: what a build writes when it stamps its own clock. Midnight is a
 * date written out in full, which a site that went live in one day may share across its pages.
 */
const hasTimeOfDay = (value: string): boolean => {
  const t = value.indexOf("T");

  return (
    t !== -1 &&
    !/^T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(value.slice(t))
  );
};

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

/**
 * Notes a urlset's lastmod values that are not W3C Datetime or lie in the future, and a urlset
 * whose lastmods tell crawlers nothing: none at all, or one date and time on every URL. A Google
 * News sitemap dates its entries another way, so only its invalid and future values count.
 */
const inspectLastmods = (
  problems: SitemapProblems,
  sitemap: string,
  parsed: ParsedSitemap,
  now: number
): void => {
  let dated = 0;
  // The one valid date and time every entry so far has, or null once two differ or one has none.
  let shared: string | null | undefined;

  for (const [i, loc] of parsed.locs.entries()) {
    const lastmod = parsed.lastmods[i];

    if (!lastmod) {
      shared = null;
      continue;
    }

    dated += 1;
    const value = lastmod.slice(0, 64);

    if (!W3C_DATETIME.test(value)) {
      note(problems.invalidLastmod, `${loc} (${value})`);
      shared = null;
    } else if (Date.parse(value) > now + FUTURE_SLACK_MS) {
      note(problems.futureLastmod, `${loc} (${value})`);
      shared = null;
    } else if (shared === undefined) {
      shared = value;
    } else if (shared !== value) {
      shared = null;
    }
  }

  if (parsed.news) {
    return;
  }

  const entries = sitemapEntryProblems(problems);

  const gap: LastmodGap = {
    sitemap,
    urls: parsed.locs.length,
    locs: parsed.locs.slice(0, GAP_LOCS),
  };

  if (parsed.locs.length > 0 && dated === 0) {
    entries.missingLastmod.push(gap);
  } else if (
    parsed.locs.length >= UNIFORM_LASTMOD_MIN_URLS &&
    shared &&
    hasTimeOfDay(shared)
  ) {
    gap.lastmod = shared;
    entries.uniformLastmod.push(gap);
  }
};

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

  const entries = sitemapEntryProblems(problems);

  for (const loc of parsed.locs) {
    const reason = locProblem(loc);

    if (reason) {
      noteLoc(entries, sitemap, loc, reason);
    }
  }

  if (parsed.kind !== "urlset") {
    return;
  }

  inspectLastmods(problems, sitemap, parsed, options.now);

  const { siteHost } = options;

  for (const loc of parsed.locs) {
    // A relative <loc> is reported as one search engines drop, not as a URL on another host.
    if (
      siteHost &&
      isAbsoluteHttpUrl(loc) &&
      !isSameSite(loc, siteHost, options.includeSubdomains)
    ) {
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

  // A Sitemap: line or index entry that is not a full URL is one search engines drop; the
  // robots.txt and sitemap rules report it, and the audit drops it as they do.
  const queue = [...new Set(candidates)].flatMap((url) =>
    isAbsoluteHttpUrl(url) ? [{ url, fromIndex: false }] : []
  );

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

    const locs = parsed.locs.filter(isAbsoluteHttpUrl);

    if (parsed.kind === "sitemapindex") {
      queue.push(...locs.map((loc) => ({ url: loc, fromIndex: true })));
    } else {
      for (const loc of locs) {
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
