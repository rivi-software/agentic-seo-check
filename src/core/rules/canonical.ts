import { quote } from "../html/dom.js";
import type { ExtractedPage, FixEdit, ResponseInfo } from "../types.js";
import { hostOf, normalizeUrl, resolveUrl, samePath } from "../url.js";
import {
  addHtml,
  escapeAttribute,
  removeEdit,
  replaceEdit,
  setAttributeEdit,
} from "./fix.js";
import { liveUrl, ORIGIN_WRITE } from "./quoted-tags.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

const SELECTOR = 'head > link[rel="canonical"]';

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export const isLocalHost = (url: string): boolean => {
  const host = hostOf(url);

  if (!host) {
    return false;
  }

  return (
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".test")
  );
};

/*
 * One `<url>; param; param` entry of a Link header. Neither character class crosses an angle
 * bracket, so no match can restart inside another and matching stays linear on a long header.
 */
const LINK_ENTRY = /<(?<target>[^<>]*)>(?<params>[^<]*)/gu;

/** Targets of `Link: <url>; rel="canonical"` in the response headers, resolved against the page URL. */
export const headerCanonicals = (
  response: ResponseInfo | undefined,
  base: string
): string[] => {
  const header = response?.headers["link"]?.slice(0, 16_384);

  if (!header) {
    return [];
  }

  const out: string[] = [];

  for (const match of header.matchAll(LINK_ENTRY)) {
    const rel = match.groups?.params
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => /^rel\s*=/iu.test(p));

    const values = (rel?.slice(rel.indexOf("=") + 1) ?? "")
      .replaceAll(/["']/gu, "")
      .toLowerCase()
      .split(/[\s,]+/u);

    if (values.includes("canonical")) {
      const target = match.groups?.target?.trim() ?? "";
      out.push(resolveUrl(target, base) ?? target);
    }
  }

  return out;
};

const stripTrailingSlash = (url: string): string =>
  url.endsWith("/") && new URL(url).pathname !== "/" ? url.slice(0, -1) : url;

/** `url` for an href on the live site, and what the agent writes when its origin is a slot. */
const hrefFor = (
  page: ExtractedPage,
  url: string
): { href: string; write?: string } => {
  const local = isLocalHost(page.url) || page.url.startsWith("file:");

  return local
    ? { href: liveUrl(url, true), write: ORIGIN_WRITE }
    : { href: escapeAttribute(url) };
};

/** This page's own URL, for a self-referencing canonical: no fragment, no tracking parameters. */
export const selfUrl = (page: ExtractedPage): string =>
  normalizeUrl(page.url) ?? page.url;

/** The edit that points the canonical <link> the page reads at `url`. */
export const pointCanonical = (
  page: ExtractedPage,
  url: string,
  write?: string
): FixEdit => {
  const { href, write: originWrite } = hrefFor(page, url);
  const tag = page.markup.canonicals[0] ?? null;
  const text = [originWrite, write].filter(Boolean).join(" ") || undefined;

  return tag === null
    ? addHtml("head", `<link rel="canonical" href="${href}">`, text)
    : setAttributeEdit(tag, SELECTOR, "href", href, text);
};

/**
 * The edit of the Link header that leaves only the canonical entries `keep` keeps, and every entry
 * that is not a canonical (preload, preconnect) as it was.
 */
const linkHeaderEdit = (
  header: string,
  base: string,
  keep: (target: string) => boolean,
  write: string
): FixEdit => {
  const kept: string[] = [];

  for (const match of header.slice(0, 16_384).matchAll(LINK_ENTRY)) {
    const entry = match[0].trim().replace(/,$/u, "").trim();

    const [canonical] = headerCanonicals(
      {
        status: null,
        finalUrl: base,
        redirectChain: [],
        timeMs: null,
        contentType: null,
        headers: { link: entry },
      },
      base
    );

    if (canonical === undefined || keep(canonical)) {
      kept.push(entry);
    }
  }

  const current = quote(`Link: ${header}`);

  return kept.length === 0
    ? removeEdit("http", current, { at: "Link", write })
    : replaceEdit("http", current, `Link: ${kept.join(", ")}`, {
        at: "Link",
        write,
      });
};

const PAGINATION_DOCS =
  "https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading";

/** Query parameters that number the pages of a series: ?page=2, ?p=2, ?pg=2, WordPress's ?paged=2. */
const PAGE_PARAMS = new Set(["page", "p", "pg", "paged"]);

/** A path that ends in a page number, as WordPress and many blogs write it: /blog/page/2/. */
const PAGE_SEGMENT = /\/page\/(?<n>\d{1,6})\/?$/u;

/** Page 2 or later of a series: its number and the URL of the series' first page. */
interface LaterPage {
  n: number;
  first: string;
}

const laterPageOf = (url: string): LaterPage | null => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  for (const [key, value] of parsed.searchParams) {
    if (
      PAGE_PARAMS.has(key.toLowerCase()) &&
      /^\d{1,6}$/u.test(value) &&
      Number(value) >= 2
    ) {
      const first = new URL(parsed.href);
      first.searchParams.delete(key);

      return { n: Number(value), first: first.href };
    }
  }

  const match = PAGE_SEGMENT.exec(parsed.pathname);
  const n = Number(match?.groups?.n);

  if (match && n >= 2) {
    parsed.pathname = `${parsed.pathname.slice(0, match.index)}/`;

    return { n, first: parsed.href };
  }

  return null;
};

