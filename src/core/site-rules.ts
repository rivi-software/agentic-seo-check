import { normalizeForComparison, shingles, jaccard } from "./html/text.js";
import { robotsDirectives } from "./rules/indexing.js";
import { finding, GOOGLE_DOCS, cap } from "./rules/rule.js";
import type {
  ExtractedPage,
  Finding,
  ResponseInfo,
  RobotsTxtInfo,
  RuleMeta,
  SitemapInfo,
  Thresholds,
  CrawlStats,
} from "./types.js";
import { normalizeUrl, normalizePath } from "./url.js";

const meta = (
  id: string,
  severity: RuleMeta["severity"],
  description: string,
  recommendation: string,
  docs?: string
): RuleMeta => ({
  id,
  category: "site",
  severity,
  description,
  recommendation,
  docs,
  requires: "crawl",
});

export const SITE_RULES: RuleMeta[] = [
  meta(
    "site.robots-txt-missing",
    "warning",
    "No robots.txt was found at the site root.",
    'Add /robots.txt. At minimum: "User-agent: *" with no disallow rules, plus a "Sitemap:" line.',
    GOOGLE_DOCS.robotsTxt
  ),
  meta(
    "site.robots-txt-error",
    "warning",
    'robots.txt returned a server error or could not be fetched. Google treats 5xx robots.txt as "do not crawl anything".',
    "Make /robots.txt return 200 (or 404 if you have none).",
    GOOGLE_DOCS.robotsTxt
  ),
  meta(
    "site.robots-txt-blocks-all",
    "error",
    "robots.txt disallows crawling of the whole site for all user agents.",
    'Remove "Disallow: /" for "User-agent: *" unless the site is intentionally private (staging).',
    GOOGLE_DOCS.robotsTxt
  ),
  meta(
    "site.robots-blocked-pages",
    "warning",
    "Pages linked internally (or listed in the sitemap) are disallowed by robots.txt.",
    "Allow the paths in robots.txt, or stop linking to them and remove them from the sitemap if they should stay hidden.",
    GOOGLE_DOCS.robotsTxt
  ),
  meta(
    "site.sitemap-missing",
    "warning",
    "No XML sitemap was found (robots.txt Sitemap: line or /sitemap.xml).",
    "Generate a sitemap.xml listing canonical, indexable URLs and reference it from robots.txt.",
    GOOGLE_DOCS.sitemaps
  ),
  meta(
    "site.sitemap-error",
    "error",
    "A sitemap could not be fetched or parsed.",
    "Make the sitemap return 200 with valid XML (urlset or sitemapindex).",
    GOOGLE_DOCS.sitemaps
  ),
  meta(
    "site.sitemap-noindex-page",
    "error",
    "The sitemap lists pages that are set to noindex.",
    "Either remove noindex (if the page should rank) or remove the URL from the sitemap. Conflicting signals waste crawl budget.",
    GOOGLE_DOCS.sitemaps
  ),
  meta(
    "site.sitemap-non-canonical",
    "warning",
    "The sitemap lists URLs whose canonical points to a different URL.",
    "List only canonical URLs in the sitemap.",
    GOOGLE_DOCS.sitemaps
  ),
  meta(
    "site.sitemap-broken-url",
    "error",
    "The sitemap lists URLs that return 4xx/5xx.",
    "Remove dead URLs from the sitemap or fix them.",
    GOOGLE_DOCS.sitemaps
  ),
  meta(
    "site.sitemap-redirecting-url",
    "warning",
    "The sitemap lists URLs that redirect.",
    "Replace redirecting URLs in the sitemap with their final destination.",
    GOOGLE_DOCS.sitemaps
  ),
  meta(
    "site.not-in-sitemap",
    "info",
    "Indexable pages discovered by crawling are not listed in the sitemap.",
    "Add the missing URLs to the sitemap (or generate it from the router so it stays complete).",
    GOOGLE_DOCS.sitemaps
  ),
  meta(
    "site.orphan-pages",
    "info",
    "Sitemap URLs that no crawled page links to.",
    "Link orphan pages from relevant pages or navigation; pages without internal links get little authority and are crawled less.",
    GOOGLE_DOCS.links
  ),
  meta(
    "site.broken-internal-links",
    "error",
    "Internal links point to URLs that return 4xx/5xx or fail to load.",
    "Fix or remove the links listed in evidence. Each entry shows the broken target and the pages linking to it.",
    GOOGLE_DOCS.links
  ),
  meta(
    "site.redirected-internal-links",
    "warning",
    "Internal links point to URLs that redirect.",
    "Update the links to the final URL to save a round trip for users and crawlers.",
    GOOGLE_DOCS.redirects
  ),
  meta(
    "site.redirect-chains",
    "warning",
    "Internal URLs go through two or more redirects (or loop).",
    "Point each redirect straight at its final destination.",
    GOOGLE_DOCS.redirects
  ),
  meta(
    "site.duplicate-titles",
    "warning",
    "Several indexable pages share the same <title>.",
    "Give each page a unique title that describes that page (templates: include the item name, category and brand).",
    GOOGLE_DOCS.titles
  ),
  meta(
    "site.duplicate-descriptions",
    "warning",
    "Several indexable pages share the same meta description.",
    "Write a unique description per page, or generate it from page-specific data.",
    GOOGLE_DOCS.snippets
  ),
  meta(
    "site.duplicate-h1",
    "info",
    "Several pages share the same <h1>.",
    "Make H1s page-specific."
  ),
  meta(
    "site.duplicate-content",
    "warning",
    "Pages with identical or near-identical body text.",
    "Consolidate duplicates with a canonical to one URL, 301 redirect, or make the content distinct.",
    GOOGLE_DOCS.canonical
  ),
  meta(
    "site.deep-pages",
    "info",
    "Pages that are more than the configured number of clicks (default 3) from the start URL.",
    "Flatten the architecture: link important deep pages from category pages, navigation or the homepage.",
    GOOGLE_DOCS.links
  ),
  meta(
    "site.soft-404",
    "warning",
    "A clearly non-existent URL returns HTTP 200 instead of 404.",
    "Return a real 404 (or 410) status for unknown routes; otherwise search engines index error pages and waste crawl budget.",
    GOOGLE_DOCS.softs404
  ),
  meta(
    "site.http-not-redirected",
    "warning",
    "The http:// version of the site does not redirect to https://.",
    "Add a permanent (301/308) redirect from http to https at the server or CDN.",
    GOOGLE_DOCS.redirects
  ),
  meta(
    "site.host-variant-not-redirected",
    "warning",
    "The www/non-www variant of the host does not redirect to the main host.",
    "Redirect the alternate host (www or bare domain) to the canonical host with a 301/308.",
    GOOGLE_DOCS.canonical
  ),
  meta(
    "site.hreflang-no-return-link",
    "warning",
    "hreflang alternates do not link back to the page that references them.",
    "Every page in an hreflang cluster must list all alternates including itself; mismatches invalidate the annotations.",
    GOOGLE_DOCS.hreflang
  ),
  meta(
    "site.broken-external-links",
    "warning",
    "External links point to URLs that return 4xx/5xx or fail to load.",
    "Fix or remove the dead outbound links; they hurt user trust and signal an unmaintained page.",
    GOOGLE_DOCS.links
  ),
  meta(
    "site.unlinked-pages",
    "info",
    "HTML files in the build output that no other page links to.",
    "Link the pages from navigation or related content, or remove them from the build if they are obsolete.",
    GOOGLE_DOCS.links
  ),
  meta(
    "site.crawl-limit-reached",
    "info",
    "The crawl stopped at the page limit, so site-wide checks (orphans, duplicates, sitemap coverage) are partial.",
    "Re-run with a higher maxPages value for a complete picture."
  ),
];

