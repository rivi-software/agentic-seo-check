import { normalizeForComparison, shingles, jaccard } from "./html/text.js";
import { agentMatcher } from "./robots.js";
import { robotsDirectives } from "./rules/indexing.js";
import { finding, GOOGLE_DOCS, cap } from "./rules/rule.js";
import { MIN_COMPARABLE_WORDS, SAME_TEXT } from "./site-probes.js";
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
import { normalizeUrl, normalizePath, trimTrailingSlashes } from "./url.js";

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
    "site.robots-txt-too-large",
    "warning",
    "robots.txt is larger than 500 KiB; Google ignores everything after the first 500 KiB.",
    "Shorten robots.txt: group paths under shared prefixes, use wildcards (Disallow: /*?sort=) instead of listing URLs one by one, and remove rules for paths that no longer exist.",
    "https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec"
  ),
  meta(
    "site.robots-txt-unsupported-rule",
    "warning",
    "robots.txt uses rules Google does not support: noindex or nofollow lines (retired in 2019, so the pages stay indexable; warning) or crawl-delay (Google ignores it, Bing reads it; info).",
    "Remove noindex: and nofollow: lines and use a robots meta tag or X-Robots-Tag header on the pages instead. Crawl-delay may stay for Bing and other crawlers; Google sets its crawl rate itself.",
    "https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec"
  ),
  meta(
    "site.robots-blocks-resources",
    "warning",
    "robots.txt keeps Googlebot from scripts or stylesheets the pages load, so Google renders the pages without them.",
    "Allow the CSS and JavaScript files pages need (Allow: /assets/, or remove the Disallow line for that folder). Keep blocking only what pages do not need to render.",
    "https://developers.google.com/search/docs/crawling-indexing/robots/intro"
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
    "site.sitemap-too-large",
    "error",
    "A sitemap holds more than 50,000 URLs or more than 50 MB uncompressed, which search engines do not read (error); or it is larger than the 15 MB this audit reads, so it was not checked (info).",
    "Split the sitemap into files of at most 50,000 URLs and 50 MB each, and list them in a sitemap index.",
    "https://developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps"
  ),
  meta(
    "site.sitemap-index-nested",
    "warning",
    "A sitemap index lists another sitemap index; Google reads only sitemaps from an index, not further indexes.",
    "List every sitemap file directly in one sitemap index (up to 50,000), or submit each index separately in Search Console.",
    "https://developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps"
  ),
  meta(
    "site.sitemap-lastmod-invalid",
    "warning",
    "Sitemap <lastmod> values are not in W3C Datetime format, so search engines ignore them.",
    "Write <lastmod> as a date (2026-11-09) or a date and time with its time zone (2026-11-09T10:00:00+01:00).",
    "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap"
  ),
  meta(
    "site.sitemap-lastmod-future",
    "info",
    "Sitemap <lastmod> values lie in the future. Google uses lastmod only when it is consistently accurate.",
    "Set <lastmod> to when the page's content last changed, not to the build time plus an offset or a publish date to come.",
    "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap"
  ),
  meta(
    "site.sitemap-other-host",
    "info",
    "The site's sitemaps list URLs on other hosts. Google accepts them only for hosts verified in Search Console or whose own robots.txt names the sitemap.",
    "List each host's URLs in a sitemap that host's robots.txt names. If the URLs use another domain by mistake (a staging or old domain), generate them from the production site URL.",
    "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap"
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
    "site.canonical-target-broken",
    "error",
    "Pages name a canonical URL that answers 4xx/5xx or does not load, so search engines cannot use it.",
    "Point the canonical at the live URL of the preferred page, usually the page itself. Canonicals built from a route pattern often miss a trailing slash or a locale prefix.",
    GOOGLE_DOCS.canonical
  ),
  meta(
    "site.canonical-target-redirects",
    "warning",
    "Pages name a canonical URL that redirects; the canonical should be the final URL.",
    "Write the URL the redirect ends at in the canonical: the same scheme, host, trailing slash and case the server answers with.",
    GOOGLE_DOCS.canonical
  ),
  meta(
    "site.canonical-target-noindex",
    "warning",
    "Pages name as canonical a page that is set to noindex, so the page meant to be indexed is kept out of the index.",
    "Remove noindex from the canonical page, or point the canonical somewhere indexable. If both pages should stay out of search results, use noindex on both and drop the canonical.",
    GOOGLE_DOCS.canonical
  ),
  meta(
    "site.canonical-chain",
    "warning",
    "A page's canonical points to a page whose own canonical points somewhere else (A to B to C).",
    "Point every page's canonical straight at the final preferred URL.",
    GOOGLE_DOCS.canonical
  ),
  meta(
    "site.links-to-noindex",
    "info",
    "Pages set to noindex are linked from other pages of the site. A noindex page that much of the site links to is often noindex by mistake. Cart, search, login and account pages are left out.",
    "Check that each listed page should stay out of search results. If the noindex is deliberate (login, cart, internal search), leave it; otherwise remove the noindex.",
    GOOGLE_DOCS.robotsMeta
  ),
  meta(
    "site.hreflang-target-invalid",
    "warning",
    "hreflang alternates point to URLs that are broken, redirect, are noindex or name another URL as canonical, so the annotation is ignored.",
    "List only the canonical, indexable URL of each language version in hreflang: the final URL, not one that redirects.",
    GOOGLE_DOCS.hreflang
  ),
  meta(
    "site.url-variant-duplicate",
    "warning",
    "A page also answers 200 at its URL with the trailing slash added or removed, or with the path in another case, without redirecting or naming the page as canonical. Google treats each spelling as a separate URL.",
    "Redirect (301) the other spelling to the page's URL in the server, framework or CDN (trailingSlash in Next.js, Nuxt and Astro configs; a lowercase rewrite on case-insensitive servers), or at least give every spelling a canonical to the one URL.",
    GOOGLE_DOCS.urlStructure
  ),
  meta(
    "site.parameter-duplicates",
    "warning",
    "Crawled URLs that differ only in their query string show the same text, and none names one of them as canonical.",
    "Give the parameter versions a canonical to the URL without the parameter (or the one you want indexed), and link to that URL. Parameters that change nothing visible (session, sort order of one item, view=) should not reach links at all.",
    GOOGLE_DOCS.canonical
  ),
  meta(
    "site.broken-images",
    "warning",
    "Images on the pages point to URLs that answer 4xx/5xx or do not load.",
    "Fix the image URLs listed in evidence, or upload the missing files. Each entry names the pages that show the image.",
    GOOGLE_DOCS.images
  ),
  meta(
    "site.crawl-limit-reached",
    "info",
    "The crawl stopped at the page limit, so site-wide checks (orphans, duplicates, sitemap coverage) are partial.",
    "Re-run with a higher maxPages value for a complete picture."
  ),
];

