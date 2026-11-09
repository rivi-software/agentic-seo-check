/**
 * Helpers for the fixes of the response, social, structured data, URL, loading, content and
 * keyword rules: status lines, JSON-LD fragments quoted from the script that holds them, and URLs
 * with a parameter or an origin swapped.
 */
import { STATUS_CODES } from "node:http";

import type { JsonValue } from "../html/structured-data.js";
import type {
  ExtractedPage,
  FixEdit,
  PageSource,
  TextBlock,
} from "../types.js";
import { resolveUrl } from "../url.js";
import { isLocalHost } from "./canonical.js";
import { replaceHtml, slot, withContent } from "./fix.js";

/** An HTTP/1.1 status line: "HTTP/1.1 301 Moved Permanently". */
export const statusLine = (status: number): string => {
  const reason = STATUS_CODES[status];

  return reason ? `HTTP/1.1 ${status} ${reason}` : `HTTP/1.1 ${status}`;
};

/** The status and Location of a permanent redirect to `location`. */
export const permanentRedirect = (location: string): string =>
  `${statusLine(301)}\nLocation: ${location}`;

/** Where a JSON-LD object sits, for an edit's `at`: its script, its type and its path inside the script. */
export const jsonLdAt = (type: string, path = ""): string =>
  `script[type="application/ld+json"] > ${type}${path && path !== "(root)" ? ` at ${path}` : ""}`;

/** `text` as a regular expression that matches it literally. */
const literal = (text: string): string =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/**
 * `"key": value` as the script writes it (any spacing around the colon), or null when it is not
 * there verbatim, for instance because the script escapes a character the value holds.
 */
export const jsonProperty = (
  scriptText: string | undefined,
  key: string,
  value: JsonValue
): string | null => {
  const json = JSON.stringify(value);

  if (!scriptText || json === undefined) {
    return null;
  }

  // Both parts are escaped literals joined by \s*, so the pattern cannot backtrack. The lookahead
  // keeps `"position": 1` from matching the start of `"position": 10`.
  const match = new RegExp(
    `${literal(JSON.stringify(key))}\\s*:\\s*${literal(json)}(?![\\w.+-])`,
    "u"
  ).exec(scriptText);

  return match ? match[0] : null;
};

/** A JSON value for a JSON-LD fix, safe inside a <script>: "<" is escaped so "</script>" cannot end it. */
export const json = (value: JsonValue): string =>
  JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

/**
 * The origin to build absolute URLs from: the page's own, or a slot when the page is on a
 * development host or is HTML without a URL, where only the author knows the production origin.
 */
export const productionOrigin = (
  page: ExtractedPage,
  source: PageSource
): string => {
  if (source !== "html" && !isLocalHost(page.url)) {
    try {
      return new URL(page.url).origin;
    } catch {
      // Falls through to the slot.
    }
  }

  return slot("https://www.example.com");
};

/** What a production-origin slot needs, for `write`. */
export const ORIGIN_SLOT_WRITE =
  "The site's production origin (scheme and host, such as https://www.example.com), from the site URL setting rather than the development server.";

/** Whether a `productionOrigin` is a slot the author fills in. */
export const isSlot = (text: string): boolean => text.includes("{{");

/**
 * `raw`, a URL as an attribute writes it, without the query parameters `drop` selects (and a
 * `;jsessionid=` path parameter when `drop` selects "jsessionid"), written the way `raw` was:
 * absolute stays absolute, a path stays a path.
 */
export const withoutParameters = (
  raw: string,
  base: string,
  drop: (name: string) => boolean
): string => {
  const absolute = resolveUrl(raw, base);

  if (!absolute) {
    return raw;
  }

  const url = new URL(absolute);

  if (drop("jsessionid")) {
    url.pathname = url.pathname.replaceAll(/;jsessionid=[^/;]*/giu, "");
  }

  // A copy: deleting while the live iterator runs would skip the parameter after each one deleted.
  const names = [...url.searchParams.keys()];

  for (const name of names) {
    if (drop(name)) {
      url.searchParams.delete(name);
    }
  }

  const search = url.searchParams.size > 0 ? url.search : "";

  if (/^[a-z][\d+.a-z-]*:/iu.test(raw) || raw.startsWith("//")) {
    return `${raw.startsWith("//") ? "//" : `${url.protocol}//`}${url.host}${url.pathname}${search}${url.hash}`;
  }

  return `${url.pathname}${search}${url.hash}`;
};

/** Sentences of visible text that end in a full stop, question or exclamation mark. */
export const sentences = (text: string): string[] =>
  // Text after the last end mark matches too (`|$`), so a run without one is read once instead of
  // once from every position in it, which took seconds on a long paragraph; it is dropped after.
  [...text.matchAll(/[^.!?]+(?:[.!?]|$)/gu)].flatMap((m) =>
    /[.!?]$/u.test(m[0]) ? [m[0].trim()] : []
  );

/**
 * The edit that rewrites one text block: the element as written, with a slot for its content. A
 * block quoted cut short is rebuilt from its start tag, so the code is still whole.
 */
export const rewriteBlock = (
  block: TextBlock,
  hint: string,
  write: string
): FixEdit =>
  replaceHtml(
    block.outer,
    withContent(block.outer, slot(hint)) ??
      `${block.tag}${slot(hint)}</${block.name}>`,
    { at: block.name, write }
  );

/** The block of `blocks` that scores highest, or null when none scores above 0. */
export const bestBlock = (
  blocks: TextBlock[],
  score: (block: TextBlock) => number
): TextBlock | null => {
  let best: TextBlock | null = null;
  let top = 0;

  for (const block of blocks) {
    const value = score(block);

    if (value > top) {
      best = block;
      top = value;
    }
  }

  return best;
};