const byId = new Map(SITE_RULES.map((r) => [r.id, r]));
const m = (id: string): RuleMeta => byId.get(id)!;

export interface PageRecord {
  /** Normalized final URL (or synthetic URL for files). */
  url: string;
  requestedUrl: string;
  page: ExtractedPage;
  response?: ResponseInfo;
  depth: number;
  /** File path for directory audits. */
  file?: string;
}

export interface LinkCheck {
  url: string;
  status: number | null;
  finalUrl: string;
  redirectChain: { url: string; status: number }[];
  error?: string;
}

export interface ProbeResults {
  soft404?: { url: string; status: number | null } | null;
  httpRedirect?: {
    url: string;
    status: number | null;
    finalUrl: string | null;
    redirectsToHttps: boolean;
  } | null;
  hostVariant?: {
    url: string;
    status: number | null;
    finalUrl: string | null;
    redirectsToMain: boolean;
  } | null;
}

export interface SiteContext {
  startUrl: string;
  source: "crawl" | "directory";
  pages: PageRecord[];
  /** Status of every internal URL that was fetched or probed, keyed by normalized URL. */
  linkChecks: Map<string, LinkCheck>;
  /** For every internal target URL, the pages linking to it. */
  linkSources: Map<string, Set<string>>;
  robots: RobotsTxtInfo | null;
  robotsAllows: ((url: string) => boolean) | null;
  blockedByRobots: string[];
  sitemaps: SitemapInfo;
  probes: ProbeResults;
  crawl: CrawlStats;
  thresholds: Thresholds;
  /** Compare URLs by path only (directory audits, where hosts are synthetic). */
  pathOnly: boolean;
  /** External link targets that were probed, keyed by URL. */
  externalChecks?: Map<string, LinkCheck>;
  externalSources?: Map<string, Set<string>>;
  /** Directory audits: HTML files nobody links to. */
  unlinkedPages?: string[];
}

