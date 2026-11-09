import { quote } from "../html/dom.js";
import type { ExtractedPage, FixEdit, ResponseInfo } from "../types.js";
import { removeEdit, replaceEdit, setAttributeEdit } from "./fix.js";
import { readAttributes, withAttributeSelector } from "./quoted-tags.js";
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
  let scoped = new Set<string>();

  for (const piece of value.toLowerCase().split(",")) {
    let directive = piece.trim();
    const match = /^(?<name>[a-z0-9_-]+)\s*:\s*(?<rest>.*)$/u.exec(directive);
    const name = match?.groups?.name;

    if (name && !VALUE_DIRECTIVES.has(name)) {
      agent = name;
      scoped = new Set();
      directive = match.groups?.rest?.trim() ?? "";
    }

    directive = directive.replaceAll(/\s+/gu, "");

    /*
     * Two X-Robots-Tag headers arrive joined with ", ", so "GPTBot: noindex" and a plain "noindex"
     * read as "gptbot: noindex, noindex". A directive that repeats under one agent cannot belong to
     * it twice: it starts a header for every crawler.
     */
    if (agent !== null && scoped.has(directive)) {
      agent = null;
    }

    if (directive) {
      scoped.add(directive);
      out.push({ agent, directive });
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

/**
 * What an edit does to one directive, given the user agent it is for (null for every crawler):
 * the directive to write instead (the same one keeps it), or null to drop it.
 */
type DirectiveEdit = (directive: string, agent: string | null) => string | null;

/**
 * A robots meta content or X-Robots-Tag value with every directive passed through `edit`, written
 * back with ", " between directives. When a dropped directive carried an `agent:` prefix, the next
 * directive of that agent takes the prefix, so no directive changes the crawler it is for.
 */
interface EditedDirectives {
  value: string;
  /** Whether any directive was dropped or rewritten. */
  changed: boolean;
}

const editDirectives = (
  value: string,
  edit: DirectiveEdit
): EditedDirectives => {
  const out: string[] = [];
  let agent: string | null = null;
  let carry = "";
  let changed = false;

  for (const piece of value.split(",")) {
    let directive = piece.trim();
    let prefix = "";
    const match = /^(?<name>[a-z0-9_-]+)\s*:\s*(?<rest>.*)$/iu.exec(directive);
    const name = match?.groups?.name;

    if (name && !VALUE_DIRECTIVES.has(name.toLowerCase())) {
      agent = name.toLowerCase();
      prefix = `${name}: `;
      carry = "";
      directive = match.groups?.rest?.trim() ?? "";
    }

    if (!directive) {
      continue;
    }

    const lower = directive.toLowerCase();
    const result = edit(lower, agent);

    if (result === null) {
      changed = true;
      carry = prefix || carry;
      continue;
    }

    if (result !== lower) {
      changed = true;
    }

    out.push(`${prefix || carry}${result === lower ? directive : result}`);
    carry = "";
  }

  return { value: out.join(", "), changed };
};

const KEEP_IF_DELIBERATE =
  "Keep it if the page should stay out of search (a login, thank-you or internal search page). Preview and staging hosts often add it themselves: check production first.";

/**
 * The edits that apply `edit` to the robots meta tags named in `names` (robots, googlebot, ...)
 * and to the X-Robots-Tag header for the agents `headerAgent` accepts.
 */
const directiveEdits = (
  page: ExtractedPage,
  response: ResponseInfo | undefined,
  names: ReadonlySet<string>,
  headerAgent: (agent: string | null) => boolean,
  edit: DirectiveEdit,
  write?: string
): FixEdit[] => {
  const fix: FixEdit[] = [];

  for (const tag of page.markup.metaRobots) {
    const attributes = readAttributes(tag);
    const name = attributes?.get("name")?.trim() ?? "";

    if (!attributes || !names.has(name.toLowerCase())) {
      continue;
    }

    const agent = name.toLowerCase() === "robots" ? null : name.toLowerCase();

    const next = editDirectives(attributes.get("content") ?? "", (d) =>
      edit(d, agent)
    );

    if (!next.changed) {
      continue;
    }

    const at = withAttributeSelector("meta", "name", name);

    fix.push(
      next.value
        ? setAttributeEdit(
            tag,
            at,
            "content",
            next.value.replaceAll('"', "&quot;"),
            write
          )
        : removeEdit("html", tag, { at, write })
    );
  }

  const header = response?.headers["x-robots-tag"];

  if (header) {
    const next = editDirectives(header, (d, agent) =>
      headerAgent(agent) ? edit(d, agent) : d
    );

    const current = quote(`X-Robots-Tag: ${header}`);

    const where =
      "Set in the server, CDN or host config (a headers file or rule) that sends it.";

    const text = [write, where].filter(Boolean).join(" ");

    if (next.changed) {
      fix.push(
        next.value
          ? replaceEdit("http", current, `X-Robots-Tag: ${next.value}`, {
              at: "X-Robots-Tag",
              write: text,
            })
          : removeEdit("http", current, { at: "X-Robots-Tag", write: text })
      );
    }
  }

  return fix;
};

/** A directive without its whitespace, as X-Robots-Tag is read: "noindex nofollow" is "noindexnofollow". */
const squash = (d: string): string => d.replaceAll(/\s+/gu, "");

const ALL_ROBOTS_NAMES = new Set(["robots", ...SEARCH_ENGINE_AGENTS]);
const GOOGLE_NAMES = new Set(["robots", "googlebot"]);

const forSearch = (agent: string | null): boolean =>
  agent === null || SEARCH_ENGINE_AGENTS.has(agent);

const forGoogle = (agent: string | null): boolean =>
  agent === null || agent === "googlebot";

/** Drops `directive` from a list; "none" (noindex and nofollow) keeps the other half. */
const dropping =
  (directive: "noindex" | "nofollow"): DirectiveEdit =>
  (d) => {
    if (d === directive) {
      return null;
    }

    if (d === "none") {
      return directive === "noindex" ? "nofollow" : "noindex";
    }

    return d;
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
            fix: directiveEdits(
              page,
              response,
              ALL_ROBOTS_NAMES,
              forSearch,
              dropping("noindex"),
              `Only if this page should appear in search results. ${KEEP_IF_DELIBERATE}`
            ),
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
            fix: directiveEdits(
              page,
              response,
              ALL_ROBOTS_NAMES,
              forSearch,
              dropping("nofollow"),
              "Only if search engines should follow this page's links. Keep it if they should not, for instance on a page of links you do not vouch for."
            ),
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

        // Removing the permissive directive changes nothing Google does, since it applies the
        // restrictive one already; "all" goes too, as index and follow are the default.
        const permissive = new Set(allow);

        return allowed.length > 0 && denied.length > 0
          ? [
              make(
                `The page says ${allowed.join(" and ")} but also ${denied.join(" and ")}; Google applies ${wins}.`,
                {
                  fix: directiveEdits(
                    page,
                    response,
                    GOOGLE_NAMES,
                    forGoogle,
                    (d) => (permissive.has(d) ? null : d),
                    `Google already applies ${wins}, so this changes nothing in search. If the page should be ${wins === "noindex" ? "indexed" : "followed"}, remove ${wins} instead.`
                  ),
                  key: wins,
                  evidence: { allow: allowed, deny: denied, applied: wins },
                }
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

      const meant = new Map(
        misread.map((m) => [
          squash(m.directive.toLowerCase()),
          m.meant.join(", "),
        ])
      );

      return make(
        `${misread.length === 1 ? "A robots directive is" : `${misread.length} robots directives are`} not written the way Google documents: ${cap(listed, 5).join("; ")}.`,
        {
          severity: misspelled ? "warning" : "info",
          fix: directiveEdits(
            page,
            response,
            GOOGLE_NAMES,
            forGoogle,
            (d) => meant.get(squash(d)) ?? d
          ),
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
