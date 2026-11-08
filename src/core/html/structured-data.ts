import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";

import type { StructuredDataError, StructuredDataItem } from "../types.js";
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

/** Whether a structured-data value is an object with properties, rather than a list or a scalar. */
export const isJsonObject = (
  value: JsonValue | undefined
): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface StructuredDataExtraction {
  items: StructuredDataItem[];
  errors: StructuredDataError[];
}

const stripCdata = (text: string): string =>
  text
    .replace(/^\s*<!--/u, "")
    .replace(/-->\s*$/u, "")
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

const flattenJsonLd = (
  node: JsonValue,
  inheritedContext: string | null
): StructuredDataItem[] => {
  if (Array.isArray(node)) {
    return node.flatMap((n) => flattenJsonLd(n, inheritedContext));
  }

  if (!isJsonObject(node)) {
    return [];
  }

  const context = contextString(node["@context"]) ?? inheritedContext;
  const graph = node["@graph"];

  if (Array.isArray(graph)) {
    return graph.flatMap((n) => flattenJsonLd(n, context));
  }

  return [
    { source: "json-ld", types: typesOf(node["@type"]), context, data: node },
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

const microdataValue = ($: CheerioAPI, el: Element): string => {
  const $el = $(el);
  const tag = el.tagName.toLowerCase();
  const urlAttribute = URL_VALUE_ATTRIBUTES.get(tag);

  if (urlAttribute) {
    return $el.attr(urlAttribute) ?? "";
  }

  return (
    $el.attr(TEXT_VALUE_ATTRIBUTES.get(tag) ?? "content") ??
    collapseWhitespace($el.text())
  );
};

/** Walk descendants, stopping at nested itemscopes (they are added as a single property). */
const collectProps = ($: CheerioAPI, root: Element, out: Element[]): void => {
  const children = $(root).children().toArray();

  for (const child of children) {
    const hasProp = $(child).is("[itemprop]");

    if (hasProp) {
      out.push(child);
    }

    if (!$(child).is("[itemscope]")) {
      collectProps($, child, out);
    }
  }
};

const microdataObject = ($: CheerioAPI, scope: Element): JsonObject => {
  const obj: JsonObject = {};
  const itemtype = $(scope).attr("itemtype");

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

  const itemid = $(scope).attr("itemid");

  if (itemid) {
    obj["@id"] = itemid;
  }

  const props: Element[] = [];
  collectProps($, scope, props);

  for (const el of props) {
    const names = ($(el).attr("itemprop") ?? "").split(/\s+/u).filter(Boolean);

    const value = $(el).is("[itemscope]")
      ? microdataObject($, el)
      : microdataValue($, el);

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

const extractMicrodata = ($: CheerioAPI): StructuredDataItem[] => {
  const items: StructuredDataItem[] = [];
  $("[itemscope]").each((_, el) => {
    // Top-level scopes only: nested scopes become property values.
    if ($(el).parents("[itemscope]").length > 0) {
      return;
    }

    const data = microdataObject($, el);
    items.push({
      source: "microdata",
      types: typesOf(data["@type"]),
      context: contextString(data["@context"]),
      data,
    });
  });

  return items;
};

export const extractStructuredData = (
  $: CheerioAPI
): StructuredDataExtraction => {
  const items: StructuredDataItem[] = [];
  const errors: StructuredDataError[] = [];

  $("script[type]").each((_, el) => {
    const type = ($(el).attr("type") ?? "").trim().toLowerCase();

    if (type !== "application/ld+json") {
      return;
    }

    const raw = $(el).text().trim();

    if (!raw) {
      errors.push({
        source: "json-ld",
        message: "Empty JSON-LD script block",
        snippet: "",
      });

      return;
    }

    let parsed: JsonValue;

    try {
      parsed = JSON.parse(stripCdata(raw));
    } catch (error) {
      errors.push({
        source: "json-ld",
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        snippet: raw.slice(0, 200),
      });

      return;
    }

    for (const node of flattenJsonLd(parsed, null)) {
      items.push(node);
    }
  });

  for (const item of extractMicrodata($)) {
    items.push(item);
  }

  return { items, errors };
};