export function runSiteRules(ctx: SiteContext): Finding[] {
  const out: Finding[] = [];

  const key = (url: string): string =>
    ctx.pathOnly ? pathKey(url) : (normalizeUrl(url) ?? url);

  const pagesByKey = new Map<string, PageRecord>();

  for (const p of ctx.pages) {
    pagesByKey.set(key(p.url), p);
  }

  const checksByKey = new Map<string, LinkCheck>();

  for (const [u, c] of ctx.linkChecks) {
    if (!checksByKey.has(key(u))) {
      checksByKey.set(key(u), c);
    }
  }

  const isIndexable = (p: PageRecord): boolean =>
    !robotsDirectives(p.page, p.response).noindex &&
    (p.response?.status ?? 200) < 400;

  const okPages = ctx.pages.filter((p) => (p.response?.status ?? 200) < 400);

  /* robots.txt */
  if (ctx.robots) {
    if (
      ctx.robots.error ||
      (ctx.robots.status !== null && ctx.robots.status >= 500)
    ) {
      out.push(
        finding(
          m("site.robots-txt-error"),
          `robots.txt at ${ctx.robots.url} could not be read (${ctx.robots.error ?? `HTTP ${ctx.robots.status}`}).`,
          {
            evidence: {
              url: ctx.robots.url,
              status: ctx.robots.status,
              error: ctx.robots.error,
            },
          }
        )
      );
    } else if (!ctx.robots.found) {
      out.push(
        finding(
          m("site.robots-txt-missing"),
          `No robots.txt at ${ctx.robots.url}.`,
          {
            severity: ctx.source === "directory" ? "info" : "warning",
            evidence: { url: ctx.robots.url, status: ctx.robots.status },
          }
        )
      );
    } else if (ctx.robotsAllows && !ctx.robotsAllows(ctx.startUrl)) {
      out.push(
        finding(
          m("site.robots-txt-blocks-all"),
          "robots.txt blocks the start URL for the crawler user agent.",
          {
            evidence: {
              url: ctx.robots.url,
              robotsTxt: ctx.robots.text?.slice(0, 500),
            },
          }
        )
      );
    }
  }

  if (ctx.blockedByRobots.length) {
    out.push(
      finding(
        m("site.robots-blocked-pages"),
        `${ctx.blockedByRobots.length} linked/sitemap URL(s) are disallowed by robots.txt.`,
        {
          evidence: {
            count: ctx.blockedByRobots.length,
            examples: cap(ctx.blockedByRobots),
          },
        }
      )
    );
  }

  /* sitemaps */
  const sitemapKeys = new Set(ctx.sitemaps.urls.map(key));

  if (ctx.sitemaps.errors.length) {
    out.push(
      finding(
        m("site.sitemap-error"),
        `${ctx.sitemaps.errors.length} sitemap problem(s).`,
        { evidence: { errors: cap(ctx.sitemaps.errors) } }
      )
    );
  }

  if (ctx.sitemaps.sources.length === 0 && ctx.sitemaps.errors.length === 0) {
    out.push(
      finding(m("site.sitemap-missing"), "No sitemap was found.", {
        severity: ctx.source === "directory" ? "info" : "warning",
      })
    );
  }

  if (ctx.sitemaps.urlCount > 0) {
    const noindex: string[] = [];
    const nonCanonical: { url: string; canonical: string }[] = [];
    const broken: { url: string; status: number | null }[] = [];
    const redirecting: { url: string; finalUrl: string }[] = [];

    for (const smUrl of ctx.sitemaps.urls) {
      const k = key(smUrl);
      const page = pagesByKey.get(k);

      if (page) {
        if (robotsDirectives(page.page, page.response).noindex) {
          noindex.push(smUrl);
        }

        const canon = page.page.canonical;

        if (canon && key(canon) !== k) {
          nonCanonical.push({ url: smUrl, canonical: canon });
        }
      }

      const check = checksByKey.get(k);

      if (check) {
        if ((check.status ?? 0) >= 400 || check.error) {
          broken.push({ url: smUrl, status: check.status });
        } else if (check.redirectChain.length > 0) {
          redirecting.push({ url: smUrl, finalUrl: check.finalUrl });
        }
      }
    }

    if (noindex.length) {
      out.push(
        finding(
          m("site.sitemap-noindex-page"),
          `${noindex.length} sitemap URL(s) are noindex.`,
          { evidence: { count: noindex.length, examples: cap(noindex) } }
        )
      );
    }

    if (nonCanonical.length) {
      out.push(
        finding(
          m("site.sitemap-non-canonical"),
          `${nonCanonical.length} sitemap URL(s) canonicalise to another URL.`,
          {
            evidence: {
              count: nonCanonical.length,
              examples: cap(nonCanonical),
            },
          }
        )
      );
    }

    if (broken.length) {
      out.push(
        finding(
          m("site.sitemap-broken-url"),
          `${broken.length} sitemap URL(s) return errors.`,
          { evidence: { count: broken.length, examples: cap(broken) } }
        )
      );
    }

    if (redirecting.length) {
      out.push(
        finding(
          m("site.sitemap-redirecting-url"),
          `${redirecting.length} sitemap URL(s) redirect.`,
          {
            evidence: { count: redirecting.length, examples: cap(redirecting) },
          }
        )
      );
    }

    const notInSitemap = okPages
      .filter(
        (p) =>
          isIndexable(p) &&
          !sitemapKeys.has(key(p.url)) &&
          (!p.page.canonical || key(p.page.canonical) === key(p.url))
      )
      .map((p) => p.url);

    if (notInSitemap.length) {
      out.push(
        finding(
          m("site.not-in-sitemap"),
          `${notInSitemap.length} crawled indexable page(s) are missing from the sitemap.`,
          {
            evidence: {
              count: notInSitemap.length,
              examples: cap(notInSitemap),
            },
          }
        )
      );
    }

    if (!ctx.crawl.hitPageLimit) {
      const linked = new Set<string>();

      for (const target of ctx.linkSources.keys()) {
        linked.add(key(target));
      }

      linked.add(key(ctx.startUrl));
      const orphans = ctx.sitemaps.urls.filter((u) => !linked.has(key(u)));

      if (orphans.length) {
        out.push(
          finding(
            m("site.orphan-pages"),
            `${orphans.length} sitemap URL(s) are not linked from any crawled page.`,
            { evidence: { count: orphans.length, examples: cap(orphans) } }
          )
        );
      }
    }
  }

  /* link health */
  const broken: {
    url: string;
    status: number | null;
    error?: string;
    linkedFrom: string[];
  }[] = [];

  const redirected: {
    url: string;
    finalUrl: string;
    status: number;
    linkedFrom: string[];
  }[] = [];

  const chains: { url: string; hops: number; finalUrl: string }[] = [];

  for (const [k, check] of ctx.linkChecks) {
    const sources = [...(ctx.linkSources.get(k) ?? [])];

    if (sources.length === 0) {
      continue;
    }

    if (check.error || (check.status ?? 0) >= 400) {
      broken.push({
        url: check.url,
        status: check.status,
        error: check.error,
        linkedFrom: cap(sources, 3),
      });
    } else if (check.redirectChain.length >= 2) {
      chains.push({
        url: check.url,
        hops: check.redirectChain.length,
        finalUrl: check.finalUrl,
      });
    } else if (check.redirectChain.length === 1) {
      redirected.push({
        url: check.url,
        finalUrl: check.finalUrl,
        status: check.redirectChain[0]!.status,
        linkedFrom: cap(sources, 3),
      });
    }
  }

  if (broken.length) {
    out.push(
      finding(
        m("site.broken-internal-links"),
        `${broken.length} internal link target(s) are broken.`,
        { evidence: { count: broken.length, examples: cap(broken, 20) } }
      )
    );
  }

  if (redirected.length) {
    out.push(
      finding(
        m("site.redirected-internal-links"),
        `${redirected.length} internal link target(s) redirect.`,
        {
          evidence: { count: redirected.length, examples: cap(redirected, 20) },
        }
      )
    );
  }

  if (chains.length) {
    out.push(
      finding(
        m("site.redirect-chains"),
        `${chains.length} internal URL(s) have redirect chains.`,
        { evidence: { count: chains.length, examples: cap(chains) } }
      )
    );
  }

  if (ctx.externalChecks) {
    const dead: {
      url: string;
      status: number | null;
      error?: string;
      linkedFrom: string[];
    }[] = [];

    for (const [u, check] of ctx.externalChecks) {
      if (check.error || (check.status ?? 0) >= 400) {
        dead.push({
          url: u,
          status: check.status,
          error: check.error,
          linkedFrom: cap([...(ctx.externalSources?.get(u) ?? [])], 3),
        });
      }
    }

    if (dead.length) {
      out.push(
        finding(
          m("site.broken-external-links"),
          `${dead.length} external link target(s) are broken.`,
          { evidence: { count: dead.length, examples: cap(dead, 20) } }
        )
      );
    }
  }

  if (ctx.unlinkedPages?.length) {
    out.push(
      finding(
        m("site.unlinked-pages"),
        `${ctx.unlinkedPages.length} HTML file(s) are not linked from any other page.`,
        {
          evidence: {
            count: ctx.unlinkedPages.length,
            examples: cap(ctx.unlinkedPages),
          },
        }
      )
    );
  }

  /* duplicates */
  const indexable = okPages.filter(isIndexable);
  pushDuplicates(
    out,
    m("site.duplicate-titles"),
    indexable,
    (p) => p.page.title,
    "title"
  );
  pushDuplicates(
    out,
    m("site.duplicate-descriptions"),
    indexable,
    (p) => p.page.metaDescription,
    "meta description"
  );
  pushDuplicates(
    out,
    m("site.duplicate-h1"),
    indexable,
    (p) => p.page.h1s[0] ?? null,
    "H1"
  );
  pushDuplicateContent(out, indexable);

  /* architecture */
  const deep = okPages.filter((p) => p.depth > ctx.thresholds.deepPageDepth);

  if (deep.length) {
    out.push(
      finding(
        m("site.deep-pages"),
        `${deep.length} page(s) are more than ${ctx.thresholds.deepPageDepth} clicks from the start URL.`,
        {
          evidence: {
            count: deep.length,
            examples: cap(deep.map((p) => ({ url: p.url, depth: p.depth }))),
          },
        }
      )
    );
  }

  /* probes */
  if (
    ctx.probes.soft404 &&
    ctx.probes.soft404.status !== null &&
    ctx.probes.soft404.status < 400
  ) {
    out.push(
      finding(
        m("site.soft-404"),
        `${ctx.probes.soft404.url} returned HTTP ${ctx.probes.soft404.status}.`,
        { evidence: ctx.probes.soft404 }
      )
    );
  }

  if (
    ctx.probes.httpRedirect &&
    ctx.probes.httpRedirect.status !== null &&
    !ctx.probes.httpRedirect.redirectsToHttps
  ) {
    out.push(
      finding(
        m("site.http-not-redirected"),
        `${ctx.probes.httpRedirect.url} returned HTTP ${ctx.probes.httpRedirect.status} without redirecting to https.`,
        { evidence: ctx.probes.httpRedirect }
      )
    );
  }

  if (
    ctx.probes.hostVariant &&
    ctx.probes.hostVariant.status !== null &&
    !ctx.probes.hostVariant.redirectsToMain
  ) {
    out.push(
      finding(
        m("site.host-variant-not-redirected"),
        `${ctx.probes.hostVariant.url} returned HTTP ${ctx.probes.hostVariant.status} without redirecting to the main host.`,
        { evidence: ctx.probes.hostVariant }
      )
    );
  }

  /* hreflang return links */
  const missingReturn: { page: string; alternate: string }[] = [];

  for (const p of ctx.pages) {
    for (const alt of p.page.hreflang) {
      if (!alt.url) {
        continue;
      }

      const target = pagesByKey.get(key(alt.url));

      if (!target || target === p) {
        continue;
      }

      const linksBack = target.page.hreflang.some(
        (h) => h.url && key(h.url) === key(p.url)
      );

      if (!linksBack) {
        missingReturn.push({ page: p.url, alternate: alt.url });
      }
    }
  }

  if (missingReturn.length) {
    out.push(
      finding(
        m("site.hreflang-no-return-link"),
        `${missingReturn.length} hreflang alternate(s) do not link back.`,
        {
          evidence: {
            count: missingReturn.length,
            examples: cap(missingReturn),
          },
        }
      )
    );
  }

  if (ctx.crawl.hitPageLimit) {
    out.push(
      finding(
        m("site.crawl-limit-reached"),
        `Crawl stopped after ${ctx.crawl.pagesCrawled} pages (limit ${ctx.crawl.maxPages}); ${ctx.crawl.pagesDiscovered} URLs were discovered.`,
        {
          evidence: {
            pagesCrawled: ctx.crawl.pagesCrawled,
            pagesDiscovered: ctx.crawl.pagesDiscovered,
            maxPages: ctx.crawl.maxPages,
          },
        }
      )
    );
  }

  return out;
}

