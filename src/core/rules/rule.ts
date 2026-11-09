import type {
  ExtractedPage,
  Finding,
  FixEdit,
  PageSource,
  ResponseInfo,
  RuleMeta,
  Severity,
  Thresholds,
} from "../types.js";

export interface PageContext {
  page: ExtractedPage;
  source: PageSource;
  response?: ResponseInfo;
  keyword?: string;
  thresholds: Thresholds;
  depth?: number;
}

export interface Rule {
  meta: RuleMeta;
  check: (ctx: PageContext) => Finding[];
}

export interface FindingExtras {
  severity?: Severity;
  recommendation?: string;
  /**
   * The edits that resolve this finding here. Required, so no rule can report a problem without
   * its fix; an empty list only for a finding about the audit itself rather than the site.
   */
  fix: FixEdit[];
  /**
   * What this finding is about, when a rule can report more than one per page (a JSON-LD type, a
   * sitemap URL). It goes into the finding's id only, so two findings of one rule keep apart. It
   * stays with the object `finding()` returns: set `url` on that object rather than copying it.
   */
  key?: string;
  selector?: string;
  evidence?: Finding["evidence"];
}

export const cap = <T>(items: T[], max = 10): T[] =>
  items.length > max ? items.slice(0, max) : items;

const findingKeys = new WeakMap<Finding, string>();

/** The `key` a finding was made with, for its id. */
export const findingKey = (f: Finding): string | undefined =>
  findingKeys.get(f);

/** Build a finding from rule metadata, overriding only what differs for this instance. */
export const finding = (
  meta: RuleMeta,
  message: string,
  extras: FindingExtras
): Finding => {
  const f: Finding = {
    rule: meta.id,
    severity: extras.severity ?? meta.severity,
    category: meta.category,
    message,
    recommendation: extras.recommendation ?? meta.recommendation,
  };

  if (extras.fix.length) {
    f.fix = cap(extras.fix);
  }

  if (extras.key) {
    findingKeys.set(f, extras.key);
  }

  if (extras.selector) {
    f.selector = extras.selector;
  }

  if (extras.evidence) {
    f.evidence = extras.evidence;
  }

  if (meta.docs) {
    f.docs = meta.docs;
  }

  return f;
};

export const defineRule = (
  meta: RuleMeta,
  check: (
    ctx: PageContext,
    make: (message: string, extras: FindingExtras) => Finding
  ) => Finding[] | Finding | null | undefined
): Rule => ({
  meta,
  check(ctx) {
    const result = check(ctx, (message, extras) =>
      finding(meta, message, extras)
    );

    if (!result) {
      return [];
    }

    return Array.isArray(result) ? result : [result];
  },
});

export const GOOGLE_DOCS = {
  titles: "https://developers.google.com/search/docs/appearance/title-link",
  snippets: "https://developers.google.com/search/docs/appearance/snippet",
  canonical:
    "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
  robotsMeta:
    "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
  robotsTxt:
    "https://developers.google.com/search/docs/crawling-indexing/robots/intro",
  sitemaps:
    "https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview",
  hreflang:
    "https://developers.google.com/search/docs/specialty/international/localized-versions",
  images: "https://developers.google.com/search/docs/appearance/google-images",
  links:
    "https://developers.google.com/search/docs/crawling-indexing/links-crawlable",
  urlStructure:
    "https://developers.google.com/search/docs/crawling-indexing/url-structure",
  validMetadata:
    "https://developers.google.com/search/docs/crawling-indexing/valid-page-metadata",
  structuredData:
    "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
  javascript:
    "https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics",
  cwv: "https://web.dev/articles/vitals",
  mobile:
    "https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing",
  redirects:
    "https://developers.google.com/search/docs/crawling-indexing/301-redirects",
  softs404:
    "https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors",
  og: "https://ogp.me/",
  twitter:
    "https://developer.x.com/en/docs/x-for-websites/cards/overview/markup",
} as const;
