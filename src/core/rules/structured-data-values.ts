import { isHomePage } from "../aeo/page.js";
import {
  isJsonObject,
  isNumber,
  isString,
  typesOf,
} from "../html/structured-data.js";
import type { JsonObject, JsonValue } from "../html/structured-data.js";
import type { StructuredDataItem } from "../types.js";
import { hostOf, resolveUrl } from "../url.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** Rich results Google no longer shows, keyed by the schema.org type that asked for them. */
export const RETIRED_RICH_RESULTS: ReadonlyMap<string, string> = new Map([
  ["FAQPage", "Google stopped showing FAQ rich results on May 7, 2026."],
  ["HowTo", "Google stopped showing How-to rich results in September 2023."],
  [
    "SpecialAnnouncement",
    "Google retired the special announcement feature in 2025.",
  ],
  [
    "ClaimReview",
    "Google is phasing out ClaimReview (fact check) rich results; its Fact Check Explorer still reads the markup.",
  ],
  [
    "SearchAction",
    "Google removed the sitelinks search box in November 2024; WebSite markup still sets the site name.",
  ],
]);

const SD =
  "https://developers.google.com/search/docs/appearance/structured-data/";

/** Properties whose value is a URL, a list of URLs, or an object that holds one. */
const URL_PROPERTIES = new Set([
  "url",
  "image",
  "logo",
  "thumbnailUrl",
  "contentUrl",
  "embedUrl",
  "item",
  "sameAs",
  "mainEntityOfPage",
]);

/** JSON-LD objects visited per page at most: a page's own data rarely holds more than a few hundred. */
const MAX_OBJECTS = 5000;

interface ObjectWalk {
  /** Every object was visited; false when the walk stopped at its depth or object limit. */
  complete: boolean;
}

