import type {
  ExtractedPage,
  FixEdit,
  RedirectHop,
  ResponseInfo,
} from "../types.js";
import { isLocalHost } from "./canonical.js";
import { addEdit, removeEdit, replaceEdit } from "./fix.js";
import { permanentRedirect, statusLine } from "./page-fixes.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

/** Where a redirect hop sends the request: the next hop's URL, or the final URL after the last. */
const nextUrl = (response: ResponseInfo, index: number): string =>
  response.redirectChain[index + 1]?.url ?? response.finalUrl;

/** A hop's status line and Location, as the server answered. */
const hopResponse = (response: ResponseInfo, index: number, hop: RedirectHop) =>
  `${statusLine(hop.status)}\nLocation: ${nextUrl(response, index)}`;

/** A redirect that keeps its kind (permanent or temporary) but sends the request to `location`. */
const redirectTo = (status: number, location: string): string =>
  `${statusLine(status)}\nLocation: ${location}`;

/** Edits that point the links to `from` at `to`: they are on other pages, so the edit names them. */
const linkEdit = (from: string, to: string): FixEdit =>
  replaceEdit("html", from, to, {
    at: 'a[href], link[rel="canonical"], link[rel="alternate"]',
    write:
      "In every internal link, canonical, hreflang link and sitemap entry across the site that names the redirecting URL (also when written as a relative path).",
  });

/** The page has markup of its own, so it is HTML served with the wrong type rather than a file. */
const looksLikeHtml = (page: ExtractedPage): boolean =>
  page.markup.html !== null ||
  page.markup.head !== null ||
  page.titles.length > 0;

/** Headers that make a response unsafe to share from a CDN cache: it is set up per visitor. */
const isPersonal = (response: ResponseInfo): boolean =>
  "set-cookie" in response.headers ||
  /\b(?:private|no-store)\b/iu.test(response.headers["cache-control"] ?? "") ||
  /\b(?:cookie|authorization)\b/iu.test(response.headers["vary"] ?? "");

