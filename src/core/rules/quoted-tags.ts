/**
 * Reading the tags a page quotes (`PageMarkup`, `ImageInfo.tag`) for the fixes of the page rules:
 * attribute values, CSS selectors that find one element, and URLs as the live site should write
 * them.
 */
import { slot } from "./fix.js";

/*
 * One attribute of a start tag: optional whitespace or a stray "/", a name, then maybe "=" and a
 * value. The name and the separators share no character, so matching stays linear.
 */
const ATTRIBUTE =
  /[\s/]*(?<name>[^\s"'>/=]+)(?:\s*=\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<uq>[^\s>]+)))?/uy;

/**
 * The attributes of a quoted start tag, names lower-cased and values as written (character
 * references not decoded). The first of a repeated attribute wins, as in a browser. Null for a
 * quote cut short.
 */
export const readAttributes = (tag: string): Map<string, string> | null => {
  const name = /^<[^\s/>]+/u.exec(tag);

  if (!name || tag.endsWith("…")) {
    return null;
  }

  const out = new Map<string, string>();
  ATTRIBUTE.lastIndex = name[0].length;

  for (let m = ATTRIBUTE.exec(tag); m?.groups?.name; m = ATTRIBUTE.exec(tag)) {
    const key = m.groups.name.toLowerCase();

    if (!out.has(key)) {
      out.set(key, m.groups.dq ?? m.groups.sq ?? m.groups.uq ?? "");
    }
  }

  return out;
};

/** A value inside a double-quoted CSS attribute selector. */
const cssString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll(/[\n\r\f]/gu, " ");

/** `element[name="value"]`, the selector of the element with that attribute value. */
export const withAttributeSelector = (
  element: string,
  name: string,
  value: string
): string => `${element}[${name}="${cssString(value.slice(0, 200))}"]`;

/** The slot for the production origin, when the audit ran on a local or file URL. */
export const ORIGIN_SLOT = slot("production origin");

export const ORIGIN_WRITE =
  "The site's production origin, such as https://www.example.com: this audit ran on a local URL or a file, so it cannot know it.";

/**
 * `url` as the live site writes it: as it is, or with its origin left as a slot when the audit ran
 * on a local host or a file, whose origin is not the site's.
 */
export const liveUrl = (url: string, local: boolean): string => {
  if (!local) {
    return url;
  }

  try {
    const u = new URL(url);

    return `${ORIGIN_SLOT}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/**
 * `outer`, a whole element as quoted (`<h4 class="x">Text</h4>`), with its tag name changed in
 * the start and end tag; null when the quote was cut or does not end in that element's end tag.
 */
export const renamed = (
  outer: string,
  from: string,
  to: string
): string | null => {
  const start = new RegExp(`^<${from}(?=[\\s/>])`, "iu");
  const end = new RegExp(`</${from}\\s*>$`, "iu");

  if (outer.endsWith("…") || !start.test(outer) || !end.test(outer)) {
    return null;
  }

  return outer.replace(start, `<${to}`).replace(end, `</${to}>`);
};

/** What sits between the start tag and the end tag of a whole quoted element, or null. */
export const innerOf = (outer: string): string | null => {
  const open = outer.indexOf(">");
  const close = outer.lastIndexOf("</");

  if (outer.endsWith("…") || open === -1 || close < open) {
    return null;
  }

  return outer.slice(open + 1, close);
};
