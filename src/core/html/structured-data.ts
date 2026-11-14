import { isTag } from "domhandler";

import type { StructuredDataError, StructuredDataItem } from "../types.js";
import {
  attr,
  childElements,
  detached,
  hasAttr,
  queryAll,
  text,
} from "./dom.js";
import type { Document, Element } from "./dom.js";
import { collapseWhitespace } from "./text.js";

/** A value JSON.parse returns: all that a JSON-LD block or a microdata item can hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

/** A JSON-LD node or a microdata item: whatever properties the page gave it. */
export interface JsonObject {
  [property: string]: JsonValue;
}

/** Whether a structured-data value is a string. */
export const isString = (value: JsonValue | undefined): value is string =>
  typeof value === "string";

/** Whether a structured-data value is a JSON number. */
export const isNumber = (value: JsonValue | undefined): value is number =>
  typeof value === "number";

/** Whether a structured-data value is an object with properties, rather than a list or a scalar. */
export const isJsonObject = (
  value: JsonValue | undefined
): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface StructuredDataExtraction {
  items: StructuredDataItem[];
  errors: StructuredDataError[];
}

const stripCdata = (source: string): string =>
  source
    .replace(/^\s*<!--/u, "")
    .replace(/--!?>\s*$/u, "")
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//u, "")
    .replace(/\/\*\s*\]\]>\s*\*\/\s*$/u, "")
    .replace(/^\s*<!\[CDATA\[/u, "")
    .replace(/\]\]>\s*$/u, "");

/** `https://schema.org/Article` -> `Article`, `schema:Article` -> `Article`. */
export const shortType = (type: string): string => {
  const t = type.trim();
  const slash = t.lastIndexOf("/");
  const colon = t.lastIndexOf(":");
  const cut = Math.max(slash, t.startsWith("http") ? -1 : colon);

  return cut >= 0 ? t.slice(cut + 1) : t;
};

export const contextString = (value: JsonValue | undefined): string | null => {
  if (isString(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const v of value) {
      const s = contextString(v);

      if (s) {
        return s;
      }
    }

    return null;
  }

  if (isJsonObject(value)) {
    const vocab = value["@vocab"];

    if (isString(vocab)) {
      return vocab;
    }
  }

  return null;
};

export const typesOf = (value: JsonValue | undefined): string[] => {
  if (isString(value)) {
    return [shortType(value)];
  }

  if (Array.isArray(value)) {
    return value.filter(isString).map(shortType);
  }

  return [];
};

/**
 * A selector of one class and nothing else (`.paywall`), the only kind Google reads in a paywalled
 * section's `cssSelector`. One character class after a fixed start, so it cannot backtrack.
 */
export const isClassSelector = (value: string): boolean =>
  /^\.-?[_a-z -￿][-\w -￿]*$/iu.test(value.trim());

/** The `cssSelector` values a structured data value names, one per string, arrays included. */
export const cssSelectorValues = (value: JsonValue | undefined): string[] => {
  if (isString(value)) {
    return [value.trim()];
  }

  return Array.isArray(value)
    ? value.filter(isString).map((v) => v.trim())
    : [];
};

/** How many distinct `cssSelector` classes the extractor looks up in the HTML. */
export const MAX_CSS_SELECTORS = 20;

/**
 * The distinct `.class` selectors the page's structured data names in `cssSelector`, the first
 * `MAX_CSS_SELECTORS`, so the extractor can look each up in the HTML once.
 */
export const classSelectorsOf = (items: StructuredDataItem[]): string[] => {
  const found = new Set<string>();
  const seen = new Set<JsonValue>();
  let visited = 0;

  const walk = (value: JsonValue | undefined, depth: number): void => {
    if (depth > 8 || visited >= 5000 || found.size >= MAX_CSS_SELECTORS) {
      return;
    }

    if (Array.isArray(value)) {
      for (const v of value) {
        walk(v, depth);
      }

      return;
    }

    if (!isJsonObject(value) || seen.has(value)) {
      return;
    }

    seen.add(value);
    visited += 1;

    for (const [key, v] of Object.entries(value)) {
      if (key === "cssSelector") {
        for (const selector of cssSelectorValues(v)) {
          if (isClassSelector(selector) && found.size < MAX_CSS_SELECTORS) {
            found.add(selector);
          }
        }
      } else {
        walk(v, depth + 1);
      }
    }
  };

  for (const item of items) {
    // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
    walk(item.data as JsonObject, 0);
  }

  return [...found];
};

const flattenJsonLd = (
  node: JsonValue,
  inheritedContext: string | null,
  scriptText: string
): StructuredDataItem[] => {
  if (Array.isArray(node)) {
    return node.flatMap((n) => flattenJsonLd(n, inheritedContext, scriptText));
  }

  if (!isJsonObject(node)) {
    return [];
  }

  const context = contextString(node["@context"]) ?? inheritedContext;
  const graph = node["@graph"];

  if (Array.isArray(graph)) {
    return graph.flatMap((n) => flattenJsonLd(n, context, scriptText));
  }

  return [
    {
      source: "json-ld",
      types: typesOf(node["@type"]),
      context,
      data: node,
      scriptText,
    },
  ];
};

