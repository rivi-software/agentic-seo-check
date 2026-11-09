import type { ExtractedPage, ResponseInfo } from "../types.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** Directives that carry a value after a colon, which is not a user agent prefix. */
const VALUE_DIRECTIVES = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

export interface ScopedDirective {
  /** The user agent the directive is for, or null when it is for every crawler. */
  agent: string | null;
  directive: string;
}

/**
 * X-Robots-Tag values. "googlebot: nosnippet, noarchive" scopes every directive after the prefix
 * to googlebot, up to the next prefix.
 */
export const parseRobotsHeader = (value: string): ScopedDirective[] => {
  const out: ScopedDirective[] = [];
  let agent: string | null = null;

  for (const piece of value.toLowerCase().split(",")) {
    let directive = piece.trim();
    const match = /^(?<name>[a-z0-9_-]+)\s*:\s*(?<rest>.*)$/u.exec(directive);
    const name = match?.groups?.name;

    if (name && !VALUE_DIRECTIVES.has(name)) {
      agent = name;
      directive = match.groups?.rest?.trim() ?? "";
    }

    if (directive) {
      out.push({ agent, directive: directive.replaceAll(/\s+/gu, "") });
    }
  }

  return out;
};

/** Robots directives Google or Bing document, which take no value. */
const KNOWN_DIRECTIVES = new Set([
  "all",
  "index",
  "follow",
  "noindex",
  "nofollow",
  "none",
  "noarchive",
  "nocache",
  "nosnippet",
  "notranslate",
  "noimageindex",
  "indexifembedded",
  "nositelinkssearchbox",
]);

/** A directive the page states for Google, and where it is written. */
interface SourcedDirective {
  source: string;
  directive: string;
}

/** Directives Google applies: meta robots and googlebot, and X-Robots-Tag for every crawler or Googlebot. */
const googleDirectives = (
  page: ExtractedPage,
  response?: ResponseInfo
): SourcedDirective[] => {
  const out: SourcedDirective[] = [];

  for (const meta of page.answer.robotsMeta) {
    if (meta.name === "robots" || meta.name === "googlebot") {
      for (const d of meta.content.split(",")) {
        const directive = d.trim();

        if (directive) {
          out.push({ source: `<meta name="${meta.name}">`, directive });
        }
      }
    }
  }

  const header = response?.headers["x-robots-tag"];

  if (header) {
    for (const d of parseRobotsHeader(header)) {
      if (d.agent === null || d.agent === "googlebot") {
        out.push({ source: "X-Robots-Tag", directive: d.directive });
      }
    }
  }

  return out;
};

/**
 * How a directive Google would not read was meant: "no-index" was meant as noindex, and
 * "noindex nofollow" as two directives. Null for directives Google reads, and for names it does not
 * document, which other crawlers may read.
 */
const misreadDirective = (
  directive: string
): { meant: string[]; kind: "misspelled" | "not-comma-separated" } | null => {
  if (
    KNOWN_DIRECTIVES.has(directive) ||
    VALUE_DIRECTIVES.has(directive.split(":")[0]?.trim() ?? "")
  ) {
    return null;
  }

  const squashed = directive.replaceAll(/[\s_-]+/gu, "");

  if (KNOWN_DIRECTIVES.has(squashed)) {
    return { meant: [squashed], kind: "misspelled" };
  }

  const parts = directive.split(/[\s;]+/u).filter(Boolean);

  return parts.length > 1 && parts.every((p) => KNOWN_DIRECTIVES.has(p))
    ? { meant: parts, kind: "not-comma-separated" }
    : null;
};

export interface RobotsDirectives {
  noindex: boolean;
  nofollow: boolean;
  sources: string[];
  directives: string[];
}

/** User agents whose robots directives count for search: the same ones the meta tags are read for. */
const SEARCH_ENGINE_AGENTS = new Set([
  "googlebot",
  "googlebot-news",
  "bingbot",
]);

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
    // "gptbot: noindex" keeps one AI crawler out; it says nothing about search engines.
    for (const d of parseRobotsHeader(header)) {
      if (d.agent === null || SEARCH_ENGINE_AGENTS.has(d.agent)) {
        directives.push(d.directive);
        sources.push("header");
      }
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
  defineRule(
    {
      id: "robots.conflicting",
      category: "indexing",
      severity: "info",
      description:
        "The page's robots directives contradict each other (index and noindex, or follow and nofollow); Google applies the more restrictive one.",
      recommendation:
        "Keep one directive for indexing and one for following, in one place. A platform or CDN often adds X-Robots-Tag on top of the page's own meta robots; remove the one you did not mean.",
      docs: GOOGLE_DOCS.robotsMeta,
    },
    ({ page, response }, make) => {
      const directives = googleDirectives(page, response);

      const where = (names: string[]): string[] => [
        ...new Set(
          directives
            .filter((d) => names.includes(d.directive.toLowerCase()))
            .map((d) => `${d.directive.toLowerCase()} (${d.source})`)
        ),
      ];

      const pairs = [
        { allow: ["index", "all"], deny: ["noindex", "none"], wins: "noindex" },
        {
          allow: ["follow", "all"],
          deny: ["nofollow", "none"],
          wins: "nofollow",
        },
      ];

      return pairs.flatMap(({ allow, deny, wins }) => {
        const allowed = where(allow);
        const denied = where(deny);

        return allowed.length > 0 && denied.length > 0
          ? [
              make(
                `The page says ${allowed.join(" and ")} but also ${denied.join(" and ")}; Google applies ${wins}.`,
                { evidence: { allow: allowed, deny: denied, applied: wins } }
              ),
            ]
          : [];
      });
    }
  ),
  defineRule(
    {
      id: "robots.malformed-directive",
      category: "indexing",
      severity: "warning",
      description:
        'A robots directive is written in a form Google does not document, such as "no-index" for noindex (warning) or "noindex nofollow" without a comma (info).',
      recommendation:
        'Write each directive the way Google documents it, separated by commas: content="noindex, nofollow". A misspelled noindex is ignored, so the page stays indexable.',
      docs: GOOGLE_DOCS.robotsMeta,
    },
    ({ page, response }, make) => {
      const misread = googleDirectives(page, response).flatMap((d) => {
        const how = misreadDirective(d.directive.toLowerCase());

        return how ? [{ ...d, ...how }] : [];
      });

      if (misread.length === 0) {
        return null;
      }

      const misspelled = misread.some((m) => m.kind === "misspelled");

      const listed = misread.map(
        (m) => `"${m.directive}" (${m.source}, meant as ${m.meant.join(", ")})`
      );

      return make(
        `${misread.length === 1 ? "A robots directive is" : `${misread.length} robots directives are`} not written the way Google documents: ${cap(listed, 5).join("; ")}.`,
        {
          severity: misspelled ? "warning" : "info",
          evidence: {
            directives: cap(
              misread.map((m) => ({
                written: m.directive,
                source: m.source,
                meant: m.meant,
              }))
            ),
          },
        }
      );
    }
  ),
];
