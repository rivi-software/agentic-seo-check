import { promises as fs } from "node:fs";
import path from "node:path";

import type { CrawlResult } from "./crawl.js";
import { DEFAULT_USER_AGENT } from "./fetch.js";
import { extractPage } from "./html/extract.js";
import { buildRobots } from "./robots.js";
import type { RobotsResult } from "./robots.js";
import { isLocalHost } from "./rules/canonical.js";
import type { LinkCheck, PageRecord } from "./site-rules.js";
import {
  emptySitemapProblems,
  inspectSitemap,
  parseSitemap,
  SITEMAP_MAX_BYTES,
  SITEMAP_READ_BYTES,
  sitemapText,
} from "./sitemap.js";
import type { SitemapInfo } from "./types.js";
import { hostOf, normalizePath, normalizeUrl } from "./url.js";

export interface DirectoryOptions {
  /** Base URL used to build page URLs and resolve links. Defaults to http://localhost/ */
  baseUrl: string;
  includeSubdomains: boolean;
  maxPages: number;
  userAgent?: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".vercel",
  ".output/server",
]);

const MISSING_FILE = "No matching file in output directory";

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") {
      continue;
    }

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- the walk reads one directory at a time, so a deep tree never opens thousands of handles at once
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }

  return out;
};

const fileExists = async (root: string, pathname: string): Promise<boolean> => {
  let decoded = pathname;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* keep */
  }

  const candidates = [
    decoded,
    `${decoded}.html`,
    `${decoded}.htm`,
    path.posix.join(decoded, "index.html"),
    path.posix.join(decoded, "index.htm"),
  ];

  for (const c of candidates) {
    const full = path.join(root, c);

    if (!full.startsWith(root)) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- the candidates are tried in order and the first file found ends the search
    const stat = await fs.stat(full).catch(() => null);

    if (stat?.isFile()) {
      return true;
    }
  }

  return false;
};

/** The check a link gets in a directory audit: 200 when the file is there, 404 when not. */
const fileCheck = (
  url: string,
  finalUrl: string,
  exists: boolean
): LinkCheck => ({
  url,
  status: exists ? 200 : 404,
  finalUrl,
  redirectChain: [],
  error: exists ? undefined : MISSING_FILE,
});

interface ScannedPages {
  records: PageRecord[];
  recordByKey: Map<string, PageRecord>;
}

const readPages = async (
  root: string,
  files: string[],
  base: URL,
  options: DirectoryOptions,
  toUrlPath: (file: string) => string
): Promise<ScannedPages> => {
  const records: PageRecord[] = [];
  const recordByKey = new Map<string, PageRecord>();

  for (const file of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time on purpose: a build can hold thousands of pages
    const html = await fs.readFile(file, "utf-8");
    const urlPath = toUrlPath(file).replace(/\/index\.html?$/iu, "/");
    const url = new URL(urlPath, base).href;

    const page = extractPage(html, {
      url,
      siteHost: base.hostname,
      includeSubdomains: options.includeSubdomains,
    });

    const record: PageRecord = {
      url,
      requestedUrl: url,
      page,
      depth: -1,
      file: path.relative(root, file),
    };

    records.push(record);
    recordByKey.set(normalizePath(new URL(url).pathname), record);
  }

  return { records, recordByKey };
};

interface ScannedLinks {
  linkChecks: Map<string, LinkCheck>;
  linkSources: Map<string, Set<string>>;
}

/** Every internal link of every page, checked against the files in the directory. */
const checkLinks = async (
  root: string,
  records: PageRecord[],
  fileByPathKey: Map<string, string>
): Promise<ScannedLinks> => {
  const linkChecks = new Map<string, LinkCheck>();
  const linkSources = new Map<string, Set<string>>();

  for (const record of records) {
    for (const link of record.page.links) {
      if (!link.internal || !link.url) {
        continue;
      }

      const target = normalizeUrl(link.url) ?? link.url;
      let sources = linkSources.get(target);

      if (!sources) {
        sources = new Set();
        linkSources.set(target, sources);
      }

      sources.add(record.url);

      if (!linkChecks.has(target)) {
        const { pathname } = new URL(target);

        const exists =
          fileByPathKey.has(normalizePath(pathname)) ||
          // oxlint-disable-next-line eslint/no-await-in-loop -- a target is checked once, so the next link to it must see this check
          (await fileExists(root, pathname));

        linkChecks.set(target, fileCheck(target, target, exists));
      }
    }
  }

  return { linkChecks, linkSources };
};