/** Visit every JSON-LD object, nested ones included, with a dotted path to it. */
const eachObject = (
  items: StructuredDataItem[],
  visit: (node: JsonObject, path: string) => void
): ObjectWalk => {
  const seen = new Set<JsonObject>();
  let visited = 0;
  let complete = true;

  const walk = (value: JsonValue | undefined, path: string, depth: number) => {
    if (value === undefined) {
      return;
    }

    // Past the limits, objects go unvisited; a rule that needs all of them can tell. A string or
    // a number there is no object, so it costs nothing.
    if (depth > 8 || visited >= MAX_OBJECTS) {
      if (Array.isArray(value) || isJsonObject(value)) {
        complete = false;
      }

      return;
    }

    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) {
        walk(v, `${path}[${i}]`, depth);
      }

      return;
    }

    if (!isJsonObject(value) || seen.has(value)) {
      return;
    }

    seen.add(value);
    visited += 1;
    visit(value, path);

    for (const [key, v] of Object.entries(value)) {
      if (key !== "@context") {
        walk(v, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  for (const item of items) {
    if (item.source === "json-ld") {
      // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
      walk(item.data as JsonObject, "", 0);
    }
  }

  return { complete };
};

const show = (value: JsonValue | undefined): string =>
  JSON.stringify(value ?? null).slice(0, 80);

/** A JSON number, or a string holding one with a dot for decimals. */
const numeric = (value: JsonValue | undefined): number | null => {
  if (isNumber(value)) {
    return Number.isFinite(value) ? value : null;
  }

  return isString(value) && /^\s*-?\d+(?:\.\d+)?\s*$/u.test(value)
    ? Number(value)
    : null;
};

const priceProblems = (node: JsonObject): string[] => {
  const problems: string[] = [];

  for (const key of ["price", "lowPrice", "highPrice"]) {
    const value = node[key];

    if (value === undefined || value === null || numeric(value) !== null) {
      continue;
    }

    problems.push(
      isString(value) && /^\s*\d+,\d{1,2}\s*$/u.test(value)
        ? `${key} ${show(value)} uses a comma for decimals; write it with a dot`
        : `${key} ${show(value)} is not a plain number (no currency symbol, no thousands separator)`
    );
  }

  const currency = node["priceCurrency"];

  if (
    currency !== undefined &&
    !(isString(currency) && /^[a-z]{3}$/iu.test(currency.trim()))
  ) {
    problems.push(
      `priceCurrency ${show(currency)} is not a three-letter ISO 4217 code such as EUR or USD`
    );
  }

  return problems;
};

const ratingProblems = (node: JsonObject, types: string[]): string[] => {
  if (!types.some((t) => t.endsWith("Rating"))) {
    return [];
  }

  const problems: string[] = [];
  const value = node["ratingValue"];
  const rating = numeric(value);

  if (isString(value) && /^\s*\d+,\d+\s*$/u.test(value)) {
    problems.push(
      `ratingValue ${show(value)} uses a comma for decimals; write it with a dot`
    );
  } else if (rating !== null) {
    // Google assumes 5 and 1 when bestRating and worstRating are left out.
    const best = numeric(node["bestRating"]) ?? 5;
    const worst = numeric(node["worstRating"]) ?? 1;

    if (rating > best || rating < worst) {
      problems.push(
        `ratingValue ${rating} is outside ${worst}-${best}${node["bestRating"] === undefined ? " (bestRating defaults to 5; set it when the scale is 10 or 100)" : ""}`
      );
    }
  }

  for (const key of ["ratingCount", "reviewCount"]) {
    const count = node[key];

    if (count !== undefined && !/^\d+$/u.test(String(count).trim())) {
      problems.push(`${key} ${show(count)} is not a whole number`);
    }
  }

  return problems;
};

const breadcrumbProblems = (
  node: JsonObject,
  types: string[],
  isHome: boolean
): string[] => {
  if (!types.includes("BreadcrumbList")) {
    return [];
  }

  const raw = node["itemListElement"];
  const elements = (Array.isArray(raw) ? raw : [raw]).filter(isJsonObject);

  if (elements.length === 0) {
    return [];
  }

  const problems: string[] = [];

  // A home page's one-crumb trail (SEO plugins add one) is harmless: no trail is shown for it.
  if (elements.length < 2 && !isHome) {
    problems.push("Google needs at least two ListItems in a breadcrumb trail");
  }

  const positions = elements.map((e) => numeric(e["position"]));
  const known = positions.filter((p) => p !== null).toSorted((a, b) => a - b);

  if (known.length === elements.length && known.some((p, i) => p !== i + 1)) {
    problems.push(
      `positions are ${known.join(", ")}; number them 1, 2, 3 from the start of the trail`
    );
  }

  // The last crumb is the page itself and may leave out `item`; every other one needs it.
  const ordered = elements
    .map((e, i) => ({ e, position: positions[i] ?? i + 1 }))
    .toSorted((a, b) => a.position - b.position);

  const withoutItem = ordered
    .slice(0, -1)
    .filter(({ e }) => e["item"] === undefined || e["item"] === "");

  if (withoutItem.length > 0) {
    problems.push(
      `${withoutItem.length} ListItem(s) before the last have no item (the URL of that crumb)`
    );
  }

  return problems;
};

/** Google's page for the rich result a type with invalid values belongs to. */
const docsFor = (types: string[]): string => {
  if (types.includes("BreadcrumbList")) {
    return `${SD}breadcrumb`;
  }

  return types.some((t) => t.endsWith("Rating"))
    ? `${SD}review-snippet`
    : `${SD}product`;
};

/** A string that reads as a path rather than an absolute URL. */
const isRelativeUrl = (value: string): boolean => {
  const v = value.trim();

  if (!v || v.startsWith("#") || /^[a-z][\d+.a-z-]*:/iu.test(v)) {
    return false;
  }

  return (
    /^(?:\/|\.\.?\/)/u.test(v) ||
    /^[\w.-]+\/\S*$/u.test(v) ||
    /^[\w-]+\.(?:png|jpe?g|gif|webp|avif|svg)$/iu.test(v)
  );
};

/** An object that only points at another one by `@id`. */
const isReference = (node: JsonObject): boolean => {
  const keys = Object.keys(node);

  return keys.length === 1 && keys[0] === "@id" && isString(node["@id"]);
};

export const structuredDataValueRules = [
  defineRule(
    {
      id: "structured-data.retired-type",
      category: "structured-data",
      severity: "info",
      description:
        "The page has structured data for a rich result Google no longer shows: FAQPage, HowTo, SpecialAnnouncement, ClaimReview, or the sitelinks search box's SearchAction.",
      recommendation:
        "Do not spend effort on this markup for Google: it no longer earns a rich result, and its missing properties are not reported. Keep it if something else reads it (answer engines read FAQPage, for instance), or remove it if it only served the rich result.",
      docs: "https://developers.google.com/search/updates",
    },
    ({ page }, make) => {
      const found = new Map<string, number>();

      eachObject(page.structuredData, (node) => {
        for (const type of typesOf(node["@type"])) {
          if (RETIRED_RICH_RESULTS.has(type)) {
            found.set(type, (found.get(type) ?? 0) + 1);
          }
        }
      });

      return [...found].map(([type, count]) =>
        make(`${type} markup: ${RETIRED_RICH_RESULTS.get(type)}`, {
          selector: 'script[type="application/ld+json"]',
          evidence: { type, count },
        })
      );
    }
  ),
  defineRule(
    {
      id: "structured-data.invalid-value",
      category: "structured-data",
      severity: "warning",
      description:
        "A structured data value is in a form Google cannot use: a price with a currency symbol or a decimal comma, a currency that is not an ISO 4217 code, a rating outside its scale, or a breadcrumb trail with fewer than two items, odd positions or crumbs without a URL.",
      recommendation:
        'Write prices as plain numbers with a dot ("19.99") and the currency in priceCurrency ("EUR"); set bestRating when ratings are not out of 5; number breadcrumb positions 1, 2, 3 and give every crumb but the last an item URL.',
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) => {
      const findings: ReturnType<typeof make>[] = [];

      eachObject(page.structuredData, (node, path) => {
        const types = typesOf(node["@type"]);

        const problems = [
          ...priceProblems(node),
          ...ratingProblems(node, types),
          ...breadcrumbProblems(node, types, isHomePage(page.url)),
        ];

        if (problems.length > 0) {
          const type = types[0] ?? "object";

          findings.push(
            make(`${type}: ${problems.join("; ")}.`, {
              selector: 'script[type="application/ld+json"]',
              evidence: {
                type,
                path: path || "(root)",
                problems,
                docs: docsFor(types),
              },
            })
          );
        }
      });

      return findings;
    }
  ),
  defineRule(
    {
      id: "structured-data.relative-url",
      category: "structured-data",
      severity: "info",
      description:
        "A URL in JSON-LD (url, image, logo, item, sameAs, ...) is relative. JSON-LD does not resolve these properties against the page URL, and Google documents only absolute URLs.",
      recommendation:
        "Write absolute URLs in JSON-LD, built from the site's production URL: https://www.example.com/img/logo.png, not /img/logo.png.",
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) => {
      const relative: string[] = [];

      eachObject(page.structuredData, (node, path) => {
        for (const key of URL_PROPERTIES) {
          const value = node[key];
          const values = Array.isArray(value) ? value : [value];

          for (const v of values) {
            if (isString(v) && isRelativeUrl(v)) {
              relative.push(
                `${path ? `${path}.` : ""}${key}: ${v.slice(0, 120)}`
              );
            }
          }
        }
      });

      return relative.length > 0
        ? make(`${relative.length} URL(s) in JSON-LD are relative.`, {
            selector: 'script[type="application/ld+json"]',
            evidence: { count: relative.length, examples: cap(relative) },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "structured-data.dangling-id",
      category: "structured-data",
      severity: "info",
      description:
        'JSON-LD refers to an object by "@id" that no object on the page defines, so a reader of this page gets the id and none of the object\'s properties.',
      recommendation:
        'Define the object on every page that refers to it: put it in the same @graph with its @id, @type and properties (an article\'s author or publisher, for example), or write the properties inline instead of {"@id": ...}.',
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) => {
      const resolve = (id: string) => resolveUrl(id, page.url) ?? id;
      const defined = new Set<string>();
      const referenced = new Map<string, string>();

      const host = hostOf(page.url);

      // mainEntityOfPage: {"@id": <this page>} names the page being audited, which is valid.
      const self = new Set(
        [page.url, page.canonical].flatMap((u) => (u ? [resolve(u)] : []))
      );

      const walked = eachObject(page.structuredData, (node, path) => {
        const id = node["@id"];

        if (!isString(id)) {
          return;
        }

        const resolved = resolve(id);

        // An @id on another host names an outside entity (a Wikidata item), not one this page defines.
        if (isReference(node)) {
          if (
            hostOf(resolved) === host &&
            !self.has(resolved) &&
            !referenced.has(resolved)
          ) {
            referenced.set(resolved, path || "(root)");
          }
        } else {
          defined.add(resolved);
        }
      });

      // A definition past the walk's limits may exist; say nothing rather than guess.
      if (!walked.complete) {
        return null;
      }

      const dangling = [...referenced].filter(([id]) => !defined.has(id));

      return dangling.length > 0
        ? make(
            `${dangling.length} @id reference(s) point to objects the page does not define: ${cap(
              dangling.map(([id]) => id),
              3
            ).join(", ")}.`,
            {
              selector: 'script[type="application/ld+json"]',
              evidence: {
                references: cap(dangling.map(([id, path]) => ({ id, path }))),
              },
            }
          )
        : null;
    }
  ),
];
