import { ExpectedError } from "./errors.js";
import type { PageRecord } from "./site-rules.js";
import type { CrawlStats } from "./types.js";
import { normalizeUrl, resolveUrl } from "./url.js";

/** A crawl's `urls` that are no list of pages on the start URL's origin. */
export class InvalidUrlListError extends ExpectedError {
  override name = "InvalidUrlListError";
}

/**
 * The pages a crawl of a list audits (issue #231): each listed URL normalized, once, in the order
 * given, or null for a crawl without a list. A path such as `/blog/` is read against the start
 * URL. A URL on another origin, or a list longer than `maxPages`, is the caller's mistake, said
 * before any request goes out. One origin keeps robots.txt, the site's limits and the site rules
 * to one site.
 */
export const listedPages = (
  startUrl: string,
  urls: readonly string[] | undefined,
  maxPages: number
): string[] | null => {
  if (!urls) {
    return null;
  }

  const { origin } = new URL(startUrl);
  const unique = new Set<string>();

  for (const given of urls) {
    // Read as a link on the start page is: trimmed, and a path against the start URL.
    const resolved = resolveUrl(given, startUrl);
    const url = resolved ? normalizeUrl(resolved) : null;

    if (!url || URL.parse(url)?.origin !== origin) {
      throw new InvalidUrlListError(
        `${JSON.stringify(given.slice(0, 200))} is not a URL on ${origin}: every URL in \`urls\` must be on the origin of the start URL.`
      );
    }

    unique.add(url);
  }

  const pages = [...unique];

  if (pages.length === 0) {
    throw new InvalidUrlListError(
      "`urls` is empty: list at least one page, or leave it out to crawl from the start URL."
    );
  }

  if (pages.length > maxPages) {
    throw new InvalidUrlListError(
      `\`urls\` lists ${pages.length} pages, more than the ${maxPages} the crawl may audit (maxPages).`
    );
  }

  return pages;
};

/** The pages of a list in the order it gives them, each by the URL it was requested at. */
export const inListOrder = (
  records: PageRecord[],
  listed: readonly string[]
): PageRecord[] => {
  const place = new Map(listed.map((url, i) => [url, i]));

  return records.toSorted(
    (a, b) =>
      (place.get(a.requestedUrl) ?? listed.length) -
      (place.get(b.requestedUrl) ?? listed.length)
  );
};

/** A crawl's stats, with `pagesListed` after `pagesDiscovered` for a crawl of a list. */
export const withListed = (
  stats: CrawlStats,
  listed: readonly string[] | null
): CrawlStats => {
  if (!listed) {
    return stats;
  }

  const { pagesCrawled, pagesDiscovered, ...rest } = stats;

  return {
    pagesCrawled,
    pagesDiscovered,
    pagesListed: listed.length,
    ...rest,
  };
};