/* ---------------------------------------------------------------------------
 * Microdata
 * ------------------------------------------------------------------------- */

/** Elements whose microdata value is always one attribute, empty when it is missing. */
const URL_VALUE_ATTRIBUTES = new Map([
  ["meta", "content"],
  ["img", "src"],
  ["audio", "src"],
  ["embed", "src"],
  ["iframe", "src"],
  ["source", "src"],
  ["track", "src"],
  ["video", "src"],
  ["a", "href"],
  ["area", "href"],
  ["link", "href"],
  ["object", "data"],
]);

/** Elements whose microdata value is an attribute other than `content`, or else their text. */
const TEXT_VALUE_ATTRIBUTES = new Map([
  ["data", "value"],
  ["meter", "value"],
  ["time", "datetime"],
]);

const microdataValue = (el: Element): string => {
  const tag = el.name.toLowerCase();
  const urlAttribute = URL_VALUE_ATTRIBUTES.get(tag);

  if (urlAttribute) {
    return attr(el, urlAttribute) ?? "";
  }

  return (
    attr(el, TEXT_VALUE_ATTRIBUTES.get(tag) ?? "content") ??
    collapseWhitespace(text(el))
  );
};

/** Walk descendants, stopping at nested itemscopes (they are added as a single property). */
const collectProps = (root: Element, out: Element[]): void => {
  for (const child of childElements(root)) {
    if (hasAttr(child, "itemprop")) {
      out.push(child);
    }

    if (!hasAttr(child, "itemscope")) {
      collectProps(child, out);
    }
  }
};

/** Whether an element sits inside another itemscope, which makes it a property, not an item. */
const hasItemscopeAncestor = (el: Element): boolean => {
  for (let p = el.parent; p && isTag(p); p = p.parent) {
    if (hasAttr(p, "itemscope")) {
      return true;
    }
  }

  return false;
};

const microdataObject = (scope: Element): JsonObject => {
  const obj: JsonObject = {};
  const itemtype = attr(scope, "itemtype");

  if (itemtype) {
    const types = itemtype.split(/\s+/u).filter(Boolean);
    const [first] = types;
    obj["@type"] = types.length === 1 && first ? first : types;

    if (first) {
      try {
        const u = new URL(first);
        obj["@context"] = `${u.protocol}//${u.host}`;
      } catch {
        /* not a URL */
      }
    }
  }

  const itemid = attr(scope, "itemid");

  if (itemid) {
    obj["@id"] = itemid;
  }

  const props: Element[] = [];
  collectProps(scope, props);

  for (const el of props) {
    const names = (attr(el, "itemprop") ?? "").split(/\s+/u).filter(Boolean);

    const value = hasAttr(el, "itemscope")
      ? microdataObject(el)
      : microdataValue(el);

    for (const name of names) {
      const existing = obj[name];

      if (existing === undefined) {
        obj[name] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        obj[name] = [existing, value];
      }
    }
  }

  return obj;
};

const extractMicrodata = (doc: Document): StructuredDataItem[] => {
  const items: StructuredDataItem[] = [];

  for (const el of queryAll(doc, "[itemscope]")) {
    // Top-level scopes only: nested scopes become property values.
    if (hasItemscopeAncestor(el)) {
      continue;
    }

    const data = microdataObject(el);
    items.push({
      source: "microdata",
      types: typesOf(data["@type"]),
      context: contextString(data["@context"]),
      data,
    });
  }

  return items;
};

/** The script text a fix may quote; past it a fix describes the edit instead. */
const MAX_SCRIPT_TEXT = 20_000;

export const extractStructuredData = (
  doc: Document
): StructuredDataExtraction => {
  const items: StructuredDataItem[] = [];
  const errors: StructuredDataError[] = [];

  let script = -1;

  for (const el of queryAll(doc, "script[type]")) {
    const type = (attr(el, "type") ?? "").trim().toLowerCase();

    if (type !== "application/ld+json") {
      continue;
    }

    script += 1;
    // Script text is raw text in HTML, so this is the source as written. Kept on every item and
    // error, so a copy: a slice would keep the whole script alive.
    const written = detached(text(el).slice(0, MAX_SCRIPT_TEXT));
    const raw = text(el).trim();

    if (!raw) {
      errors.push({
        source: "json-ld",
        message: "Empty JSON-LD script block",
        snippet: "",
        script,
        text: written,
      });

      continue;
    }

    let parsed: JsonValue;

    try {
      parsed = JSON.parse(stripCdata(raw));
    } catch (error) {
      errors.push({
        source: "json-ld",
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        snippet: detached(raw.slice(0, 200)),
        script,
        text: written,
      });

      continue;
    }

    for (const node of flattenJsonLd(parsed, null, written)) {
      items.push(node);
    }
  }

  for (const item of extractMicrodata(doc)) {
    items.push(item);
  }

  return { items, errors };
};
