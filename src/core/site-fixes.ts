/**
 * The edits that fix site-wide findings: robots.txt lines, sitemap entries, server responses and
 * the links, canonicals and titles of the pages a site rule names. Each edit says which file or
 * response it changes with `url`, since a site finding belongs to no single page.
 */
import { DEFAULT_USER_AGENT } from "./fetch.js";
import { quote } from "./html/dom.js";
import { robotsUserAgentToken, ruleLineMatcher } from "./robots.js";
import {
  addEdit,
  escapeAttribute,
  removeEdit,
  replaceEdit,
  setAttributeEdit,
  slot,
  withAttribute,
  withContent,
} from "./rules/fix.js";
import { isoDate } from "./rules/structured-data-fixes.js";
import type { PageRecord } from "./site-rules.js";
import type { SitemapLayout } from "./sitemap.js";
import type { FixEdit, ImageInfo, LinkInfo } from "./types.js";
import { resolveUrl } from "./url.js";

/**
 * The most edits a site fix builds. `finding()` keeps the first 10 of any longer list, but a fix
 * that reads a site's robots.txt or every crawled page could build thousands first.
 */
export const MAX_EDITS = 10;

/** `e` with `url` set, in the key order an edit reads in. */
export const onUrl = (e: FixEdit, url: string): FixEdit => {
  const { in: target, action, ...rest } = e;

  return { in: target, action, url, ...rest };
};

