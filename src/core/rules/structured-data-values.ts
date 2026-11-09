import { isHomePage } from "../aeo/page.js";
import {
  isJsonObject,
  isNumber,
  isString,
  typesOf,
} from "../html/structured-data.js";
import type { JsonObject, JsonValue } from "../html/structured-data.js";
import type {
  ExtractedPage,
  FixEdit,
  PageSource,
  StructuredDataItem,
} from "../types.js";
import { hostOf, resolveUrl } from "../url.js";
import { addHtml, replaceHtml, slot } from "./fix.js";
import {
  isSlot,
  json,
  jsonLdAt,
  jsonProperty,
  ORIGIN_SLOT_WRITE,
  productionOrigin,
} from "./page-fixes.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";
import {
  currencyCode,
  plainPrice,
  STRUCTURED_SLOTS_WRITE,
} from "./structured-data-fixes.js";

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
  visit: (node: JsonObject, path: string, item: StructuredDataItem) => void
): ObjectWalk => {
  const seen = new Set<JsonObject>();
  let visited = 0;
  let complete = true;

  const walk = (
    item: StructuredDataItem,
    value: JsonValue | undefined,
    path: string,
    depth: number
  ) => {
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
        walk(item, v, `${path}[${i}]`, depth);
      }

      return;
    }

    if (!isJsonObject(value) || seen.has(value)) {
      return;
    }

    seen.add(value);
    visited += 1;
    visit(value, path, item);

    for (const [key, v] of Object.entries(value)) {
      if (key !== "@context") {
        walk(item, v, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  for (const item of items) {
    if (item.source === "json-ld") {
      // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
      walk(item, item.data as JsonObject, "", 0);
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

/** One property to set so a value Google cannot use becomes one it can. */
interface ValueFix {
  property: string;
  /** JSON to write, which may hold a `{{…}}` slot. */
  value: string;
  /** The value the property has now, when it has one. */
  current?: JsonValue;
  /**
   * The text the edit replaces, when the rule worked it out itself; null when no quote is unique,
   * so the edit names the object and says it replaces the property instead.
   */
  quote?: string | null;
  /** Where the property sits below the object the problem is about (a breadcrumb's list item). */
  subPath?: string;
  type?: string;
  /** The value is an item to add to this array property, not the property itself. */
  into?: string;
  /** What the edit needs beyond its code. */
  write?: string;
}

/** A value Google cannot use, as the finding states it, and the properties that fix it. */
interface ValueProblem {
  text: string;
  fixes: ValueFix[];
}

const priceProblems = (node: JsonObject): ValueProblem[] => {
  const problems: ValueProblem[] = [];

  for (const key of ["price", "lowPrice", "highPrice"]) {
    const value = node[key];

    if (value === undefined || value === null || numeric(value) !== null) {
      continue;
    }

    const plain = isString(value) ? plainPrice(value) : null;

    problems.push({
      text:
        isString(value) && /^\s*\d+,\d{1,2}\s*$/u.test(value)
          ? `${key} ${show(value)} uses a comma for decimals; write it with a dot`
          : `${key} ${show(value)} is not a plain number (no currency symbol, no thousands separator)`,
      fixes: [
        {
          property: key,
          current: value,
          value:
            plain === null ? `"${slot("price, e.g. 19.99")}"` : json(plain),
        },
      ],
    });
  }

  const currency = node["priceCurrency"];

  if (
    currency !== undefined &&
    !(isString(currency) && /^[a-z]{3}$/iu.test(currency.trim()))
  ) {
    const code = isString(currency) ? currencyCode(currency) : null;

    problems.push({
      text: `priceCurrency ${show(currency)} is not a three-letter ISO 4217 code such as EUR or USD`,
      fixes: [
        {
          property: "priceCurrency",
          current: currency,
          value: code
            ? json(code)
            : `"${slot("ISO 4217 code, e.g. EUR or USD")}"`,
        },
      ],
    });
  }

  return problems;
};

/** The scale a rating out of range most likely uses, when no bestRating names it. */
const scaleFor = (rating: number): number | null => {
  if (rating <= 10) {
    return 10;
  }

  return rating <= 100 ? 100 : null;
};

/** The fix for a rating outside its scale: name the scale it is on, or correct the rating. */
const scaleFix = (
  node: JsonObject,
  rating: number,
  best: number,
  worst: number
): ValueFix => {
  if (rating < worst && node["worstRating"] === undefined && rating >= 0) {
    return { property: "worstRating", value: String(Math.floor(rating)) };
  }

  const scale =
    rating > best && node["bestRating"] === undefined ? scaleFor(rating) : null;

  return scale === null
    ? {
        property: "ratingValue",
        current: node["ratingValue"],
        value: slot(`rating between ${worst} and ${best}`),
        write:
          "The rating as the page shows it; if the scale is not what bestRating and worstRating say, correct those instead.",
      }
    : {
        property: "bestRating",
        value: String(scale),
        write: `Only if ratings on this site are out of ${scale}; otherwise set bestRating to the top of the scale they use.`,
      };
};

const ratingProblems = (node: JsonObject, types: string[]): ValueProblem[] => {
  if (!types.some((t) => t.endsWith("Rating"))) {
    return [];
  }

  const problems: ValueProblem[] = [];
  const value = node["ratingValue"];
  const rating = numeric(value);

  if (isString(value) && /^\s*\d+,\d+\s*$/u.test(value)) {
    problems.push({
      text: `ratingValue ${show(value)} uses a comma for decimals; write it with a dot`,
      fixes: [
        {
          property: "ratingValue",
          current: value,
          value: json(value.trim().replace(",", ".")),
        },
      ],
    });
  } else if (rating !== null) {
    // Google assumes 5 and 1 when bestRating and worstRating are left out.
    const best = numeric(node["bestRating"]) ?? 5;
    const worst = numeric(node["worstRating"]) ?? 1;

    if (rating > best || rating < worst) {
      problems.push({
        text: `ratingValue ${rating} is outside ${worst}-${best}${node["bestRating"] === undefined ? " (bestRating defaults to 5; set it when the scale is 10 or 100)" : ""}`,
        fixes: [scaleFix(node, rating, best, worst)],
      });
    }
  }

  for (const key of ["ratingCount", "reviewCount"]) {
    const count = node[key];

    if (count !== undefined && !/^\d+$/u.test(String(count).trim())) {
      const digits = String(count).trim();

      problems.push({
        text: `${key} ${show(count)} is not a whole number`,
        fixes: [
          {
            property: key,
            current: count,
            value: /^\d{1,3}(?:[,.\s]\d{3})+$/u.test(digits)
              ? digits.replaceAll(/[,.\s]/gu, "")
              : slot("whole number"),
          },
        ],
      });
    }
  }

  return problems;
};

/** A breadcrumb trail's crumbs, each with its index in itemListElement as written. */
const crumbsOf = (node: JsonObject): { e: JsonObject; at: string }[] => {
  const raw = node["itemListElement"];

  if (Array.isArray(raw)) {
    return raw.flatMap((e, i) =>
      isJsonObject(e) ? [{ e, at: `.itemListElement[${i}]` }] : []
    );
  }

  return isJsonObject(raw) ? [{ e: raw, at: ".itemListElement" }] : [];
};

/** A crumb whose position is rewritten: from the value it has to its place in the trail. */
interface Renumber {
  from: JsonValue;
  to: number;
  fix: ValueFix;
}

/** How many times `part` is in `text`. */
const occurrences = (text: string, part: string): number =>
  text.split(part).length - 1;

/**
 * The renumbering fixes, each quoting its crumb's position, in an order that keeps every quote
 * unique while the edits are applied one after another. In trail order, 0, 1, 2 → 1, 2, 3 would
 * write a second `"position": 1` before the next edit quotes it, so an edit waits until no other
 * still quotes what it writes: here, last crumb first. Null when a position is not in the script
 * exactly once as text (`"position": 1` is also the start of `"position": 10`), or the positions
 * go round (2, 1, 5) and no order works.
 */
const quotedInOrder = (
  scriptText: string | undefined,
  renumbers: Renumber[]
): ValueFix[] | null => {
  const pending: (Renumber & { quote: string; code: string })[] = [];

  for (const r of renumbers) {
    const quote = jsonProperty(scriptText, "position", r.from);

    // An agent finds `current` as text, so the script must hold it once as text.
    if (!scriptText || !quote || occurrences(scriptText, quote) !== 1) {
      return null;
    }

    pending.push({ ...r, quote, code: `"position": ${r.fix.value}` });
  }

  const ordered: ValueFix[] = [];

  while (pending.length > 0) {
    // Writing `code` adds a match for every quote it starts with; the quotes do not overlap.
    const next = pending.findIndex(
      (r) => !pending.some((o) => o !== r && r.code.startsWith(o.quote))
    );

    if (next === -1) {
      return null;
    }

    const [r] = pending.splice(next, 1);

    if (r) {
      ordered.push({ ...r.fix, quote: r.quote });
    }
  }

  return ordered;
};

const breadcrumbProblems = (
  node: JsonObject,
  types: string[],
  isHome: boolean,
  origin: string,
  scriptText: string | undefined
): ValueProblem[] => {
  if (!types.includes("BreadcrumbList")) {
    return [];
  }

  const crumbs = crumbsOf(node);

  if (crumbs.length === 0) {
    return [];
  }

  const problems: ValueProblem[] = [];

  // A home page's one-crumb trail (SEO plugins add one) is harmless: no trail is shown for it.
  if (crumbs.length < 2 && !isHome) {
    problems.push({
      text: "Google needs at least two ListItems in a breadcrumb trail",
      fixes: [
        {
          property: "itemListElement",
          into: "itemListElement",
          value: `{ "@type": "ListItem", "position": 1, "name": "${slot("name of the home page, e.g. Home")}", "item": ${isSlot(origin) ? `"${origin}/"` : json(`${origin}/`)} }`,
          write: `Add this crumb first in the itemListElement array and number the page's own crumb 2 (and any crumbs between them in order). ${STRUCTURED_SLOTS_WRITE}`,
        },
      ],
    });
  }

  const positions = crumbs.map(({ e }) => numeric(e["position"]));
  const known = positions.filter((p) => p !== null).toSorted((a, b) => a - b);

  if (known.length === crumbs.length && known.some((p, i) => p !== i + 1)) {
    // Numbered in the order the trail lists them, which is the order Google reads. A finding
    // keeps 10 edits, so only those are put in order.
    const renumbers = cap(
      crumbs.flatMap(({ e, at }, i): Renumber[] => {
        const from = e["position"];

        return positions[i] === i + 1 || from === undefined
          ? []
          : [
              {
                from,
                to: i + 1,
                fix: {
                  property: "position",
                  current: from,
                  value: String(i + 1),
                  subPath: at,
                  type: "ListItem",
                },
              },
            ];
      })
    );

    problems.push({
      text: `positions are ${known.join(", ")}; number them 1, 2, 3 from the start of the trail`,
      fixes:
        quotedInOrder(scriptText, renumbers) ??
        renumbers.map((r) => ({ ...r.fix, quote: null })),
    });
  }

  // The last crumb is the page itself and may leave out `item`; every other one needs it.
  const ordered = crumbs
    .map((c, i) => ({ ...c, position: positions[i] ?? i + 1 }))
    .toSorted((a, b) => a.position - b.position);

  const withoutItem = ordered
    .slice(0, -1)
    .filter(({ e }) => e["item"] === undefined || e["item"] === "");

  if (withoutItem.length > 0) {
    problems.push({
      text: `${withoutItem.length} ListItem(s) before the last have no item (the URL of that crumb)`,
      fixes: withoutItem.map(({ e, at }) => ({
        property: "item",
        current: e["item"] === "" ? "" : undefined,
        value: `"${slot("absolute URL of this crumb's page")}"`,
        subPath: at,
        type: "ListItem",
      })),
    });
  }

  return problems;
};

/** The edit that sets one property: in place when the script quotes it as written, else added to its object. */
const valueEdit = (
  fix: ValueFix,
  item: StructuredDataItem,
  type: string,
  path: string
): FixEdit => {
  const sub = fix.subPath ?? "";
  const full = path ? `${path}${sub}` : sub.replace(/^\./u, "");
  const where = jsonLdAt(fix.type ?? type, full);
  const at = fix.into ? `${where} > ${fix.into}` : where;
  const code = fix.into ? fix.value : `"${fix.property}": ${fix.value}`;

  const slotted = code.includes("{{")
    ? (fix.write ?? STRUCTURED_SLOTS_WRITE)
    : fix.write;

  let current: string | null = null;

  if (fix.quote !== undefined) {
    current = fix.quote;
  } else if (fix.current !== undefined) {
    current = jsonProperty(item.scriptText, fix.property, fix.current);
  }

  if (current) {
    return replaceHtml(current, code, { at, write: slotted });
  }

  return addHtml(
    at,
    code,
    fix.current === undefined
      ? slotted
      : `${slotted ? `${slotted} ` : ""}This replaces the "${fix.property}" the object has.`
  );
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

/** The edit that writes a relative JSON-LD URL out in full, from the production origin. */
const absoluteUrlEdit = (
  value: string,
  key: string,
  path: string,
  node: JsonObject,
  item: StructuredDataItem,
  page: ExtractedPage,
  source: PageSource
): FixEdit => {
  const origin = productionOrigin(page, source);
  const resolved = resolveUrl(value.trim(), page.url);
  const parsed = resolved ? new URL(resolved) : null;
  const tail = parsed ? parsed.pathname + parsed.search + parsed.hash : value;

  const absolute = isSlot(origin) ? `${origin}${tail}` : (resolved ?? value);
  const code = isSlot(absolute) ? `"${absolute}"` : json(absolute);
  const at = jsonLdAt(typesOf(node["@type"])[0] ?? "object", path);
  const write = isSlot(absolute) ? ORIGIN_SLOT_WRITE : undefined;
  const quoted = json(value);

  return item.scriptText?.includes(quoted)
    ? replaceHtml(quoted, code, { at: `${at} > ${key}`, write })
    : addHtml(
        at,
        `"${key}": ${code}`,
        `${write ? `${write} ` : ""}This replaces the relative "${key}" the object has.`
      );
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

      // Nothing on the page needs to change: answer engines and other tools still read this
      // markup (FAQPage feeds AI answers), so the finding informs and has no edit.
      return [...found].map(([type, count]) =>
        make(`${type} markup: ${RETIRED_RICH_RESULTS.get(type)}`, {
          fix: [],
          key: type,
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
    ({ page, source }, make) => {
      const findings: ReturnType<typeof make>[] = [];
      const origin = productionOrigin(page, source);

      eachObject(page.structuredData, (node, path, item) => {
        const types = typesOf(node["@type"]);

        const problems = [
          ...priceProblems(node),
          ...ratingProblems(node, types),
          ...breadcrumbProblems(
            node,
            types,
            isHomePage(page.url),
            origin,
            item.scriptText
          ),
        ];

        if (problems.length > 0) {
          const type = types[0] ?? "object";

          findings.push(
            make(`${type}: ${problems.map((p) => p.text).join("; ")}.`, {
              fix: problems.flatMap((p) =>
                p.fixes.map((f) => valueEdit(f, item, type, path))
              ),
              // What is wrong, not where the object is: an id that holds while other markup is
              // added or removed. Two objects with the same problems share it and are numbered.
              key: `${type} ${path} ${problems.map((p) => p.text).join("; ")}`,
              selector: 'script[type="application/ld+json"]',
              evidence: {
                type,
                path: path || "(root)",
                problems: problems.map((p) => p.text),
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
    ({ page, source }, make) => {
      const relative: string[] = [];
      const fix: FixEdit[] = [];

      eachObject(page.structuredData, (node, path, item) => {
        for (const key of URL_PROPERTIES) {
          const value = node[key];
          const values = Array.isArray(value) ? value : [value];

          for (const v of values) {
            if (isString(v) && isRelativeUrl(v)) {
              relative.push(
                `${path ? `${path}.` : ""}${key}: ${v.slice(0, 120)}`
              );
              fix.push(absoluteUrlEdit(v, key, path, node, item, page, source));
            }
          }
        }
      });

      return relative.length > 0
        ? make(`${relative.length} URL(s) in JSON-LD are relative.`, {
            fix,
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
              fix: dangling.map(([id]) =>
                addHtml(
                  'script[type="application/ld+json"] > @graph',
                  `{ "@id": ${json(id)}, "@type": "${slot("type, e.g. Organization or Person")}", "name": "${slot("name")}" }`,
                  `The object this @id names, defined in the page's @graph (wrap the script's objects in "@graph": [ ... ] if it has none) with its type and the properties Google reads for it: an Organization's name, url and logo, a Person's name and url. ${STRUCTURED_SLOTS_WRITE}`
                )
              ),
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