export const responseRules = [
  defineRule(
    {
      id: "response.error-status",
      category: "response",
      severity: "error",
      description: "The URL returned a 4xx or 5xx status code.",
      recommendation:
        "Fix the route or server error. If the page was removed on purpose, return 410 (or 404) and remove internal links and sitemap entries pointing to it.",
    },
    ({ response }, make) =>
      response?.status && response.status >= 400
        ? make(`URL returned HTTP ${response.status}.`, {
            fix: [
              replaceEdit(
                "http",
                statusLine(response.status),
                statusLine(200),
                {
                  at: "status line",
                  write:
                    "Fix the route or the server error so the page answers 200 with its content. If the page was removed on purpose, answer 410 Gone instead and remove the links and sitemap entries that point to it.",
                }
              ),
            ],
            evidence: { status: response.status, finalUrl: response.finalUrl },
          })
        : null
  ),
  defineRule(
    {
      id: "response.redirected",
      category: "response",
      severity: "info",
      description: "The requested URL redirected to another URL.",
      recommendation:
        "Link directly to the final URL (internal links, sitemap, canonical) so crawlers and users skip the redirect.",
      docs: GOOGLE_DOCS.redirects,
    },
    ({ response }, make) => {
      const [hop] = response?.redirectChain ?? [];

      return response && hop && response.redirectChain.length === 1
        ? make(`Request redirected (${hop.status}) to ${response.finalUrl}.`, {
            fix: [linkEdit(hop.url, response.finalUrl)],
            evidence: {
              chain: response.redirectChain,
              finalUrl: response.finalUrl,
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "response.redirect-chain",
      category: "response",
      severity: "warning",
      description:
        "The URL goes through two or more redirects before reaching the final page.",
      recommendation:
        "Collapse the chain so the first URL redirects straight to the final destination. Each hop costs crawl budget and loses some signal.",
      docs: GOOGLE_DOCS.redirects,
    },
    ({ response }, make) =>
      response && response.redirectChain.length >= 2
        ? make(
            `Redirect chain of ${response.redirectChain.length} hops ends at ${response.finalUrl}.`,
            {
              // Every hop redirects straight to the end, keeping its kind; the last already does.
              fix: [
                ...response.redirectChain
                  .slice(0, -1)
                  .map((hop, i) =>
                    replaceEdit(
                      "http",
                      hopResponse(response, i, hop),
                      redirectTo(hop.status, response.finalUrl),
                      { url: hop.url, at: "status line and Location" }
                    )
                  ),
                ...(response.redirectChain[0]
                  ? [linkEdit(response.redirectChain[0].url, response.finalUrl)]
                  : []),
              ],
              evidence: {
                chain: response.redirectChain,
                finalUrl: response.finalUrl,
              },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "response.slow",
      category: "response",
      severity: "warning",
      description:
        "The HTML response took longer than the configured threshold (default 2000 ms).",
      recommendation:
        "Reduce server response time: cache the HTML, avoid blocking data fetches during render, use a CDN. Google recommends TTFB under 800 ms.",
      docs: GOOGLE_DOCS.cwv,
    },
    ({ response, thresholds }, make) =>
      response?.timeMs !== null &&
      response?.timeMs !== undefined &&
      response.timeMs > thresholds.slowResponseMs
        ? make(
            `HTML response took ${response.timeMs} ms (single measurement; threshold ${thresholds.slowResponseMs} ms).`,
            {
              // A CDN may cache only a page that is the same for every visitor.
              fix: [
                isPersonal(response)
                  ? replaceEdit(
                      "http",
                      `${response.timeMs} ms`,
                      "under 800 ms",
                      {
                        at: "time to first byte",
                        write:
                          "The response is set up per visitor (cookies or private caching), so it must not come from a shared cache: speed up the server work for this URL instead (database queries, API calls during render, a cache of the data it fetches).",
                      }
                    )
                  : addEdit(
                      "http",
                      "response headers",
                      "Cache-Control: public, s-maxage=300, stale-while-revalidate=86400",
                      {
                        write:
                          "Lets the CDN serve this HTML from its cache for 5 minutes and refresh it in the background. Set it only when the page is the same for every visitor; otherwise speed up the server work for this URL. Aim for a time to first byte under 800 ms.",
                      }
                    ),
              ],
              evidence: { timeMs: response.timeMs },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "response.not-html",
      category: "response",
      severity: "warning",
      description: "The response Content-Type is not HTML.",
      recommendation:
        "Serve pages with Content-Type: text/html; charset=utf-8.",
    },
    ({ page, response }, make) => {
      const contentType = response?.contentType;

      if (!contentType) {
        return null;
      }

      const ct = contentType.toLowerCase();

      if (ct.includes("html") || ct.includes("xhtml")) {
        return null;
      }

      // A file such as a PDF keeps its type; HTML sent with the wrong one gets text/html.
      const fix = looksLikeHtml(page)
        ? replaceEdit(
            "http",
            `Content-Type: ${contentType}`,
            "Content-Type: text/html; charset=utf-8",
            { at: "Content-Type" }
          )
        : removeEdit("sitemap", `<loc>${response.finalUrl}</loc>`, {
            write:
              "This URL serves a file, not a page, so its type is right: if a sitemap lists it, remove its <url> entry, and audit an HTML page instead.",
          });

      return make(`Content-Type is "${contentType}", not HTML.`, {
        fix: [fix],
        evidence: { contentType },
      });
    }
  ),
  defineRule(
    {
      id: "response.not-https",
      category: "response",
      severity: "warning",
      description: "The final URL is served over plain http.",
      recommendation:
        "Serve the site over https and redirect http to https. HTTPS is a (light) ranking signal and required for many browser features.",
    },
    ({ response, source }, make) =>
      source === "url" &&
      response &&
      response.finalUrl.startsWith("http://") &&
      !isLocalHost(response.finalUrl)
        ? make("Page is served over http:// instead of https://.", {
            fix: [
              replaceEdit(
                "http",
                statusLine(response.status ?? 200),
                permanentRedirect(
                  response.finalUrl.replace(/^http:/iu, "https:")
                ),
                {
                  at: "status line and Location",
                  write:
                    "Serve the site over https first (a TLS certificate for this host, which most hosts and CDNs issue for free), then redirect every http URL to its https twin. Build canonicals, sitemaps and links from the https origin.",
                }
              ),
            ],
            evidence: { finalUrl: response.finalUrl },
          })
        : null
  ),
];
