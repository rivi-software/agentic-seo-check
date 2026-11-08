import { isLocalHost } from "./canonical.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

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
            { evidence: { timeMs: response.timeMs } }
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
    ({ response }, make) => {
      const contentType = response?.contentType;

      if (!contentType) {
        return null;
      }

      const ct = contentType.toLowerCase();

      return !ct.includes("html") && !ct.includes("xhtml")
        ? make(`Content-Type is "${contentType}", not HTML.`, {
            evidence: { contentType },
          })
        : null;
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
            evidence: { finalUrl: response.finalUrl },
          })
        : null
  ),
];
