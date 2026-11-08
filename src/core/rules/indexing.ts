import type { ExtractedPage, ResponseInfo } from "../types.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

export interface RobotsDirectives {
  noindex: boolean;
  nofollow: boolean;
  sources: string[];
  directives: string[];
}

/** Combine <meta name="robots"> / googlebot and the X-Robots-Tag header. */
export const robotsDirectives = (
  page: ExtractedPage,
  response?: ResponseInfo
): RobotsDirectives => {
  const directives: string[] = [];
  const sources: string[] = [];

  for (const content of page.metaRobots) {
    for (const d of content
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      directives.push(d);
      sources.push("meta");
    }
  }

  const header = response?.headers["x-robots-tag"];

  if (header) {
    for (const d of header
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      // "googlebot: noindex" form
      directives.push(d.includes(":") ? (d.split(":").pop() ?? d).trim() : d);
      sources.push("header");
    }
  }

  const noindex = directives.some((d) => d === "noindex" || d === "none");
  const nofollow = directives.some((d) => d === "nofollow" || d === "none");

  return {
    noindex,
    nofollow,
    sources: [...new Set(sources)],
    directives: [...new Set(directives)],
  };
};

export const indexingRules = [
  defineRule(
    {
      id: "robots.noindex",
      category: "indexing",
      severity: "warning",
      description:
        "The page tells search engines not to index it (meta robots or X-Robots-Tag).",
      recommendation:
        "If this page should appear in search results, remove the noindex directive. Preview/staging hosts often add X-Robots-Tag: noindex at the platform level; verify on production. If the page is intentionally private (login, thank-you, internal search), this is correct.",
      docs: GOOGLE_DOCS.robotsMeta,
    },
    ({ page, response }, make) => {
      const r = robotsDirectives(page, response);

      return r.noindex
        ? make(`Page is set to noindex via ${r.sources.join(" and ")}.`, {
            selector: r.sources.includes("meta")
              ? 'head > meta[name="robots"]'
              : undefined,
            evidence: {
              directives: r.directives,
              sources: r.sources,
              xRobotsTag: response?.headers["x-robots-tag"] ?? null,
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "robots.nofollow",
      category: "indexing",
      severity: "info",
      description: "The page tells search engines not to follow its links.",
      recommendation:
        "Remove nofollow unless you deliberately want link equity to stop at this page; it also hides linked pages from discovery.",
      docs: GOOGLE_DOCS.robotsMeta,
    },
    ({ page, response }, make) => {
      const r = robotsDirectives(page, response);

      return r.nofollow
        ? make(`Page-level nofollow is set via ${r.sources.join(" and ")}.`, {
            evidence: { directives: r.directives },
          })
        : null;
    }
  ),
];