/**
 * Canonical and hreflang targets on the site's own host, checked against the files like links are.
 * With the default base URL (localhost) a production canonical is on another host and is skipped.
 */
const checkMetadataTargets = async (
  root: string,
  records: PageRecord[],
  base: URL,
  fileByPathKey: Map<string, string>,
  linkChecks: Map<string, LinkCheck>
): Promise<void> => {
  for (const record of records) {
    for (const url of [
      record.page.canonical,
      ...record.page.hreflang.map((h) => h.url),
    ]) {
      const target = url ? normalizeUrl(url) : null;

      if (
        !target ||
        linkChecks.has(target) ||
        hostOf(target) !== base.hostname
      ) {
        continue;
      }

      const { pathname } = new URL(target);

      const exists =
        fileByPathKey.has(normalizePath(pathname)) ||
        // oxlint-disable-next-line eslint/no-await-in-loop -- a target is checked once, so the next page naming it must see this check
        (await fileExists(root, pathname));

      linkChecks.set(target, fileCheck(target, target, exists));
    }
  }
};

/** Depth via breadth-first search from the root index (if present); returns the start page. */
const assignDepths = (
  records: PageRecord[],
  recordByKey: Map<string, PageRecord>
): PageRecord | undefined => {
  const start = recordByKey.get("/") ?? records[0];

  if (!start) {
    return undefined;
  }

  start.depth = 0;
  const queue = [start];

  for (let current = queue.shift(); current; current = queue.shift()) {
    for (const link of current.page.links) {
      if (!link.internal || !link.url) {
        continue;
      }

      const target = recordByKey.get(normalizePath(new URL(link.url).pathname));

      if (target && target.depth === -1) {
        target.depth = current.depth + 1;
        queue.push(target);
      }
    }
  }

  return start;
};

