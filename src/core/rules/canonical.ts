import type { ResponseInfo } from "../types.js";
import { hostOf, normalizeUrl, resolveUrl, samePath } from "../url.js";
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
        ? make("Page has no canonical link.", { selector: SELECTOR })
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

      return header.length > 0 && targets.size > 1
        ? make(
            page.canonical
              ? `The Link header names ${header.join(" and ")} as canonical, but <link rel="canonical"> names ${page.canonical}.`
              : `The Link header names ${header.length} different canonical URLs.`,
            {
              evidence: {
                linkHeader: cap(header),
                htmlCanonical: page.canonical,
              },
            }
          )
        : null;
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

      return make(
        `Page has ${page.canonicals.length} canonical links${distinct.size > 1 ? " with different targets" : " (identical)"}.`,
        {
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
            selector: SELECTOR,
            evidence: {
              canonical: page.canonical,
              page: page.url,
              comparedBy: pathOnly ? "path" : "url",
            },
          });
    }
  ),
];