const REASONS = new Map<number, string>([
  [200, "OK"],
  [301, "Moved Permanently"],
  [302, "Found"],
  [303, "See Other"],
  [307, "Temporary Redirect"],
  [308, "Permanent Redirect"],
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [410, "Gone"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
]);

/** An HTTP status line, or what happened when there was no response. */
export const statusLine = (status: number | null, error?: string): string => {
  if (status === null) {
    return `no response (${error ?? "the request failed"})`;
  }

  const reason = REASONS.get(status);

  return `HTTP/1.1 ${status}${reason ? ` ${reason}` : ""}`;
};

/** A permanent redirect to `location`; 308 keeps the method, for a redirect that was 307 or 308. */
export const redirectTo = (location: string, keepMethod = false): string =>
  `${statusLine(keepMethod ? 308 : 301)}\nLocation: ${location}`;

/** Text for an XML element, such as a sitemap <loc>. */
export const xmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** A sitemap <loc> element, as a generator writes it. */
export const locOf = (url: string): string => `<loc>${xmlText(url)}</loc>`;

/** A value for a double-quoted CSS attribute selector. */
const cssString = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** The path, query and fragment of `url`: how a page links to its own site. */
export const pathOf = (url: string): string => {
  const u = parse(url);

  return u ? `${u.pathname}${u.search}${u.hash}` : url;
};

/**
 * `target` written the way `original` was: absolute when the page wrote an absolute URL, else from
 * the root. A fragment the page wrote is kept.
 */
export const hrefLike = (
  original: string,
  target: string,
  pageUrl: string
): string => {
  const to = parse(target);
  const from = parse(pageUrl);

  const hash = original.includes("#")
    ? original.slice(original.indexOf("#"))
    : "";

  if (!to) {
    return target;
  }

  if (!to.hash && hash) {
    to.hash = hash;
  }

  const absolute =
    /^[a-z][\d+.a-z-]*:/iu.test(original) || original.startsWith("//");

  return absolute || !from || from.origin !== to.origin
    ? to.href
    : pathOf(to.href);
};

/** A CSS selector for a link, by the href the page wrote. */
export const linkSelector = (link: LinkInfo): string =>
  `a[href="${cssString(link.href)}"]`;

/** The edit that points the link `link` on page `pageUrl` at `href` (exact, or a `{{…}}` slot). */
export const relinkEdit = (
  pageUrl: string,
  link: LinkInfo,
  href: string,
  write?: string
): FixEdit =>
  onUrl(
    setAttributeEdit(
      link.tag,
      linkSelector(link),
      "href",
      href.startsWith("{{") ? href : escapeAttribute(href),
      write
    ),
    pageUrl
  );

/** The edit that adds a link to `target` on page `from`, in its navigation or footer. */
export const addLinkEdit = (
  from: string,
  target: string,
  write: string
): FixEdit =>
  addEdit(
    "html",
    "nav, footer",
    `<a href="${escapeAttribute(pathOf(target))}">${slot("link text")}</a>`,
    { url: from, write }
  );

/* robots.txt */

const USER_AGENT_LINE = /^\s*user-agent\s*:/iu;

/**
 * robots.txt split into lines, each without its line ending. A lone CR ends a line too, as in
 * robots-parser, so line numbers match the ones it reports.
 */
export const linesOf = (text: string): string[] => text.split(/\r\n|\r|\n/u);

/**
 * The first `User-agent:` line of the group that holds line `index` (0-based): the line an agent
 * finds the group by.
 */
export const groupHeader = (lines: string[], index: number): string | null => {
  let i = index;

  while (i >= 0 && !USER_AGENT_LINE.test(lines[i] ?? "")) {
    i -= 1;
  }

  if (i < 0) {
    return null;
  }

  while (i > 0 && USER_AGENT_LINE.test(lines[i - 1] ?? "")) {
    i -= 1;
  }

  return quote((lines[i] ?? "").trim());
};

/** The crawler token this audit's requests send, which robots.txt groups match on. */
const CRAWLER = robotsUserAgentToken(DEFAULT_USER_AGENT);

/** The last robots.txt parsed, so the fixes for a site's many blocked URLs parse it once. */
let parsed: {
  url: string;
  text: string;
  match: ReturnType<typeof ruleLineMatcher>;
} | null = null;

/** The robots.txt line (0-based) whose rule blocks `target` for `agent`, or -1. */
const blockingLine = (
  robotsUrl: string,
  text: string,
  target: string,
  agent: string
): number => {
  if (parsed?.url !== robotsUrl || parsed.text !== text) {
    parsed = { url: robotsUrl, text, match: ruleLineMatcher(robotsUrl, text) };
  }

  return parsed.match(target, agent) - 1;
};

export const robotsMissingFix = (
  robotsUrl: string,
  sitemapUrl: string
): FixEdit[] => [
  addEdit(
    "robots.txt",
    "new file",
    `User-agent: *\nDisallow:\n\nSitemap: ${sitemapUrl}`,
    {
      url: robotsUrl,
      write:
        "Serve it as a plain-text file at the site root (public/robots.txt, or app/robots.ts in Next.js).",
    }
  ),
];

export const robotsErrorFix = (
  robotsUrl: string,
  status: number | null,
  error?: string
): FixEdit[] => [
  replaceEdit(
    "http",
    statusLine(status, error),
    `${statusLine(200)}\nContent-Type: text/plain`,
    {
      url: robotsUrl,
      write:
        "Serve robots.txt as a static file. A site without one should answer 404, which Google reads as permission to crawl everything.",
    }
  ),
];

/** Replaces the rule that blocks the start URL with an empty Disallow, which allows everything. */
export const robotsBlocksAllFix = (
  robotsUrl: string,
  text: string,
  startUrl: string
): FixEdit[] => {
  const lines = linesOf(text);

  const write =
    "Keep a Disallow that blocks the whole site only on a staging or preview host that must stay out of search.";

  for (const agent of [CRAWLER, "Googlebot"]) {
    const index = blockingLine(robotsUrl, text, startUrl, agent);
    const line = lines[index]?.trim();

    if (index >= 0 && line && /^disallow\s*:/iu.test(line)) {
      return [
        replaceEdit("robots.txt", quote(line), "Disallow:", {
          url: robotsUrl,
          at: groupHeader(lines, index) ?? undefined,
          write,
        }),
      ];
    }
  }

  return [
    addEdit("robots.txt", "User-agent: *", "Allow: /", {
      url: robotsUrl,
      write: `Add it to the group that blocks the site and remove that group's Disallow lines that match /. ${write}`,
    }),
  ];
};

/** The Disallow line that blocks `target` for this crawler, quoted for a `write`. */
export const blockingRule = (
  robotsUrl: string,
  text: string,
  target: string
): string | null => {
  const index = blockingLine(robotsUrl, text, target, CRAWLER);
  // The rule without its comment: the site wrote the line, and a padded comment could be huge.
  const line = linesOf(text)[index]?.replace(/#.*$/u, "").trim();

  return index >= 0 && line ? quote(line) : null;
};

/**
 * Cuts robots.txt at the last line Google reads: the rules after it are ignored, so the file should
 * end there once the ones that matter are folded in above.
 */
export const robotsTooLargeFix = (
  robotsUrl: string,
  text: string,
  bytes: number
): FixEdit[] => {
  const lines = linesOf(text);
  // `text` stops at 500 KiB, so its last line may be cut: the one before it is whole.
  const last = lines.length > 1 ? lines.length - 2 : 0;
  const line = (lines[last] ?? "").trim();

  return [
    removeEdit("robots.txt", quote(line), {
      url: robotsUrl,
      at: `line ${last + 1} to the end of the file`,
      write: `Google stops reading at 500 KiB, near this line (line ${last + 1}); the file is ${Math.round(bytes / 1024)} KiB. Delete this line and every line after it once the rules that matter are moved above it, folded into patterns (Disallow: /*?sort= instead of one line per URL); delete rules for paths that no longer exist.`,
    }),
  ];
};

const RETIRED_FIELD = /^(?:noindex|nofollow)\s*:/iu;
const CRAWL_DELAY = /^crawl-delay\s*:/iu;

/** Removes noindex:, nofollow: and crawl-delay: lines; a noindex path gets an X-Robots-Tag header instead. */
export const robotsUnsupportedFix = (
  robotsUrl: string,
  text: string
): FixEdit[] => {
  const lines = linesOf(text);
  const origin = parse(robotsUrl)?.origin ?? "";
  const edits: FixEdit[] = [];

  let header: string | undefined;

  for (const [index, raw] of lines.slice(0, 50_000).entries()) {
    // A robots.txt of nothing but noindex: lines would otherwise build two edits per line.
    if (edits.length >= MAX_EDITS) {
      break;
    }

    const line = raw.replace(/#.*$/u, "").trim();

    // The group's first User-agent line, kept in this one pass: groupHeader per line scans back to
    // it, which on a 500 KiB robots.txt is quadratic.
    if (
      USER_AGENT_LINE.test(raw) &&
      !USER_AGENT_LINE.test(lines[index - 1] ?? "")
    ) {
      header = quote(raw.trim());
    }

    const at = header;

    if (RETIRED_FIELD.test(line)) {
      edits.push(
        removeEdit("robots.txt", quote(raw.trim()), {
          url: robotsUrl,
          at,
          write: "Google has not read noindex: or nofollow: lines since 2019.",
        })
      );

      const path = quote(line.slice(line.indexOf(":") + 1).trim());

      if (/^noindex/iu.test(line) && path.startsWith("/")) {
        edits.push(
          addEdit("http", "X-Robots-Tag", "X-Robots-Tag: noindex", {
            url: `${origin}${path.replace(/\*.*$/u, "")}`,
            write: `On every URL under ${path}, in the server or CDN config. Google sees the header only on URLs robots.txt lets it fetch.`,
          })
        );
      }
    } else if (CRAWL_DELAY.test(line)) {
      edits.push(
        removeEdit("robots.txt", quote(raw.trim()), {
          url: robotsUrl,
          at,
          write:
            "Only if it was meant for Google, which ignores it. Bing and Yandex read crawl-delay: keep it if their crawl rate matters.",
        })
      );
    }
  }

  return edits.slice(0, MAX_EDITS);
};

/** The directory of a URL's path and its file extension: /assets/app.js → ["/assets/", ".js"]. */
const folderAndType = (url: string): [string, string] | null => {
  const u = parse(url);

  if (!u) {
    return null;
  }

  const folder = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  const match = /\.[\da-z]+$/iu.exec(u.pathname);

  return [folder, match ? match[0].toLowerCase() : ""];
};

/**
 * Allow lines for the scripts and stylesheets robots.txt keeps from Googlebot, added to the group
 * that blocks them: a longer Allow pattern wins over the Disallow that matched.
 */
export const blockedResourcesFix = (
  robotsUrl: string,
  text: string,
  resources: string[]
): FixEdit[] => {
  const lines = linesOf(text);
  const byGroup = new Map<string, Set<string>>();

  for (const url of resources) {
    const index = blockingLine(robotsUrl, text, url, "Googlebot");
    const header = groupHeader(lines, index) ?? "User-agent: *";
    const parts = folderAndType(url);

    if (!parts) {
      continue;
    }

    const [folder, type] = parts;
    const allow = type ? `Allow: ${folder}*${type}` : `Allow: ${pathOf(url)}`;
    const set = byGroup.get(header) ?? new Set<string>();
    set.add(allow);
    byGroup.set(header, set);
  }

  return [...byGroup].map(([header, allows]) =>
    addEdit("robots.txt", header, [...allows].join("\n"), {
      url: robotsUrl,
      write: "Next to the group's Disallow lines.",
    })
  );
};

/* sitemaps */

/** The sitemap file that lists `loc`, or the only one there is. */
export const sitemapFileOf = (
  layout: SitemapLayout,
  loc: string
): string | undefined =>
  layout.sitemapOf.get(loc) ??
  (layout.urlsets.length === 1 ? layout.urlsets[0] : undefined);

/** Removes the sitemap entry of `loc`. */
export const removeFromSitemap = (
  layout: SitemapLayout,
  loc: string,
  why: string
): FixEdit =>
  removeEdit("sitemap", locOf(loc), {
    url: sitemapFileOf(layout, loc),
    write: `Remove the whole <url> element that holds this <loc>: ${why}`,
  });

/** Points the sitemap entry of `loc` at `to`. */
export const replaceInSitemap = (
  layout: SitemapLayout,
  loc: string,
  to: string
): FixEdit =>
  replaceEdit("sitemap", locOf(loc), locOf(to), {
    url: sitemapFileOf(layout, loc),
  });

const URLSET_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

/** The most URLs a fix writes out; the rest go in a slot. */
const MAX_LISTED_URLS = 50;

/** One `<url>` line per URL, up to `MAX_LISTED_URLS`, then a slot for the rest. */
const urlLines = (urls: string[]): string[] => {
  const lines = urls
    .slice(0, MAX_LISTED_URLS)
    .map((u) => `  <url>${locOf(u)}</url>`);

  if (urls.length > MAX_LISTED_URLS) {
    lines.push(
      `  ${slot(`a <url> for each of the other ${urls.length - MAX_LISTED_URLS} pages`)}`
    );
  }

  return lines;
};

const moreUrlsNote = (urls: string[]): string =>
  urls.length > MAX_LISTED_URLS
    ? ` The slot stands for the other ${urls.length - MAX_LISTED_URLS} pages this audit found; generate the list from the router or CMS.`
    : "";

/** A sitemap of the indexable pages, and the robots.txt line that names it. */
export const sitemapMissingFix = (
  sitemapUrl: string,
  pages: string[],
  robotsUrl: string | null
): FixEdit[] => {
  const edits = [
    addEdit(
      "sitemap",
      "new file",
      [URLSET_OPEN, ...urlLines(pages), "</urlset>"].join("\n"),
      {
        url: sitemapUrl,
        write: `Generate it from the routes (app/sitemap.ts in Next.js, @astrojs/sitemap, @nuxtjs/sitemap) so new pages are listed as they are added.${moreUrlsNote(pages)}`,
      }
    ),
  ];

  if (robotsUrl) {
    edits.push(
      addEdit("robots.txt", "end of file", `Sitemap: ${sitemapUrl}`, {
        url: robotsUrl,
      })
    );
  }

  return edits;
};

/** Adds the pages a sitemap misses to the sitemap that lists the site's pages. */
export const addToSitemapFix = (
  layout: SitemapLayout,
  urls: string[]
): FixEdit[] => {
  const [file] = layout.urlsets;

  const edit = addEdit(
    "sitemap",
    "before </urlset>",
    urlLines(urls).join("\n"),
    {
      url: file,
      write: `Better still, generate the sitemap from the routes so it stays complete.${moreUrlsNote(urls)}`,
    }
  );

  return [edit];
};

/** The URL and detail of a sitemap error message: "https://…/sitemap.xml: HTTP 500". */
const splitError = (message: string): [string, string] => {
  const at = message.indexOf(": ");

  return at === -1
    ? [message, ""]
    : [message.slice(0, at), message.slice(at + 2)];
};

/** What serves a sitemap that answers with an error, HTML or something that is not XML. */
export const sitemapErrorFix = (errors: string[], origin: string): FixEdit[] =>
  errors.map((message) => {
    const [where, detail] = splitError(message);
    const url = where.startsWith("/") && origin ? `${origin}${where}` : where;
    const status = /^HTTP (?<code>\d{3})$/u.exec(detail)?.groups?.code;

    if (status) {
      return replaceEdit(
        "http",
        statusLine(Number(status)),
        `${statusLine(200)}\nContent-Type: application/xml`,
        {
          url,
          write:
            "Serve the sitemap at this URL. If it should not exist, remove the Sitemap: line that names it from robots.txt instead.",
        }
      );
    }

    if (/HTML page/u.test(detail)) {
      return replaceEdit(
        "http",
        "Content-Type: text/html",
        "Content-Type: application/xml",
        {
          url,
          write:
            "Serve the sitemap XML at this URL; the app's HTML fallback page answers it now. Add the sitemap route, or a rewrite that comes before the fallback.",
        }
      );
    }

    if (/declared in robots\.txt|outside the output/u.test(detail)) {
      return addEdit(
        "sitemap",
        "new file",
        `${URLSET_OPEN}\n  <url><loc>${slot("page URL")}</loc></url>\n</urlset>`,
        {
          url,
          write:
            "Write the sitemap robots.txt names into the build output, one <url> per indexable page; or remove the Sitemap: line from robots.txt.",
        }
      );
    }

    if (
      /^no response|ETIMEDOUT|ECONN|ENOTFOUND|timed out|fetch failed/iu.test(
        detail
      )
    ) {
      return replaceEdit(
        "http",
        statusLine(null, detail),
        `${statusLine(200)}\nContent-Type: application/xml`,
        { url, write: "Make the sitemap answer quickly from this host." }
      );
    }

    return addEdit(
      "sitemap",
      "whole file",
      `${URLSET_OPEN}\n  <url><loc>${slot("page URL")}</loc></url>\n</urlset>`,
      {
        url,
        write: `Replace the file with valid sitemap XML (it ${detail || "could not be read"}): one <url> per indexable page, & written as &amp;. Serve it uncompressed or as valid gzip.`,
      }
    );
  });

/** sitemap.xml → sitemap-1.xml, the name of part `n` of a sitemap that is split. */
const partName = (sitemap: string, n: number): string => {
  const u = parse(sitemap);

  if (!u) {
    return `${sitemap}-${n}`;
  }

  const name = u.pathname.replace(/(?:\.xml)?(?:\.gz)?$/iu, "");
  u.pathname = `${name}-${n}.xml`;
  u.search = "";

  return u.href;
};

/**
 * A sitemap index of `parts` files, served where the one large sitemap was. `parts` can come from
 * the Content-Length the site declares, so only the first ones are written out.
 */
export const splitSitemapFix = (
  sitemap: string,
  parts: number,
  write: string
): FixEdit => {
  const listed = Math.min(parts, MAX_LISTED_URLS);
  const rest = parts - listed;

  return addEdit(
    "sitemap",
    "whole file",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...Array.from(
        { length: listed },
        (_, i) => `  <sitemap>${locOf(partName(sitemap, i + 1))}</sitemap>`
      ),
      ...(rest > 0
        ? [`  ${slot(`a <sitemap> for each of the other ${rest} parts`)}`]
        : []),
      "</sitemapindex>",
    ].join("\n"),
    {
      url: sitemap,
      write:
        rest > 0
          ? `${write} The slot stands for the other ${rest} parts, named the same way.`
          : write,
    }
  );
};

/** The longest URL the sitemap protocol allows. */
const MAX_LOC_LENGTH = 2048;

/** Lists a nested index's sitemaps in the index above it, in place of the nested index. */
export const nestedIndexFix = (
  layout: SitemapLayout,
  nested: string
): FixEdit => {
  const listed = layout.children.get(nested) ?? [];

  // The nested index is the site's own file and may list thousands of sitemaps, or URLs of any
  // length: past 50, or with one longer than the protocol allows, the slot says what to write.
  const children =
    listed.length <= MAX_LISTED_URLS &&
    listed.every((c) => c.length <= MAX_LOC_LENGTH)
      ? listed
      : [];

  return replaceEdit(
    "sitemap",
    locOf(nested),
    children.length > 0
      ? children.map((c) => `<sitemap>${locOf(c)}</sitemap>`).join("\n")
      : `<sitemap><loc>${slot("URL of each sitemap the nested index lists")}</loc></sitemap>`,
    {
      url: layout.parentOf.get(nested),
      write:
        children.length > 0
          ? "Replace the whole <sitemap> element that holds this <loc> with these, one per sitemap the nested index lists."
          : "Replace the whole <sitemap> element that holds this <loc> with one <sitemap> per sitemap the nested index lists.",
    }
  );
};

/** "https://…/a (2026-13-01)" → the URL and the value in brackets. */
const exampleParts = (example: string): [string, string] | null => {
  const open = example.indexOf(" (");

  return open === -1 || !example.endsWith(")")
    ? null
    : [example.slice(0, open), example.slice(open + 2, -1)];
};

const ISO_LIKE =
  /^(?<date>\d{4}-\d{2}-\d{2})[\sT]+(?<time>\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)\s*(?<zone>Z|[+-]\d{2}:?\d{2})?$/u;

/** A time of day in a date written out: the "10:00" of "Mon, 09 Nov 2026 10:00:00 GMT". */
const TIME_OF_DAY = /\b\d{1,2}:\d{2}/u;

/** The zone after a time of day: GMT, UTC, Z or an offset. */
const ZONE_AFTER = /\b(?:gmt|utc|z)\b|[+-]\d{2}:?\d{2}\b/iu;

/**
 * A lastmod value in W3C Datetime, when it says unambiguously which moment it means: a date and
 * time with a space instead of the T, a zone without its colon, a date written another way
 * (14 March 2026, 14/03/2026), or a date and time with a month name and a zone. Null for the rest:
 * 03/04/2026 could be March or April, and a time without a zone is a moment in the site's time
 * zone, which the audit does not know.
 */
export const toW3cDatetime = (value: string): string | null => {
  const v = value.trim();
  const iso = ISO_LIKE.exec(v)?.groups;

  if (iso?.date && iso.time) {
    const zone = iso.zone
      ? iso.zone.replace(
          /^(?<sign>[+-]\d{2})(?<minutes>\d{2})$/u,
          "$<sign>:$<minutes>"
        )
      : "";

    return `${iso.date}T${iso.time}${zone}`;
  }

  // A date alone is a calendar date: read it without this machine's time zone.
  const date = isoDate(v);

  if (date) {
    return date;
  }

  const time = TIME_OF_DAY.exec(v);

  if (
    time &&
    /[a-z]{3}/iu.test(v) &&
    /\b\d{4}\b/u.test(v) &&
    ZONE_AFTER.test(v.slice(time.index + time[0].length))
  ) {
    const moment = Date.parse(v);

    if (Number.isFinite(moment)) {
      return new Date(moment).toISOString().replace(/\.000Z$/u, "Z");
    }
  }

  return null;
};

/** Rewrites <lastmod> values that are not W3C Datetime, or lie in the future. */
export const lastmodFix = (
  layout: SitemapLayout,
  examples: string[],
  kind: "invalid" | "future",
  today: string
): FixEdit[] =>
  examples.flatMap((example) => {
    const parts = exampleParts(example);

    if (!parts) {
      return [];
    }

    const [loc, value] = parts;
    const fixed = kind === "invalid" ? toW3cDatetime(value) : null;

    return [
      replaceEdit(
        "sitemap",
        `<lastmod>${xmlText(value)}</lastmod>`,
        `<lastmod>${fixed ?? slot("date the page last changed")}</lastmod>`,
        {
          url: sitemapFileOf(layout, loc),
          at: locOf(loc),
          write: fixed
            ? undefined
            : `When ${loc} last changed in substance, as 2026-11-09 or 2026-11-09T10:00:00+01:00, no later than today (${today}). Write the same in the generator so every entry gets it.`,
        }
      ),
    ];
  });

const bareHost = (host: string): string => host.replace(/^www\./iu, "");

/**
 * URLs on another host: the www or bare-domain spelling of the site's own host is a slip, written
 * as the site's host; another host may list them when its own robots.txt names the sitemap.
 */
export const otherHostFix = (
  layout: SitemapLayout,
  examples: string[],
  siteOrigin: string
): FixEdit[] => {
  const site = parse(siteOrigin);
  const robotsFor = new Map<string, string>();
  const edits: FixEdit[] = [];

  for (const example of examples) {
    const parts = exampleParts(example);
    const loc = parts ? parse(parts[0]) : null;
    const sitemap = parts?.[1].replace(/^in /u, "");

    if (!parts || !loc || !sitemap) {
      continue;
    }

    if (site && bareHost(loc.hostname) === bareHost(site.hostname)) {
      // Appended, not resolved: a "//blog/post" path resolved against the origin names a host.
      const fixed = new URL(`${site.origin}${loc.pathname}${loc.search}`).href;
      edits.push(
        replaceEdit("sitemap", locOf(loc.href), locOf(fixed), { url: sitemap })
      );
    } else if (!robotsFor.has(loc.origin)) {
      robotsFor.set(loc.origin, sitemap);
    }
  }

  for (const [origin, sitemap] of robotsFor) {
    edits.push(
      addEdit("robots.txt", "end of file", `Sitemap: ${sitemap}`, {
        url: `${origin}/robots.txt`,
        write: `So Google accepts the ${origin} URLs this sitemap lists. If they are a staging or old domain by mistake, generate the sitemap from the production URL (${siteOrigin}) instead.`,
      })
    );
  }

  return edits;
};

/* pages a site rule names */

/** Where a page lives for an agent: its file in a directory audit, else its URL. */
export const locationOf = (record: PageRecord): string =>
  record.file ?? record.url;

/** The links on `record` whose target has the key `targetKey`. */
export const linksTo = (
  record: PageRecord,
  targetKey: string,
  key: (url: string) => string
): LinkInfo[] => {
  const seen = new Set<string>();

  return record.page.links.filter((l) => {
    if (!l.url || key(l.url) !== targetKey || seen.has(l.tag)) {
      return false;
    }

    seen.add(l.tag);

    return true;
  });
};

const SLOT_TITLE = "a title for this page";

/** Gives a page that shares its title with others a title of its own. */
export const retitleEdit = (record: PageRecord): FixEdit | null => {
  const { page } = record;

  const tag =
    page.title === null
      ? undefined
      : page.markup.titles[page.titles.indexOf(page.title)];

  if (tag === undefined) {
    return null;
  }

  return onUrl(
    replaceEdit(
      "html",
      tag,
      withContent(tag, slot(SLOT_TITLE)) ??
        `<title>${slot(SLOT_TITLE)}</title>`,
      {
        at: "head > title",
        write:
          "A title that says what this page has and the others do not: the product, place, topic or item name, then the site name if it fits (30-60 characters).",
      }
    ),
    locationOf(record)
  );
};

/** Gives a page that shares its meta description with others one of its own. */
export const redescribeEdit = (record: PageRecord): FixEdit | null => {
  const { page } = record;

  const tag =
    page.metaDescription === null
      ? undefined
      : page.markup.metaDescriptions[
          page.metaDescriptions.indexOf(page.metaDescription)
        ];

  if (tag === undefined) {
    return null;
  }

  return onUrl(
    setAttributeEdit(
      tag,
      'head > meta[name="description"]',
      "content",
      slot("a description of this page"),
      "A summary of what this page offers that no other page's description says, in 70-160 characters."
    ),
    locationOf(record)
  );
};

/** Gives a page that shares its <h1> with others one of its own. */
export const reheadEdit = (record: PageRecord): FixEdit | null => {
  const { page } = record;
  const index = page.headings.findIndex((h) => h.level === 1);
  const tag = page.markup.headings[index];

  if (index === -1 || tag === undefined) {
    return null;
  }

  return onUrl(
    replaceEdit(
      "html",
      tag,
      withContent(tag, slot("heading for this page")) ??
        `<h1>${slot("heading for this page")}</h1>`,
      {
        at: "h1",
        write:
          "The main topic of this page, in words that set it apart from the others.",
      }
    ),
    locationOf(record)
  );
};

/** Sets the canonical of `record` to `href`: rewrites its canonical link, or adds one. */
export const canonicalEdit = (
  record: PageRecord,
  href: string,
  write?: string
): FixEdit => {
  const [tag] = record.page.markup.canonicals;

  const edit = tag
    ? setAttributeEdit(
        tag,
        'link[rel="canonical"]',
        "href",
        escapeAttribute(href),
        write
      )
    : addEdit(
        "html",
        "head",
        `<link rel="canonical" href="${escapeAttribute(href)}">`,
        {
          write,
        }
      );

  return onUrl(edit, locationOf(record));
};

/** The hreflang link that lists `alternate` on `record`, on the page that does not link back. */
export const returnLinkEdit = (
  target: PageRecord,
  page: PageRecord,
  key: (url: string) => string
): FixEdit => {
  const selves = page.page.hreflang.filter(
    (h) => h.url && key(h.url) === key(page.url)
  );

  // A real language code before x-default, which some platforms write first: the return link
  // should say which language the page is, not only that it is the fallback.
  const self =
    selves.find((h) => h.lang.toLowerCase() !== "x-default") ?? selves[0];

  const lang = self?.lang ?? page.page.lang;

  return addEdit(
    "html",
    "head",
    `<link rel="alternate" hreflang="${lang ? escapeAttribute(lang) : slot("language code of the page")}" href="${escapeAttribute(page.url)}">`,
    {
      url: locationOf(target),
      write: lang
        ? undefined
        : `The hreflang code ${page.url} stands for, such as en or nl-nl; that page should list itself with the same code.`,
    }
  );
};

/** The `content` of a meta tag as written, or null. */
const contentOf = (tag: string): string | null => {
  const match =
    /\scontent\s*=\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<bare>[^\s"'>]+))/iu.exec(
      tag
    );

  return match?.groups?.dq ?? match?.groups?.sq ?? match?.groups?.bare ?? null;
};

/** Robots directives without noindex: "none" leaves nofollow. */
const withoutNoindex = (value: string): string =>
  value
    .split(",")
    .map((d) => d.trim())
    .flatMap((d) => {
      const lower = d.toLowerCase();

      if (lower === "noindex") {
        return [];
      }

      return lower === "none" ? ["nofollow"] : [d];
    })
    .filter(Boolean)
    .join(", ");

const isNoindex = (value: string): boolean =>
  value
    .toLowerCase()
    .split(",")
    .some((d) => ["noindex", "none"].includes(d.trim()));

/** The edits that take noindex off a page: its robots meta tags, or its X-Robots-Tag header. */
export const removeNoindexEdits = (
  record: PageRecord,
  write: string
): FixEdit[] => {
  const location = locationOf(record);
  const edits: FixEdit[] = [];

  for (const tag of record.page.markup.metaRobots) {
    const content = contentOf(tag);

    if (content === null || !isNoindex(content)) {
      continue;
    }

    const rest = withoutNoindex(content);

    const rewritten = rest
      ? withAttribute(tag, "content", escapeAttribute(rest))
      : null;

    edits.push(
      onUrl(
        rewritten
          ? replaceEdit("html", tag, rewritten, {
              at: 'meta[name="robots"]',
              write,
            })
          : removeEdit("html", tag, { at: 'meta[name="robots"]', write }),
        location
      )
    );
  }

  const header = record.response?.headers["x-robots-tag"];

  if (header && isNoindex(header)) {
    const rest = withoutNoindex(header);
    const current = `X-Robots-Tag: ${header}`;

    edits.push(
      rest
        ? replaceEdit("http", current, `X-Robots-Tag: ${rest}`, {
            url: record.url,
            write,
          })
        : removeEdit("http", current, { url: record.url, write })
    );
  }

  return edits;
};

/** The `<img>` tags on `record` that show the image at `url`. */
export const imagesOf = (record: PageRecord, url: string): ImageInfo[] =>
  record.page.images.filter(
    (img) => img.src !== null && resolveUrl(img.src, record.page.url) === url
  );