/** sitemap.xml, and the sitemaps robots.txt names, read from the output directory. */
const readSitemaps = async (
  root: string,
  base: URL,
  robots: RobotsResult,
  includeSubdomains: boolean
): Promise<SitemapInfo> => {
  const sitemaps: SitemapInfo = {
    sources: [],
    urls: [],
    urlCount: 0,
    errors: [],
    problems: emptySitemapProblems(),
  };

  const candidates = [
    ...new Set([...robots.info.sitemaps, new URL("/sitemap.xml", base).href]),
  ].map((url) => ({ url, fromIndex: false }));

  const seen = new Set<string>();
  const urls = new Set<string>();
  const now = Date.now();

  while (seen.size < 25) {
    const next = candidates.shift();

    if (next === undefined) {
      break;
    }

    const { url: candidate, fromIndex } = next;

    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    let pathname: string;

    try {
      pathname = decodeURIComponent(new URL(candidate, base).pathname);
    } catch {
      sitemaps.errors.push(`${candidate}: invalid URL`);
      continue;
    }

    const file = path.join(root, pathname);

    // robots.txt and sitemap indexes come from the site; a decoded "%2e%2e" must not leave the directory.
    if (!file.startsWith(`${root}${path.sep}`)) {
      sitemaps.errors.push(`${candidate}: points outside the output directory`);
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- a sitemap index adds the sitemaps it lists to the candidates, so each read decides what comes next
    const stat = await fs.stat(file).catch(() => null);

    if (stat?.isFile() && stat.size > SITEMAP_READ_BYTES) {
      sitemaps.problems.oversized.push({
        sitemap: candidate,
        urls: null,
        bytes: stat.size,
        overLimit: stat.size > SITEMAP_MAX_BYTES,
      });

      continue;
    }

    const bytes = stat?.isFile()
      ? // oxlint-disable-next-line eslint/no-await-in-loop -- read right after the size check above
        await fs.readFile(file).catch(() => null)
      : null;

    if (bytes === null) {
      if (robots.info.sitemaps.includes(candidate)) {
        sitemaps.errors.push(
          `${candidate}: declared in robots.txt but ${pathname} is not in the output directory`
        );
      }

      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one sitemap at a time, as above
    const text = await sitemapText(bytes);

    if ("error" in text) {
      if (text.tooLarge) {
        sitemaps.problems.oversized.push({
          sitemap: candidate,
          urls: null,
          bytes: null,
          overLimit: false,
        });
      } else {
        sitemaps.errors.push(`${pathname}: ${text.error}`);
      }

      continue;
    }

    const parsed = parseSitemap(text.text);

    if (parsed.kind === "unknown") {
      sitemaps.errors.push(`${pathname}: could not parse as a sitemap`);
      continue;
    }

    sitemaps.sources.push(candidate);

    // With the placeholder localhost base every production URL would count as another host.
    inspectSitemap(sitemaps.problems, candidate, parsed, text.bytes, {
      fromIndex,
      siteHost: isLocalHost(base.href) ? null : base.hostname,
      includeSubdomains,
      now,
    });

    if (parsed.kind === "sitemapindex") {
      candidates.push(
        ...parsed.locs.map((loc) => ({ url: loc, fromIndex: true }))
      );
    } else {
      for (const loc of parsed.locs) {
        urls.add(loc);
      }
    }
  }

  sitemaps.urls = [...urls];
  sitemaps.urlCount = urls.size;

  return sitemaps;
};

/** A check for each sitemap URL, against the files in the directory, unless a link had one. */
const checkSitemapUrls = (
  urls: string[],
  base: URL,
  fileByPathKey: Map<string, string>,
  linkChecks: Map<string, LinkCheck>
): void => {
  for (const u of urls) {
    let key: string;

    try {
      key = normalizePath(new URL(u).pathname);
    } catch {
      continue;
    }

    const synthetic = new URL(key === "/" ? "/" : key, base).href;

    if (!linkChecks.has(synthetic)) {
      linkChecks.set(synthetic, fileCheck(u, u, fileByPathKey.has(key)));
    }
  }
};

export const scanDirectory = async (
  dir: string,
  options: DirectoryOptions
): Promise<CrawlResult> => {
  const started = performance.now();
  const root = path.resolve(dir);
  const stat = await fs.stat(root).catch(() => null);

  if (!stat?.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }

  const base = new URL(
    options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`
  );

  const walked = await walk(root);
  const files = walked.toSorted();
  const htmlFiles = files.filter((f) => /\.html?$/iu.test(f));
  const hitLimit = htmlFiles.length > options.maxPages;
  const selected = htmlFiles.slice(0, options.maxPages);

  const toUrlPath = (file: string): string =>
    `/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/")}`;

  const fileByPathKey = new Map<string, string>();

  for (const f of htmlFiles) {
    fileByPathKey.set(normalizePath(toUrlPath(f)), f);
  }

  const { records, recordByKey } = await readPages(
    root,
    selected,
    base,
    options,
    toUrlPath
  );

  const { linkChecks, linkSources } = await checkLinks(
    root,
    records,
    fileByPathKey
  );

  await checkMetadataTargets(root, records, base, fileByPathKey, linkChecks);

  const start = assignDepths(records, recordByKey);

  const linkedKeys = new Set(
    [...linkSources.keys()].map((u) => normalizePath(new URL(u).pathname))
  );

  const unlinkedPages = records.flatMap((r) =>
    r !== start && !linkedKeys.has(normalizePath(new URL(r.url).pathname))
      ? [r.file ?? r.url]
      : []
  );

  /* robots.txt and sitemap.xml from the output directory. */
  const robotsText = await fs
    .readFile(path.join(root, "robots.txt"), "utf-8")
    .catch(() => null);

  const robots = buildRobots(
    new URL("/robots.txt", base).href,
    robotsText === null ? 404 : 200,
    undefined,
    robotsText,
    options.userAgent ?? DEFAULT_USER_AGENT
  );

  const sitemaps = await readSitemaps(
    root,
    base,
    robots,
    options.includeSubdomains
  );

  checkSitemapUrls(sitemaps.urls, base, fileByPathKey, linkChecks);

  return {
    startUrl: base.href,
    records,
    linkChecks,
    linkSources,
    robots: robots.info,
    robotsText: robots.text,
    robotsAllows: robots.info.found ? robots.allows : null,
    blockedByRobots: robots.info.found
      ? records.flatMap((r) => (robots.allows(r.url) ? [] : [r.url]))
      : [],
    sitemaps,
    probes: {},
    stats: {
      pagesCrawled: records.length,
      pagesDiscovered: htmlFiles.length,
      linksChecked: linkChecks.size,
      maxPages: options.maxPages,
      maxDepth: Infinity,
      hitPageLimit: hitLimit,
      durationMs: Math.round(performance.now() - started),
      respectedRobots: false,
    },
    unlinkedPages,
  };
};