const byId = new Map(SITE_RULES.map((r) => [r.id, r]));

const m = (id: string): RuleMeta => {
  const rule = byId.get(id);

  if (!rule) {
    throw new Error(`Unknown site rule: ${id}`);
  }

  return rule;
};

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

/** A crawled page requested again with its trailing slash toggled, or with its path in uppercase. */
export interface UrlVariantProbe {
  kind: "trailing-slash" | "case";
  /** The crawled page. */
  url: string;
  variant: string;
  status: number | null;
  /** The canonical the variant names, when it answered with a page. */
  canonical: string | null;
  /** The variant answered 200 itself and names no canonical that points back to the page. */
  duplicate: boolean;
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
  urlVariants?: UrlVariantProbe[];
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
  /** robots.txt up to 500 KiB, for checks per user agent (`robots.text` stops at 20,000 characters). */
  robotsText?: string | null;
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
  /** Image URLs the pages show that were requested (or looked up as files), keyed by URL. */
  imageChecks?: Map<string, LinkCheck>;
  imageSources?: Map<string, Set<string>>;
}

/** Appends `value` to the list under `k`, starting the list when there is none. */
const pushTo = (
  groups: Map<string, string[]>,
  k: string,
  value: string
): void => {
  const list = groups.get(k);

  if (list) {
    list.push(value);
  } else {
    groups.set(k, [value]);
  }
};