/**
 * A URL to compare as the first page of a series: no fragment or tracking parameters, no trailing
 * slash, and no `page=1`, which names the first page too. Paths only for a file or a local server,
 * whose host is not the live one.
 */
const firstPageKey = (url: string, pathOnly: boolean): string | null => {
  const normalized = normalizeUrl(url);

  if (!normalized) {
    return null;
  }

  const parsed = new URL(normalized);

  const firstPage = [...parsed.searchParams].filter(
    ([key, value]) => PAGE_PARAMS.has(key.toLowerCase()) && value === "1"
  );

  for (const [key] of firstPage) {
    parsed.searchParams.delete(key);
  }

  const { pathname } = parsed;

  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  return pathOnly
    ? `${path}${parsed.search}`
    : `${parsed.origin}${path}${parsed.search}`;
};

export const canonicalRules = [
  defineRule(
    {
      id: "canonical.missing",
      category: "canonical",
      severity: "warning",
      description: 'No <link rel="canonical"> is present.',
      recommendation:
        "Add a self-referencing canonical with the absolute preferred URL (scheme, host, trailing slash) so duplicate URLs (query strings, www/non-www) consolidate to it.",
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page, response }, make) =>
      page.canonicals.length === 0 &&
      headerCanonicals(response, page.url).length === 0
        ? make("Page has no canonical link.", {
            fix: [
              pointCanonical(
                page,
                selfUrl(page),
                "If this page is a copy of another one, name that page's URL instead."
              ),
            ],
            selector: SELECTOR,
          })
        : null
  ),
  defineRule(
    {
      id: "canonical.header-conflict",
      category: "canonical",
      severity: "error",
      description:
        'The HTTP Link header names a different canonical URL than the page\'s <link rel="canonical">, or names more than one.',
      recommendation:
        'Name one canonical URL, in one place: the <link rel="canonical"> in <head>, or the Link header (meant for PDFs and other files without HTML). Google asks not to give different canonical URLs through different methods. A CDN, plugin or platform rule often sets the header; remove the one you did not mean.',
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page, response }, make) => {
      const header = headerCanonicals(response, page.url);

      const targets = new Set(
        // Google treats /page and /page/ as two URLs, so a trailing slash is a real difference.
        [...header, ...(page.canonical ? [page.canonical] : [])].map(
          (url) => normalizeUrl(url) ?? url
        )
      );

      if (header.length === 0 || targets.size <= 1) {
        return null;
      }

      // Keep the <link> in <head> the page's author wrote; with none, keep the header's first URL.
      const keepUrl = normalizeUrl(page.canonical ?? header[0] ?? "");
      let firstKept = false;

      const edit = linkHeaderEdit(
        response?.headers["link"] ?? "",
        page.url,
        (target) => {
          if (page.canonical || firstKept) {
            return false;
          }

          firstKept = (normalizeUrl(target) ?? target) === keepUrl;

          return firstKept;
        },
        page.canonical
          ? `Name the canonical once, in the <link> in <head>. If the header's URL is the right one, point the <link> at it and remove the header entry all the same. A CDN, plugin or platform rule often adds the header.`
          : "Keep one canonical URL in the header: the URL this page should rank under."
      );

      return make(
        page.canonical
          ? `The Link header names ${header.join(" and ")} as canonical, but <link rel="canonical"> names ${page.canonical}.`
          : `The Link header names ${header.length} different canonical URLs.`,
        {
          fix: [edit],
          evidence: {
            linkHeader: cap(header),
            htmlCanonical: page.canonical,
          },
        }
      );
    }
  ),
  defineRule(
    {
      id: "canonical.multiple",
      category: "canonical",
      severity: "error",
      description:
        "More than one canonical link is present. When they disagree, search engines ignore all of them.",
      recommendation:
        "Emit exactly one canonical link per page. Check for a framework default plus a hand-written one.",
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page }, make) => {
      if (page.canonicals.length <= 1) {
        return null;
      }

      const distinct = new Set(page.canonicals.map((c) => c.trim()));

      // Keep the canonical that names this page, if one does, else the first; remove the others.
      const self = normalizeUrl(page.url);

      const selfIndex = page.canonicals.findIndex((c) => {
        const url = resolveUrl(c, page.url);

        return url !== null && normalizeUrl(url) === self;
      });

      const keep = Math.max(selfIndex, 0);

      const removals = page.markup.canonicals.flatMap((tag, i) =>
        i === keep
          ? []
          : [
              removeEdit("html", tag, {
                at: SELECTOR,
                write:
                  distinct.size > 1 && selfIndex === -1
                    ? `This keeps the first canonical, ${page.canonicals[keep] ?? ""}. If another one names the URL this page should rank under, keep that one instead.`
                    : undefined,
              }),
            ]
      );

      return make(
        `Page has ${page.canonicals.length} canonical links${distinct.size > 1 ? " with different targets" : " (identical)"}.`,
        {
          fix: removals,
          selector: SELECTOR,
          severity: distinct.size > 1 ? "error" : "warning",
          evidence: { canonicals: cap(page.canonicals) },
        }
      );
    }
  ),
  defineRule(
    {
      id: "canonical.invalid",
      category: "canonical",
      severity: "error",
      description:
        "The canonical href is empty or cannot be resolved to an http(s) URL.",
      recommendation:
        "Set the canonical href to a valid absolute URL such as https://www.example.com/path/.",
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page }, make) => {
      const [first] = page.canonicals;

      if (first === undefined) {
        return null;
      }

      return page.canonical
        ? null
        : make(`Canonical href "${first}" is not a valid URL.`, {
            fix: [
              pointCanonical(
                page,
                selfUrl(page),
                "This points the canonical at this page; if it was meant for another page, write that page's absolute URL."
              ),
            ],
            selector: SELECTOR,
            evidence: { href: first },
          });
    }
  ),
  defineRule(
    {
      id: "canonical.relative",
      category: "canonical",
      severity: "warning",
      description: "The canonical href is a relative URL.",
      recommendation:
        "Use an absolute URL in the canonical link. Relative canonicals are error-prone and some crawlers resolve them unexpectedly.",
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page }, make) => {
      const [first] = page.canonicals;

      if (!first || !page.canonical) {
        return null;
      }

      return /^https?:\/\//iu.test(first)
        ? null
        : make(`Canonical href "${first}" is relative.`, {
            fix: [pointCanonical(page, page.canonical)],
            selector: SELECTOR,
            evidence: { href: first, resolved: page.canonical },
          });
    }
  ),
  defineRule(
    {
      id: "canonical.protocol-mismatch",
      category: "canonical",
      severity: "warning",
      description:
        "The page is served over https but the canonical points to http.",
      recommendation: "Point the canonical at the https URL.",
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page, source }, make) => {
      if (source !== "url" || !page.canonical) {
        return null;
      }

      return page.url.startsWith("https://") &&
        page.canonical.startsWith("http://")
        ? make(
            "Canonical uses http:// while the page is served over https://.",
            {
              fix: [
                pointCanonical(
                  page,
                  page.canonical.replace(/^http:/iu, "https:")
                ),
              ],
              selector: SELECTOR,
              evidence: { canonical: page.canonical, page: page.url },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "canonical.other-page",
      category: "canonical",
      severity: "info",
      description:
        "The canonical points to a different URL, so search engines will treat this page as a duplicate of that URL.",
      recommendation:
        "If this page should rank on its own, make the canonical self-referencing. If it is intentionally a duplicate (print view, filtered list, tracking URL), this is correct.",
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page, source }, make) => {
      if (!page.canonical) {
        return null;
      }

      const pageUrl = normalizeUrl(page.url);
      const canon = normalizeUrl(page.canonical);

      if (!pageUrl || !canon) {
        return null;
      }

      // For files and local dev servers the host is synthetic; compare paths only.
      const pathOnly = source !== "url" || isLocalHost(page.url);

      const same = pathOnly
        ? samePath(pageUrl, canon)
        : stripTrailingSlash(pageUrl) === stripTrailingSlash(canon);

      return same
        ? null
        : make(`Canonical points to ${page.canonical}, not to this page.`, {
            fix: [
              pointCanonical(
                page,
                selfUrl(page),
                `Only if this page should rank on its own. If it is a copy of ${page.canonical} on purpose (a print view, a filtered list, a tracking URL), keep the canonical as it is.`
              ),
            ],
            selector: SELECTOR,
            evidence: {
              canonical: page.canonical,
              page: page.url,
              comparedBy: pathOnly ? "path" : "url",
            },
          });
    }
  ),
  defineRule(
    {
      id: "canonical.paginated-to-first",
      category: "canonical",
      severity: "warning",
      description:
        "Page 2 or later of a paginated series (?page=2, /page/2/) names the first page as its canonical, so search engines may drop it and miss the items only it links to.",
      recommendation:
        "Give each page of the series a canonical that names its own URL (?page=2 names ?page=2), and link the pages to each other with plain <a href> links. Google advises against making the first page the canonical of the series.",
      docs: PAGINATION_DOCS,
    },
    ({ page, source }, make) => {
      const later = page.canonical ? laterPageOf(page.url) : null;

      if (!later || !page.canonical) {
        return null;
      }

      const pathOnly = source !== "url" || isLocalHost(page.url);
      const first = firstPageKey(later.first, pathOnly);

      return first !== null && firstPageKey(page.canonical, pathOnly) === first
        ? make(
            `Page ${later.n} of a series names the first page, ${page.canonical}, as canonical.`,
            {
              fix: [
                pointCanonical(
                  page,
                  selfUrl(page),
                  "Each page of the series names its own URL; the first page keeps its own canonical."
                ),
              ],
              selector: SELECTOR,
              evidence: {
                page: page.url,
                pageNumber: later.n,
                canonical: page.canonical,
              },
            }
          )
        : null;
    }
  ),
];
