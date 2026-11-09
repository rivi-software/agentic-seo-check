import { mapConcurrent, sleep } from "./concurrency.js";
import { fetchPage, isHtmlResponse, probeUrl } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import { extractPage } from "./html/extract.js";
import { jaccard, shingles } from "./html/text.js";
import { isLocalHost } from "./rules/canonical.js";
import { robotsDirectives } from "./rules/indexing.js";
import type { LinkCheck, PageRecord, UrlVariantProbe } from "./site-rules.js";
import { looksLikeHtml, normalizeUrl } from "./url.js";

export interface ProbeOptions {
  fetch: FetchOptions;
  concurrency: number;
  delayMs: number;
  /** robots.txt lets the crawler fetch the URL. */
  allows: (url: string) => boolean;
}

export interface ImageCheckResult {
  imageChecks: Map<string, LinkCheck>;
  /** For every image URL, the pages that show it. */
  imageSources: Map<string, Set<string>>;
}

/** Image URLs the crawled pages show, with the pages showing each, in crawl order. */
export const imageSourcesOf = (
  records: PageRecord[]
): Map<string, Set<string>> => {
  const sources = new Map<string, Set<string>>();

  // The resources were resolved against the page's <base href>, as the browser resolves them.
  for (const record of records) {
    for (const resource of record.page.resources) {
      if (resource.kind !== "image" && resource.kind !== "responsive-image") {
        continue;
      }

      const set = sources.get(resource.url) ?? new Set<string>();
      set.add(record.url);
      sources.set(resource.url, set);
    }
  }

  return sources;
};

/** Request up to `limit` image URLs, the ones on most pages first, without reading their bodies. */
export const checkImages = async (
  records: PageRecord[],
  limit: number,
  options: ProbeOptions
): Promise<ImageCheckResult> => {
  const imageSources = imageSourcesOf(records);
  const imageChecks = new Map<string, LinkCheck>();

  const targets = [...imageSources]
    .toSorted((a, b) => b[1].size - a[1].size)
    .flatMap(([url]) => (options.allows(url) ? [url] : []))
    .slice(0, limit);

  await mapConcurrent(targets, options.concurrency, async (url) => {
    const res = await probeUrl(url, {
      ...options.fetch,
      timeoutMs: Math.min(options.fetch.timeoutMs ?? 15_000, 10_000),
    });

    imageChecks.set(url, {
      url,
      status: res.status,
      finalUrl: res.finalUrl,
      redirectChain: res.redirectChain,
      error: res.error,
    });

    if (options.delayMs) {
      await sleep(options.delayMs);
    }
  });

  return { imageChecks, imageSources };
};

/** Shared shingles from which two pages count as the same text, as in site.duplicate-content. */
export const SAME_TEXT = 0.9;

/** Pages whose slash and case variants are requested; a few tell how the server treats them all. */
const VARIANT_SAMPLE = 3;

/** The same URL with the trailing slash added or removed, and with the path in uppercase. */
const variantsOf = (
  url: string
): { kind: UrlVariantProbe["kind"]; variant: string }[] => {
  const parsed = new URL(url);
  const { pathname } = parsed;
  const out: { kind: UrlVariantProbe["kind"]; variant: string }[] = [];

  const slash = new URL(parsed.href);
  slash.pathname = pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : `${pathname}/`;
  out.push({ kind: "trailing-slash", variant: slash.href });

  // Percent-escapes keep their case; only letters in the path change.
  const upper = pathname.replaceAll(/%[\dA-F]{2}|[a-z]+/giu, (part) =>
    part.startsWith("%") ? part : part.toUpperCase()
  );

  if (upper !== pathname) {
    const cased = new URL(parsed.href);
    cased.pathname = upper;
    out.push({ kind: "case", variant: cased.href });
  }

  return out;
};

const isIndexablePage = (record: PageRecord): boolean =>
  record.response?.status === 200 &&
  !robotsDirectives(record.page, record.response).noindex;

/**
 * Request a trailing-slash and an uppercase variant of a few crawled pages. A variant that answers
 * 200 itself, without a redirect, and names no canonical that points back is a second URL for the
 * same page. Local dev servers often answer both forms where production does not, so they are left out.
 */
export const probeUrlVariants = async (
  records: PageRecord[],
  startUrl: string,
  options: ProbeOptions
): Promise<UrlVariantProbe[]> => {
  if (isLocalHost(startUrl)) {
    return [];
  }

  const sample = records
    .filter((r) => {
      const { pathname } = new URL(r.url);

      return (
        pathname !== "/" &&
        isIndexablePage(r) &&
        looksLikeHtml(r.url) &&
        !/\.[a-z\d]{2,5}$/iu.test(pathname)
      );
    })
    .slice(0, VARIANT_SAMPLE);

  const requests = sample.flatMap((record) =>
    variantsOf(record.url)
      .filter(({ variant }) => options.allows(variant))
      .map((v) => ({ record, ...v }))
  );

  const probes: UrlVariantProbe[] = [];

  await mapConcurrent(
    requests,
    options.concurrency,
    async ({ record, kind, variant }) => {
      const res = await fetchPage(variant, options.fetch);

      const answered =
        res.status === 200 &&
        res.redirectChain.length === 0 &&
        res.body !== null &&
        isHtmlResponse(res);

      const variantPage = answered
        ? extractPage(res.body ?? "", { url: variant })
        : null;

      const canonical = variantPage?.canonical ?? null;

      // The page's own canonical, or the page itself, is where both URLs should consolidate.
      const target = normalizeUrl(record.page.canonical ?? record.url);
      const named = normalizeUrl(canonical ?? variant);

      // An app shell or catch-all page answering every unknown path is a soft 404, not this page.
      const samePage =
        variantPage !== null &&
        jaccard(shingles(record.page.text), shingles(variantPage.text)) >=
          SAME_TEXT;

      probes.push({
        kind,
        url: record.url,
        variant,
        status: res.status,
        canonical,
        duplicate: samePage && named !== target,
      });

      if (options.delayMs) {
        await sleep(options.delayMs);
      }
    }
  );

  return probes;
};
