import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractPage } from './html/extract.js';
import { DEFAULT_USER_AGENT } from './fetch.js';
import { buildRobots } from './robots.js';
import { parseSitemap } from './sitemap.js';
import type { LinkCheck, PageRecord } from './site-rules.js';
import type { CrawlResult } from './crawl.js';
import type { SitemapInfo } from './types.js';
import { normalizePath, normalizeUrl } from './url.js';

export interface DirectoryOptions {
  /** Base URL used to build page URLs and resolve links. Defaults to http://localhost/ */
  baseUrl: string;
  includeSubdomains: boolean;
  maxPages: number;
  userAgent?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.cache', '.vercel', '.output/server']);

export async function scanDirectory(dir: string, options: DirectoryOptions): Promise<CrawlResult> {
  const started = performance.now();
  const root = path.resolve(dir);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Not a directory: ${root}`);
  const base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);

  const files = (await walk(root)).sort();
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  const hitLimit = htmlFiles.length > options.maxPages;
  const selected = htmlFiles.slice(0, options.maxPages);

  const toUrlPath = (file: string): string => `/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/')}`;
  const fileByPathKey = new Map<string, string>();
  for (const f of htmlFiles) fileByPathKey.set(normalizePath(toUrlPath(f)), f);

  const records: PageRecord[] = [];
  const linkChecks = new Map<string, LinkCheck>();
  const linkSources = new Map<string, Set<string>>();
  const recordByKey = new Map<string, PageRecord>();

  for (const file of selected) {
    const html = await fs.readFile(file, 'utf8');
    const urlPath = toUrlPath(file).replace(/\/index\.html?$/i, '/');
    const url = new URL(urlPath, base).href;
    const page = extractPage(html, { url, siteHost: base.hostname, includeSubdomains: options.includeSubdomains });
    const record: PageRecord = { url, requestedUrl: url, page, depth: -1, file: path.relative(root, file) };
    records.push(record);
    recordByKey.set(normalizePath(new URL(url).pathname), record);
  }

  for (const record of records) {
    for (const link of record.page.links) {
      if (!link.internal || !link.url) continue;
      const target = normalizeUrl(link.url) ?? link.url;
      if (!linkSources.has(target)) linkSources.set(target, new Set());
      linkSources.get(target)!.add(record.url);
      if (!linkChecks.has(target)) {
        const key = normalizePath(new URL(target).pathname);
        const exists = fileByPathKey.has(key) || (await fileExists(root, new URL(target).pathname));
        linkChecks.set(target, { url: target, status: exists ? 200 : 404, finalUrl: target, redirectChain: [], error: exists ? undefined : 'No matching file in output directory' });
      }
    }
  }

  /* Depth via BFS from the root index (if present). */
  const start = recordByKey.get('/') ?? records[0];
  if (start) {
    start.depth = 0;
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      for (const link of current.page.links) {
        if (!link.internal || !link.url) continue;
        const target = recordByKey.get(normalizePath(new URL(link.url).pathname));
        if (target && target.depth === -1) {
          target.depth = current.depth + 1;
          queue.push(target);
        }
      }
    }
  }

  const linkedKeys = new Set([...linkSources.keys()].map((u) => normalizePath(new URL(u).pathname)));
  const unlinkedPages = records.filter((r) => r !== start && !linkedKeys.has(normalizePath(new URL(r.url).pathname))).map((r) => r.file ?? r.url);

  /* robots.txt and sitemap.xml from the output directory. */
  const robotsText = await fs.readFile(path.join(root, 'robots.txt'), 'utf8').catch(() => null);
  const robots = buildRobots(new URL('/robots.txt', base).href, robotsText === null ? 404 : 200, undefined, robotsText, options.userAgent ?? DEFAULT_USER_AGENT);

  const sitemaps: SitemapInfo = { sources: [], urls: [], urlCount: 0, errors: [] };
  const sitemapCandidates = [...new Set([...robots.info.sitemaps, new URL('/sitemap.xml', base).href])];
  const seen = new Set<string>();
  const urls = new Set<string>();
  while (sitemapCandidates.length && seen.size < 25) {
    const candidate = sitemapCandidates.shift()!;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(candidate, base).pathname);
    } catch {
      sitemaps.errors.push(`${candidate}: invalid URL`);
      continue;
    }
    const file = path.join(root, pathname);
    const xml = await fs.readFile(file, 'utf8').catch(() => null);
    if (xml === null) {
      if (robots.info.sitemaps.includes(candidate)) sitemaps.errors.push(`${candidate}: declared in robots.txt but ${pathname} is not in the output directory`);
      continue;
    }
    const parsed = parseSitemap(xml);
    if (parsed.kind === 'unknown') {
      sitemaps.errors.push(`${pathname}: could not parse as a sitemap`);
      continue;
    }
    sitemaps.sources.push(candidate);
    if (parsed.kind === 'sitemapindex') sitemapCandidates.push(...parsed.locs);
    else parsed.locs.forEach((l) => urls.add(l));
  }
  sitemaps.urls = [...urls];
  sitemaps.urlCount = urls.size;
  for (const u of sitemaps.urls) {
    let key: string;
    try {
      key = normalizePath(new URL(u).pathname);
    } catch {
      continue;
    }
    const exists = fileByPathKey.has(key);
    const synthetic = new URL(key === '/' ? '/' : key, base).href;
    if (!linkChecks.has(synthetic)) linkChecks.set(synthetic, { url: u, status: exists ? 200 : 404, finalUrl: u, redirectChain: [], error: exists ? undefined : 'No matching file in output directory' });
  }

  return {
    startUrl: base.href,
    records,
    linkChecks,
    linkSources,
    robots: robots.info,
    robotsAllows: robots.info.found ? robots.allows : null,
    blockedByRobots: robots.info.found ? records.filter((r) => !robots.allows(r.url)).map((r) => r.url) : [],
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
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(full)));
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function fileExists(root: string, pathname: string): Promise<boolean> {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* keep */
  }
  const candidates = [decoded, `${decoded}.html`, `${decoded}.htm`, path.posix.join(decoded, 'index.html'), path.posix.join(decoded, 'index.htm')];
  for (const c of candidates) {
    const full = path.join(root, c);
    if (!full.startsWith(root)) continue;
    const stat = await fs.stat(full).catch(() => null);
    if (stat?.isFile()) return true;
  }
  return false;
}