function pathKey(url: string): string {
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return url;
  }
}

function pushDuplicates(
  out: Finding[],
  rule: RuleMeta,
  pages: PageRecord[],
  pick: (p: PageRecord) => string | null,
  label: string
): void {
  const groups = new Map<string, string[]>();

  for (const p of pages) {
    const value = pick(p);

    if (!value) {
      continue;
    }

    const k = normalizeForComparison(value);

    if (!groups.has(k)) {
      groups.set(k, []);
    }

    groups.get(k)!.push(p.url);
  }

  const dupes = [...groups.entries()].filter(([, urls]) => urls.length > 1);

  if (!dupes.length) {
    return;
  }

  const pagesAffected = dupes.reduce((n, [, urls]) => n + urls.length, 0);
  out.push(
    finding(
      rule,
      `${dupes.length} ${label}(s) are shared by ${pagesAffected} pages.`,
      {
        evidence: {
          groups: cap(
            dupes.map(([value, urls]) => ({
              value: value.slice(0, 120),
              pages: cap(urls, 5),
              count: urls.length,
            }))
          ),
        },
      }
    )
  );
}

function pushDuplicateContent(out: Finding[], pages: PageRecord[]): void {
  const candidates = pages.filter((p) => p.page.wordCount >= 50);
  const groups: { pages: string[]; similarity: number }[] = [];
  const exact = new Map<string, string[]>();

  for (const p of candidates) {
    const k = normalizeForComparison(p.page.text);

    if (!exact.has(k)) {
      exact.set(k, []);
    }

    exact.get(k)!.push(p.url);
  }

  const seen = new Set<string>();

  for (const urls of exact.values()) {
    if (urls.length > 1) {
      groups.push({ pages: urls, similarity: 1 });
      urls.forEach((u) => seen.add(u));
    }
  }

  if (candidates.length <= 150) {
    const sets = candidates.map((p) => ({
      url: p.url,
      set: shingles(p.page.text),
    }));

    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i]!;
        const b = sets[j]!;

        if (seen.has(a.url) && seen.has(b.url)) {
          continue;
        }

        const sim = jaccard(a.set, b.set);

        if (sim >= 0.9) {
          groups.push({
            pages: [a.url, b.url],
            similarity: Number(sim.toFixed(2)),
          });
          seen.add(a.url);
          seen.add(b.url);
        }
      }
    }
  }

  if (groups.length) {
    out.push(
      finding(
        m("site.duplicate-content"),
        `${groups.length} group(s) of pages have (near-)identical body text.`,
        { evidence: { groups: cap(groups) } }
      )
    );
  }
}
