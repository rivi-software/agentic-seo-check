/**
 * Builders for the `fix` of a finding: the exact edits that resolve it. Rules quote what the page
 * has (`PageMarkup`, `ImageInfo.tag`) and say what to write instead; `{{…}}` marks words only the
 * author can write.
 */
import type { FixEdit, FixTarget } from "../types.js";

/** A slot in `code` for words the author writes, such as a title: `{{hint}}`. */
export const slot = (hint: string): string => `{{${hint}}}`;

/** A value for a double-quoted HTML attribute. Text that would read as a character reference keeps its `&` escaped. */
export const escapeAttribute = (value: string): string =>
  value.replaceAll(/&(?=#?\w+;)/gu, "&amp;").replaceAll('"', "&quot;");

/** Text for an HTML element's content. */
export const escapeText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

interface EditOptions {
  url?: string;
  at?: string;
  write?: string;
}

const edit = (
  target: FixTarget,
  action: FixEdit["action"],
  parts: { current?: string; code?: string } & EditOptions
): FixEdit => {
  // Key order is the order an agent reads an edit in: what, where, what is there, what to write.
  const out: FixEdit = { in: target, action };

  if (parts.url) {
    out.url = parts.url;
  }

  if (parts.at) {
    out.at = parts.at;
  }

  if (parts.current !== undefined) {
    out.current = parts.current;
  }

  if (parts.code !== undefined) {
    out.code = parts.code;
  }

  if (parts.write) {
    out.write = parts.write;
  }

  return out;
};

/** Write `code` at `at` (a CSS selector: "head" adds to <head>) in `target`. */
export const addEdit = (
  target: FixTarget,
  at: string,
  code: string,
  options: Omit<EditOptions, "at"> = {}
): FixEdit => edit(target, "add", { ...options, at, code });

/** Swap `current` for `code` in `target`. */
export const replaceEdit = (
  target: FixTarget,
  current: string,
  code: string,
  options: EditOptions = {}
): FixEdit => edit(target, "replace", { ...options, current, code });

/** Delete `current` from `target`. */
export const removeEdit = (
  target: FixTarget,
  current: string,
  options: Omit<EditOptions, "write"> & { write?: string } = {}
): FixEdit => edit(target, "remove", { ...options, current });

export const addHtml = (at: string, code: string, write?: string): FixEdit =>
  addEdit("html", at, code, { write });

export const replaceHtml = (
  current: string,
  code: string,
  options: Omit<EditOptions, "url"> = {}
): FixEdit => replaceEdit("html", current, code, options);

export const removeHtml = (current: string, at?: string): FixEdit =>
  removeEdit("html", current, { at });

/** A quote the extractor cut short, which no longer matches the source as a whole. */
export const isCut = (quoted: string): boolean => quoted.endsWith("…");

interface AttributeSpan {
  name: string;
  /** Offset of the whitespace before the name. */
  start: number;
  end: number;
}

const isSpace = (ch: string | undefined): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";

/** The first offset from `i` on where `stop` holds, or the end of `text`. */
const scan = (
  text: string,
  i: number,
  stop: (ch: string | undefined) => boolean
): number => {
  let j = i;

  while (j < text.length && !stop(text[j])) {
    j += 1;
  }

  return j;
};

const notSpace = (ch: string | undefined): boolean => !isSpace(ch);

/** Where an attribute value that starts at `i` ends, or -1 when its quote never closes. */
const valueEnd = (tag: string, i: number): number => {
  const q = tag[i];

  if (q === '"' || q === "'") {
    const endQuote = tag.indexOf(q, i + 1);

    return endQuote === -1 ? -1 : endQuote + 1;
  }

  return scan(tag, i, (ch) => isSpace(ch) || ch === ">");
};

/** Where an attribute whose name ends at `i` ends: after its value, if it has one. */
const attributeEnd = (tag: string, i: number): number => {
  const eq = scan(tag, i, notSpace);

  return tag[eq] === "=" ? valueEnd(tag, scan(tag, eq + 1, notSpace)) : i;
};

const closesTag = (tag: string, i: number): boolean =>
  tag[i] === ">" || (tag[i] === "/" && tag[i + 1] === ">");

/**
 * The attributes of a start tag as written, read the way an HTML tokenizer does: a value in quotes
 * may hold anything, so `title="alt=x"` holds no alt attribute. Null for text that is not one
 * whole start tag.
 */
const attributesOf = (
  tag: string
): { spans: AttributeSpan[]; close: number } | null => {
  if (!tag.startsWith("<") || isCut(tag)) {
    return null;
  }

  const spans: AttributeSpan[] = [];
  let i = scan(tag, 1, (ch) => isSpace(ch) || ch === ">" || ch === "/");

  while (i < tag.length) {
    const start = i;
    i = scan(tag, i, (ch) => notSpace(ch) && ch !== "/");

    // A lone "/" between attributes is ignored, as the tokenizer does.
    while (tag[i] === "/" && tag[i + 1] !== ">") {
      i = scan(tag, i + 1, (ch) => notSpace(ch) && ch !== "/");
    }

    if (closesTag(tag, i)) {
      return { spans, close: start };
    }

    const nameEnd = scan(
      tag,
      i,
      (ch) => isSpace(ch) || "/>=".includes(ch ?? "")
    );

    const name = tag.slice(i, nameEnd).toLowerCase();
    i = attributeEnd(tag, nameEnd);

    if (i === -1) {
      return null;
    }

    spans.push({ name, start, end: i });
  }

  return null;
};

/**
 * `tag` with attribute `name` set to `value` (replaced where the tag has it, else added before the
 * `>`), or null when `tag` is not one whole start tag. `value` is written as given: escape it with
 * `escapeAttribute` unless it holds a `{{…}}` slot.
 */
export const withAttribute = (
  tag: string,
  name: string,
  value: string | true
): string | null => {
  const parsed = attributesOf(tag);

  if (!parsed) {
    return null;
  }

  // `true` writes a boolean attribute bare, the way authors write `defer` or `async`.
  const attribute = value === true ? ` ${name}` : ` ${name}="${value}"`;
  const lower = name.toLowerCase();
  const existing = parsed.spans.find((s) => s.name === lower);

  if (existing) {
    return `${tag.slice(0, existing.start)}${attribute}${tag.slice(existing.end)}`;
  }

  return `${tag.slice(0, parsed.close)}${attribute}${tag.slice(parsed.close)}`;
};

/** `tag` without attribute `name`, or null when `tag` is not one whole start tag. */
export const withoutAttribute = (tag: string, name: string): string | null => {
  const parsed = attributesOf(tag);

  if (!parsed) {
    return null;
  }

  const lower = name.toLowerCase();
  let out = tag;

  // Right to left, so earlier offsets stay valid.
  for (const span of parsed.spans.toReversed()) {
    if (span.name === lower) {
      out = `${out.slice(0, span.start)}${out.slice(span.end)}`;
    }
  }

  return out;
};

/**
 * The edit that sets attribute `name` on the element `tag` quotes: a replace of the whole tag when
 * it could be rewritten, else an add of the attribute on the element at `at`.
 */
export const setAttributeEdit = (
  tag: string | null,
  at: string,
  name: string,
  value: string | true,
  write?: string
): FixEdit => {
  const rewritten = tag ? withAttribute(tag, name, value) : null;

  if (tag && rewritten) {
    return replaceHtml(tag, rewritten, { at, write });
  }

  return addHtml(at, value === true ? name : `${name}="${value}"`, write);
};

/**
 * `outer`, an element quoted whole (`<title>Old</title>`), with `content` between its tags; null
 * when the quote was cut short.
 */
export const withContent = (outer: string, content: string): string | null => {
  const parsed = attributesOf(outer);
  const endTag = outer.lastIndexOf("</");

  if (!parsed || endTag === -1) {
    return null;
  }

  const startEnd = outer.indexOf(">", parsed.close) + 1;

  return `${outer.slice(0, startEnd)}${content}${outer.slice(endTag)}`;
};