const pathKey = (url: string): string => {
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return url;
  }
};

const pushDuplicates = (
  out: Finding[],
  rule: RuleMeta,
  pages: PageRecord[],
  pick: (p: PageRecord) => string | null,
  label: string
): void => {
  const groups = new Map<string, string[]>();

  for (const p of pages) {
    const value = pick(p);

    if (!value) {
      continue;
    }

    const k = normalizeForComparison(value);

    pushTo(groups, k, p.url);
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
};

const pushDuplicateContent = (out: Finding[], pages: PageRecord[]): void => {
  const candidates = pages.filter((p) => p.page.wordCount >= 50);
  const groups: { pages: string[]; similarity: number }[] = [];
  const exact = new Map<string, string[]>();

  for (const p of candidates) {
    const k = normalizeForComparison(p.page.text);

    pushTo(exact, k, p.url);
  }

  const seen = new Set<string>();

  for (const urls of exact.values()) {
    if (urls.length > 1) {
      groups.push({ pages: urls, similarity: 1 });

      for (const u of urls) {
        seen.add(u);
      }
    }
  }

  if (candidates.length <= 150) {
    const sets = candidates.map((p) => ({
      url: p.url,
      set: shingles(p.page.text),
    }));

    for (const [i, a] of sets.entries()) {
      for (const b of sets.slice(i + 1)) {
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
};

/** The lookups that the sections of the site rules share. */
interface SiteScope {
  ctx: SiteContext;
  key: (url: string) => string;
  pagesByKey: Map<string, PageRecord>;
  checksByKey: Map<string, LinkCheck>;
  /** Pages that answered below 400. */
  okPages: PageRecord[];
  isIndexable: (p: PageRecord) => boolean;
}

/** Google reads the first 500 KiB of robots.txt and ignores the rest. */
const ROBOTS_MAX_BYTES = 512_000;

/** Lines of robots.txt whose field Google does not support, by what that costs. */
interface UnsupportedRobotsLines {
  /** noindex: and nofollow: lines, which Google stopped reading in 2019. */
  retired: string[];
  crawlDelay: string[];
}

const unsupportedRobotsLines = (text: string): UnsupportedRobotsLines => {
  const retired: string[] = [];
  const crawlDelay: string[] = [];

  for (const [i, raw] of text.split(/\r?\n/u).slice(0, 50_000).entries()) {
    const line = raw.replace(/#.*$/u, "").trim();

    const field = /^(?<field>[a-z-]+)\s*:/iu
      .exec(line)
      ?.groups?.field?.toLowerCase();

    if (field === "noindex" || field === "nofollow") {
      retired.push(`line ${i + 1}: ${line.slice(0, 120)}`);
    } else if (field === "crawl-delay") {
      crawlDelay.push(`line ${i + 1}: ${line.slice(0, 120)}`);
    }
  }

  return { retired, crawlDelay };
};

/** robots.txt's size and the rules in it Google does not support. */
const robotsContentFindings = (ctx: SiteContext): Finding[] => {
  const out: Finding[] = [];
  const bytes = ctx.robots?.bytes ?? 0;

  if (bytes > ROBOTS_MAX_BYTES) {
    out.push(
      finding(
        m("site.robots-txt-too-large"),
        `robots.txt is ${Math.round(bytes / 1024)} KiB; Google reads only the first 500 KiB.`,
        { evidence: { url: ctx.robots?.url, bytes } }
      )
    );
  }

  const text = ctx.robotsText ?? ctx.robots?.text;

  if (!text) {
    return out;
  }

  const { retired, crawlDelay } = unsupportedRobotsLines(text);

  if (retired.length > 0 || crawlDelay.length > 0) {
    out.push(
      finding(
        m("site.robots-txt-unsupported-rule"),
        retired.length > 0
          ? `robots.txt has ${retired.length} noindex or nofollow line(s), which Google stopped reading in 2019.`
          : `robots.txt sets crawl-delay, which Google ignores.`,
        {
          severity: retired.length > 0 ? "warning" : "info",
          evidence: {
            url: ctx.robots?.url,
            retired: cap(retired),
            crawlDelay: cap(crawlDelay),
          },
        }
      )
    );
  }

  return out;
};

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** Scripts and stylesheets on the site's own origin that robots.txt keeps Googlebot from. */
const blockedResourceFindings = ({
  ctx,
  okPages,
  isIndexable,
}: SiteScope): Finding[] => {
  const { robots, robotsText: text } = ctx;

  if (!robots?.found || !text) {
    return [];
  }

  const origin = originOf(robots.url);

  if (!origin) {
    return [];
  }

  const allowed = agentMatcher(robots.url, text);
  const verdicts = new Map<string, boolean>();
  const blocked = new Map<string, Set<string>>();

  // Only pages meant for search: Google need not render a noindex checkout or account page.
  for (const p of okPages.filter(isIndexable)) {
    for (const r of p.page.resources) {
      if (r.kind !== "script" && r.kind !== "stylesheet") {
        continue;
      }

      // This robots.txt has no say over files on a CDN or another host.
      if (originOf(r.url) !== origin) {
        continue;
      }

      let ok = verdicts.get(r.url);

      if (ok === undefined) {
        ok = allowed(r.url, "Googlebot");
        verdicts.set(r.url, ok);
      }

      if (!ok) {
        const pages = blocked.get(r.url) ?? new Set<string>();
        pages.add(p.url);
        blocked.set(r.url, pages);
      }
    }
  }

  const list = [...blocked]
    .map(([url, pages]) => ({ url, pages: pages.size }))
    .toSorted((a, b) => b.pages - a.pages);

  return list.length > 0
    ? [
        finding(
          m("site.robots-blocks-resources"),
          `robots.txt keeps Googlebot from ${list.length} script(s) or stylesheet(s) the pages load.`,
          { evidence: { count: list.length, examples: cap(list) } }
        ),
      ]
    : [];
};

/** Sitemaps over the protocol's limits, nested indexes, bad lastmod values and other hosts. */
const sitemapProtocolFindings = (ctx: SiteContext): Finding[] => {
  const { problems } = ctx.sitemaps;
  const out: Finding[] = [];
  const over = problems.oversized.filter((o) => o.overLimit);
  const unread = problems.oversized.filter((o) => !o.overLimit);

  if (over.length > 0) {
    out.push(
      finding(
        m("site.sitemap-too-large"),
        `${over.length} sitemap(s) exceed 50,000 URLs or 50 MB.`,
        { evidence: { sitemaps: cap(over) } }
      )
    );
  }

  if (unread.length > 0) {
    out.push(
      finding(
        m("site.sitemap-too-large"),
        `${unread.length} sitemap(s) are larger than the 15 MB this audit reads, so their URLs were not checked.`,
        {
          severity: "info",
          recommendation:
            "Check that each stays under 50 MB and 50,000 URLs; smaller sitemaps (10,000 URLs or fewer) are also quicker for search engines to fetch again.",
          evidence: { sitemaps: cap(unread) },
        }
      )
    );
  }

  if (problems.nestedIndexes.length > 0) {
    out.push(
      finding(
        m("site.sitemap-index-nested"),
        `${problems.nestedIndexes.length} sitemap index(es) are listed by another sitemap index.`,
        { evidence: { indexes: cap(problems.nestedIndexes) } }
      )
    );
  }

  const examples = [
    [
      "site.sitemap-lastmod-invalid",
      problems.invalidLastmod,
      "have a <lastmod> that is not a W3C Datetime",
    ],
    [
      "site.sitemap-lastmod-future",
      problems.futureLastmod,
      "have a <lastmod> in the future",
    ],
    [
      "site.sitemap-other-host",
      problems.otherHost,
      "are on another host than the site",
    ],
  ] as const;

  for (const [id, list, label] of examples) {
    if (list.count > 0) {
      out.push(
        finding(m(id), `${list.count} sitemap URL(s) ${label}.`, {
          evidence: { count: list.count, examples: list.examples },
        })
      );
    }
  }

  return out;
};

const robotsFindings = (ctx: SiteContext): Finding[] => {
  const out: Finding[] = [];

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

  return out;
};

/** Noindex, non-canonical, broken and redirecting URLs listed in the sitemap. */
const sitemapUrlFindings = ({
  ctx,
  key,
  pagesByKey,
  checksByKey,
}: SiteScope): Finding[] => {
  const out: Finding[] = [];

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

  return out;
};

/** Indexable pages missing from the sitemap, and sitemap URLs nothing links to. */
const sitemapCoverageFindings = ({
  ctx,
  key,
  okPages,
  isIndexable,
}: SiteScope): Finding[] => {
  const out: Finding[] = [];
  const sitemapKeys = new Set(ctx.sitemaps.urls.map(key));

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

  return out;
};

const sitemapFindings = (scope: SiteScope): Finding[] => {
  const { ctx } = scope;
  const out: Finding[] = [];

  if (ctx.sitemaps.errors.length) {
    out.push(
      finding(
        m("site.sitemap-error"),
        `${ctx.sitemaps.errors.length} sitemap problem(s).`,
        { evidence: { errors: cap(ctx.sitemaps.errors) } }
      )
    );
  }

  // A sitemap too large to read was still found.
  if (
    ctx.sitemaps.sources.length === 0 &&
    ctx.sitemaps.errors.length === 0 &&
    ctx.sitemaps.problems.oversized.length === 0
  ) {
    out.push(
      finding(m("site.sitemap-missing"), "No sitemap was found.", {
        severity: ctx.source === "directory" ? "info" : "warning",
      })
    );
  }

  if (ctx.sitemaps.urlCount > 0) {
    out.push(...sitemapUrlFindings(scope), ...sitemapCoverageFindings(scope));
  }

  return out;
};

/** Internal link targets that are broken, redirect once, or redirect in a chain. */
const linkHealthFindings = (ctx: SiteContext): Finding[] => {
  const out: Finding[] = [];

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

    // Chains of two or more hops are handled first, so a first hop here is the only one.
    const [firstHop] = check.redirectChain;

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
    } else if (firstHop) {
      redirected.push({
        url: check.url,
        finalUrl: check.finalUrl,
        status: firstHop.status,
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

  return out;
};

/** Broken external links (when they were probed) and HTML files nothing links to. */
const unreachedFindings = (ctx: SiteContext): Finding[] => {
  const out: Finding[] = [];

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

  return out;
};

const duplicateFindings = ({
  key,
  okPages,
  isIndexable,
}: SiteScope): Finding[] => {
  const out: Finding[] = [];

  // Pages that name another URL as canonical are consolidated already; only the canonical ones compete.
  const indexable = okPages.filter(
    (p) =>
      isIndexable(p) &&
      (!p.page.canonical || key(p.page.canonical) === key(p.url))
  );

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

  return out;
};

/** Pages deep in the site, and how the server answers a made-up URL and the other host names. */
const architectureFindings = ({ ctx, okPages }: SiteScope): Finding[] => {
  const out: Finding[] = [];

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

  return out;
};

const hreflangFindings = ({ ctx, key, pagesByKey }: SiteScope): Finding[] => {
  const out: Finding[] = [];

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
};

interface TargetProblem {
  kind: "broken" | "redirects" | "noindex" | "canonical";
  detail: string;
}

interface CanonicalIssue {
  page: string;
  canonical: string;
  problem: string;
}

/** What is wrong with a URL that metadata (a canonical, an hreflang link) points to, or null. */
const targetProblem = (
  { key, pagesByKey, checksByKey, isIndexable }: SiteScope,
  url: string
): TargetProblem | null => {
  const check = checksByKey.get(key(url));

  if (check && (check.error || (check.status ?? 0) >= 400)) {
    return {
      kind: "broken",
      detail: check.error ?? `HTTP ${check.status}`,
    };
  }

  if (check && check.redirectChain.length > 0) {
    return { kind: "redirects", detail: `redirects to ${check.finalUrl}` };
  }

  const target = pagesByKey.get(key(url));

  if (!target) {
    return null;
  }

  if (!isIndexable(target)) {
    return { kind: "noindex", detail: "is noindex" };
  }

  const { canonical } = target.page;

  return canonical && key(canonical) !== key(target.url)
    ? { kind: "canonical", detail: `names ${canonical} as canonical` }
    : null;
};

/** Canonicals that point at broken, redirecting, noindex or re-canonicalized URLs. */
const canonicalGraphFindings = (scope: SiteScope): Finding[] => {
  const { key, okPages, isIndexable } = scope;

  const groups: Record<TargetProblem["kind"], CanonicalIssue[]> = {
    broken: [],
    redirects: [],
    noindex: [],
    canonical: [],
  };

  for (const p of okPages) {
    const { canonical } = p.page;

    // A noindex page's canonical carries no weight; the noindex wins.
    if (!canonical || key(canonical) === key(p.url) || !isIndexable(p)) {
      continue;
    }

    const problem = targetProblem(scope, canonical);

    if (problem) {
      groups[problem.kind].push({
        page: p.url,
        canonical,
        problem: problem.detail,
      });
    }
  }

  const rules = [
    [
      "broken",
      "site.canonical-target-broken",
      "name a canonical URL that is broken",
    ],
    [
      "redirects",
      "site.canonical-target-redirects",
      "name a canonical URL that redirects",
    ],
    [
      "noindex",
      "site.canonical-target-noindex",
      "name a noindex page as canonical",
    ],
    [
      "canonical",
      "site.canonical-chain",
      "name a canonical whose own canonical points elsewhere",
    ],
  ] as const;

  return rules.flatMap(([kind, id, label]) => {
    const list = groups[kind];

    return list.length > 0
      ? [
          finding(m(id), `${list.length} page(s) ${label}.`, {
            evidence: { count: list.length, examples: cap(list) },
          }),
        ]
      : [];
  });
};

/** Pages a site keeps out of search results on purpose: cart, checkout, search, login, account. */
const UTILITY_PATH =
  /(?:^|\/)(?:cart|bag|basket|checkout|winkelwagen|search|zoeken|suche|login|log-in|signin|sign-in|logout|inloggen|account|my-account|register|signup|sign-up|wishlist|favorites|favourites)(?:[/.?]|$)/iu;

const isUtilityPage = (url: string): boolean => {
  try {
    return UTILITY_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** Noindex pages that other pages of the site link to, most linked first. */
const noindexLinkFindings = ({
  ctx,
  key,
  okPages,
  isIndexable,
}: SiteScope): Finding[] => {
  const linkedFrom = new Map<string, Set<string>>();

  for (const [target, sources] of ctx.linkSources) {
    const k = key(target);
    const set = linkedFrom.get(k) ?? new Set<string>();

    for (const source of sources) {
      if (key(source) !== k) {
        set.add(source);
      }
    }

    linkedFrom.set(k, set);
  }

  const linked = okPages
    .filter((p) => !isIndexable(p) && !isUtilityPage(p.url))
    .map((p) => ({
      url: p.url,
      linkedFrom: linkedFrom.get(key(p.url))?.size ?? 0,
    }))
    .filter((p) => p.linkedFrom > 0)
    .toSorted((a, b) => b.linkedFrom - a.linkedFrom);

  return linked.length > 0
    ? [
        finding(
          m("site.links-to-noindex"),
          `${linked.length} noindex page(s) are linked from other pages; the most linked: ${linked[0]?.url} (${linked[0]?.linkedFrom} pages).`,
          { evidence: { count: linked.length, pages: cap(linked) } }
        ),
      ]
    : [];
};

/** hreflang alternates that are broken, redirect, are noindex or canonicalize elsewhere. */
const hreflangTargetFindings = (scope: SiteScope): Finding[] => {
  const { key, okPages } = scope;

  const invalid: {
    page: string;
    hreflang: string;
    alternate: string;
    problem: string;
  }[] = [];

  const seen = new Set<string>();

  for (const p of okPages) {
    for (const alt of p.page.hreflang) {
      if (!alt.url || key(alt.url) === key(p.url)) {
        continue;
      }

      const problem = targetProblem(scope, alt.url);
      const id = `${key(p.url)} ${key(alt.url)}`;

      // Google documents x-default for a page that redirects each visitor to their language.
      const languageRedirect =
        alt.lang.toLowerCase() === "x-default" && problem?.kind === "redirects";

      if (problem && !languageRedirect && !seen.has(id)) {
        seen.add(id);
        invalid.push({
          page: p.url,
          hreflang: alt.lang,
          alternate: alt.url,
          problem: problem.detail,
        });
      }
    }
  }

  return invalid.length > 0
    ? [
        finding(
          m("site.hreflang-target-invalid"),
          `${invalid.length} hreflang alternate(s) point to URLs that are broken, redirect, are noindex or are not canonical.`,
          { evidence: { count: invalid.length, examples: cap(invalid) } }
        ),
      ]
    : [];
};

/** The URL with its path lower-cased and trailing slashes dropped: one key for every spelling. */
const spellingKey = (url: string): string => {
  try {
    const u = new URL(url);
    const pathname = trimTrailingSlashes(u.pathname.toLowerCase()) || "/";

    return `${u.origin}${pathname}${u.search}`;
  } catch {
    return url;
  }
};

const pathnameOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** How two spellings of one URL differ: only in the path's trailing slash, or in its letter case. */
const spellingDifference = (a: string, b: string): UrlVariantProbe["kind"] =>
  trimTrailingSlashes(pathnameOf(a)) === trimTrailingSlashes(pathnameOf(b))
    ? "trailing-slash"
    : "case";

/** Pages the crawl reached under two spellings of one URL, both answering as a canonical page. */
const crawledVariants = ({
  ctx,
  key,
  okPages,
  isIndexable,
}: SiteScope): UrlVariantProbe[] => {
  if (ctx.pathOnly) {
    return [];
  }

  const groups = new Map<string, PageRecord[]>();

  for (const p of okPages) {
    if (
      isIndexable(p) &&
      p.page.wordCount >= MIN_COMPARABLE_WORDS &&
      (!p.page.canonical || key(p.page.canonical) === key(p.url))
    ) {
      const k = spellingKey(p.url);
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
  }

  return [...groups.values()].flatMap(([first, ...rest]) =>
    first
      ? rest
          .filter(
            (other) =>
              jaccard(shingles(first.page.text), shingles(other.page.text)) >=
              SAME_TEXT
          )
          .map((other) => ({
            kind: spellingDifference(first.url, other.url),
            url: first.url,
            variant: other.url,
            status: other.response?.status ?? null,
            canonical: other.page.canonical,
            duplicate: true,
          }))
      : []
  );
};

/** Slash and case variants of crawled pages that the server answers as pages of their own. */
const urlVariantFindings = (scope: SiteScope): Finding[] => {
  const probed = (scope.ctx.probes.urlVariants ?? []).filter(
    (v) => v.duplicate
  );

  const seen = new Set(probed.map((v) => spellingKey(v.variant)));

  const duplicates = [
    ...probed,
    ...crawledVariants(scope).filter((v) => !seen.has(spellingKey(v.variant))),
  ];

  if (duplicates.length === 0) {
    return [];
  }

  const kinds = [...new Set(duplicates.map((d) => d.kind))];

  return [
    finding(
      m("site.url-variant-duplicate"),
      `${duplicates.length} page(s) also answer at a ${kinds.join(" and a ")} variant of their URL.`,
      {
        evidence: {
          count: duplicates.length,
          examples: cap(
            duplicates.map(({ kind, url, variant, canonical }) => ({
              kind,
              url,
              variant,
              canonical,
            }))
          ),
        },
      }
    ),
  ];
};

const withoutQuery = (url: string): string => {
  try {
    const u = new URL(url);

    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};

/** Pages that differ only in their query string, show the same text and do not consolidate. */
const parameterDuplicateFindings = ({
  key,
  okPages,
  isIndexable,
}: SiteScope): Finding[] => {
  const byPath = new Map<string, PageRecord[]>();

  for (const p of okPages) {
    const { canonical } = p.page;

    // A page whose canonical points elsewhere has already said which URL to index, and a page
    // with almost no text in its HTML (rendered by JavaScript) gives nothing to compare.
    if (
      !isIndexable(p) ||
      (canonical && key(canonical) !== key(p.url)) ||
      p.page.wordCount < MIN_COMPARABLE_WORDS
    ) {
      continue;
    }

    const path = withoutQuery(p.url);
    byPath.set(path, [...(byPath.get(path) ?? []), p]);
  }

  const groups: { path: string; urls: string[]; similarity: number }[] = [];

  for (const [path, pages] of byPath) {
    if (pages.length < 2 || !pages.some((p) => p.url.includes("?"))) {
      continue;
    }

    const [first, ...rest] = pages;

    if (!first) {
      continue;
    }

    const base = shingles(first.page.text);

    const same = rest.flatMap((p) => {
      const similarity = jaccard(base, shingles(p.page.text));

      return similarity >= SAME_TEXT ? [{ url: p.url, similarity }] : [];
    });

    if (same.length > 0) {
      groups.push({
        path,
        urls: [first.url, ...same.map((s) => s.url)].toSorted(),
        similarity: Number(
          Math.min(...same.map((s) => s.similarity)).toFixed(2)
        ),
      });
    }
  }

  return groups.length > 0
    ? [
        finding(
          m("site.parameter-duplicates"),
          `${groups.length} path(s) are crawled under several query strings with the same text.`,
          { evidence: { count: groups.length, groups: cap(groups) } }
        ),
      ]
    : [];
};

interface BrokenImage {
  url: string;
  status: number | null;
  shownOn: string[];
  error?: string;
}

/** Images that answer 4xx/5xx or do not load, with the pages that show them. */
const brokenImageFindings = (ctx: SiteContext): Finding[] => {
  const broken: BrokenImage[] = [];

  for (const [url, check] of ctx.imageChecks ?? []) {
    if (check.error || (check.status ?? 0) >= 400) {
      const entry: BrokenImage = {
        url,
        status: check.status,
        shownOn: cap([...(ctx.imageSources?.get(url) ?? [])], 3),
      };

      if (check.error) {
        entry.error = check.error;
      }

      broken.push(entry);
    }
  }

  return broken.length > 0
    ? [
        finding(
          m("site.broken-images"),
          `${broken.length} image URL(s) are broken.`,
          { evidence: { count: broken.length, examples: cap(broken, 20) } }
        ),
      ]
    : [];
};

export const runSiteRules = (ctx: SiteContext): Finding[] => {
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

  const scope: SiteScope = {
    ctx,
    key,
    pagesByKey,
    checksByKey,
    okPages: ctx.pages.filter((p) => (p.response?.status ?? 200) < 400),
    isIndexable: (p) =>
      !robotsDirectives(p.page, p.response).noindex &&
      (p.response?.status ?? 200) < 400,
  };

  return [
    ...robotsFindings(ctx),
    ...robotsContentFindings(ctx),
    ...blockedResourceFindings(scope),
    ...sitemapFindings(scope),
    ...sitemapProtocolFindings(ctx),
    ...linkHealthFindings(ctx),
    ...unreachedFindings(ctx),
    ...duplicateFindings(scope),
    ...architectureFindings(scope),
    ...urlVariantFindings(scope),
    ...parameterDuplicateFindings(scope),
    ...brokenImageFindings(ctx),
    ...canonicalGraphFindings(scope),
    ...noindexLinkFindings(scope),
    ...hreflangTargetFindings(scope),
    ...hreflangFindings(scope),
  ];
};
