import { isHomePage } from "../aeo/page.js";
import { isJsonObject, isString, typesOf } from "../html/structured-data.js";
import type { JsonObject, JsonValue } from "../html/structured-data.js";
import type {
  ExtractedPage,
  FixEdit,
  PageSource,
  StructuredDataItem,
} from "../types.js";
import { addHtml, replaceHtml, slot } from "./fix.js";
import {
  json,
  jsonLdAt,
  jsonProperty,
  productionOrigin,
} from "./page-fixes.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";
import {
  addPropertiesEdit,
  invalidJsonEdits,
  isoDate,
  STRUCTURED_SLOTS_WRITE,
} from "./structured-data-fixes.js";
import { RETIRED_RICH_RESULTS } from "./structured-data-values.js";

interface SchemaSpec {
  required: string[];
  recommended: string[];
  /** At least one of these groups must be present (each group = list of alternatives). */
  oneOf?: string[][];
  docs?: string;
}

const G =
  "https://developers.google.com/search/docs/appearance/structured-data/";

const ARTICLE: SchemaSpec = {
  required: [],
  recommended: ["headline", "image", "datePublished", "dateModified", "author"],
  docs: `${G}article`,
};

// oxlint-disable-next-line anti-slop/no-known-value-widening -- the table is read with whatever @type a page names, so it needs an index type that lets a lookup miss
export const SCHEMA_SPECS: Record<string, SchemaSpec> = {
  Article: ARTICLE,
  NewsArticle: ARTICLE,
  BlogPosting: ARTICLE,
  TechArticle: ARTICLE,
  Product: {
    required: ["name"],
    recommended: ["image", "description", "brand", "sku", "offers"],
    oneOf: [["offers", "review", "aggregateRating"]],
    docs: `${G}product`,
  },
  Offer: {
    required: ["price", "priceCurrency"],
    recommended: ["availability", "url", "priceValidUntil"],
    docs: `${G}product`,
  },
  AggregateOffer: {
    required: ["lowPrice", "priceCurrency"],
    recommended: ["highPrice", "offerCount"],
    docs: `${G}product`,
  },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo", "sameAs"],
    docs: `${G}organization`,
  },
  WebSite: {
    required: ["name", "url"],
    recommended: [],
    docs: "https://developers.google.com/search/docs/appearance/site-names",
  },
  WebPage: { required: [], recommended: ["name"] },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: [],
    docs: `${G}breadcrumb`,
  },
  ListItem: {
    required: ["position"],
    recommended: ["name", "item"],
    docs: `${G}breadcrumb`,
  },
  ItemList: {
    required: ["itemListElement"],
    recommended: [],
    docs: `${G}carousel`,
  },
  FAQPage: { required: ["mainEntity"], recommended: [], docs: `${G}faqpage` },
  // A Q&A page's question may have only suggested answers.
  Question: {
    required: ["name"],
    recommended: [],
    oneOf: [["acceptedAnswer", "suggestedAnswer"]],
    docs: `${G}qapage`,
  },
  Answer: { required: ["text"], recommended: [], docs: `${G}qapage` },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: [
      "telephone",
      "url",
      "image",
      "openingHoursSpecification",
      "priceRange",
      "geo",
    ],
    docs: `${G}local-business`,
  },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: [
      "endDate",
      "description",
      "image",
      "offers",
      "performer",
      "organizer",
      "eventStatus",
      "eventAttendanceMode",
    ],
    docs: `${G}event`,
  },
  Recipe: {
    required: ["name", "image"],
    recommended: [
      "author",
      "datePublished",
      "description",
      "prepTime",
      "cookTime",
      "totalTime",
      "recipeYield",
      "recipeIngredient",
      "recipeInstructions",
      "aggregateRating",
    ],
    docs: `${G}recipe`,
  },
  VideoObject: {
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["description", "duration", "contentUrl", "embedUrl"],
    docs: `${G}video`,
  },
  Person: { required: ["name"], recommended: ["url", "sameAs", "jobTitle"] },
  JobPosting: {
    required: [
      "title",
      "description",
      "datePosted",
      "hiringOrganization",
      "jobLocation",
    ],
    recommended: ["validThrough", "employmentType", "baseSalary", "identifier"],
    docs: `${G}job-posting`,
  },
  HowTo: {
    required: ["name", "step"],
    recommended: ["image", "totalTime", "estimatedCost", "supply", "tool"],
    docs: `${G}how-to`,
  },
  Review: {
    required: ["itemReviewed", "reviewRating", "author"],
    recommended: ["datePublished", "reviewBody"],
    docs: `${G}review-snippet`,
  },
  Rating: {
    required: ["ratingValue"],
    recommended: ["bestRating", "worstRating"],
    docs: `${G}review-snippet`,
  },
  AggregateRating: {
    required: ["ratingValue"],
    recommended: ["bestRating"],
    oneOf: [["ratingCount", "reviewCount"]],
    docs: `${G}review-snippet`,
  },
  SoftwareApplication: {
    required: ["name"],
    recommended: [
      "applicationCategory",
      "operatingSystem",
      "offers",
      "aggregateRating",
    ],
    oneOf: [["offers", "aggregateRating"]],
    docs: `${G}software-app`,
  },
  Course: {
    required: ["name", "description", "provider"],
    recommended: [],
    docs: `${G}course`,
  },
  Dataset: {
    required: ["name", "description"],
    recommended: ["url", "creator", "license", "distribution"],
    docs: `${G}dataset`,
  },
  ImageObject: {
    required: [],
    recommended: ["contentUrl", "license", "creator"],
    oneOf: [["contentUrl", "url"]],
    docs: `${G}image-license-metadata`,
  },
  PostalAddress: {
    required: [],
    recommended: [
      "streetAddress",
      "addressLocality",
      "postalCode",
      "addressCountry",
    ],
  },
};

const DATE_PROPS = new Set([
  "datePublished",
  "dateModified",
  "startDate",
  "endDate",
  "uploadDate",
  "datePosted",
  "validThrough",
  "dateCreated",
  "expires",
]);

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

interface Issue {
  type: string;
  missing: string[];
  path: string;
}

/** What one structured-data item lacks or gets wrong, against the specs above. */
export interface ItemValidation {
  required: Issue[];
  recommended: Issue[];
  badDates: string[];
  unknownTypes: string[];
}

const isPresent = (value: JsonValue | undefined): boolean => {
  if (value === null || value === undefined) {
    return false;
  }

  if (isString(value)) {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
};

/** The properties a typed object lacks: required ones (and oneOf groups it fills none of), then recommended ones. */
const missingProperties = (obj: JsonObject, spec: SchemaSpec) => {
  const required = spec.required.filter((p) => !isPresent(obj[p]));

  for (const group of spec.oneOf ?? []) {
    if (!group.some((p) => isPresent(obj[p]))) {
      required.push(`one of: ${group.join(" | ")}`);
    }
  }

  const recommended = spec.recommended.filter((p) => !isPresent(obj[p]));

  return { required, recommended };
};

/** Types that exist only as parts of a retired rich result (FAQ and How-to answers and steps). */
const RETIRED_PART_TYPES = new Set([
  "Question",
  "Answer",
  "HowToStep",
  "HowToSection",
  "HowToSupply",
  "HowToTool",
  "HowToDirection",
  "HowToTip",
]);

/** Walk one structured-data item (and nested typed objects) collecting spec violations. */
export const validateItem = (item: StructuredDataItem): ItemValidation => {
  const required: Issue[] = [];
  const recommended: Issue[] = [];
  const badDates: string[] = [];
  const unknownTypes: string[] = [];
  const visited = new Set<JsonObject | JsonValue[]>();

  const checkSpecs = (node: JsonObject, types: string[], path: string) => {
    for (const type of types) {
      const spec = SCHEMA_SPECS[type];

      if (!spec) {
        unknownTypes.push(type);
        continue;
      }

      const missing = missingProperties(node, spec);

      // A review nested in a Recipe or Product reviews that item; only a standalone one names it.
      if (type === "Review" && path !== "") {
        missing.required = missing.required.filter((p) => p !== "itemReviewed");
      }

      if (missing.required.length) {
        required.push({ type, missing: missing.required, path });
      }

      if (missing.recommended.length) {
        recommended.push({ type, missing: missing.recommended, path });
      }
    }
  };

  // Below a retired rich result type, missing properties no longer cost anything in Google.
  const walk = (
    node: JsonValue | undefined,
    path: string,
    depth: number,
    retired = false
  ): void => {
    if (
      depth > 6 ||
      !(Array.isArray(node) || isJsonObject(node)) ||
      visited.has(node)
    ) {
      return;
    }

    visited.add(node);

    if (Array.isArray(node)) {
      for (const [i, n] of node.entries()) {
        walk(n, `${path}[${i}]`, depth, retired);
      }

      return;
    }

    const types = typesOf(node["@type"]);

    // A node co-typed ["WebPage", "FAQPage"] still has its WebPage checked; below a retired type,
    // only the types that exist for it (Question, HowToStep, ...) go unchecked.
    checkSpecs(
      node,
      types.filter(
        (t) =>
          !RETIRED_RICH_RESULTS.has(t) &&
          !(retired && RETIRED_PART_TYPES.has(t))
      ),
      path
    );

    // Untyped objects (every() holds for no types) and the retired types' own parts pass the skip
    // down; a live type such as a BreadcrumbList or VideoObject below FAQPage or HowTo is checked.
    const underRetired =
      types.some((t) => RETIRED_RICH_RESULTS.has(t)) ||
      (retired && types.every((t) => RETIRED_PART_TYPES.has(t)));

    for (const [key, value] of Object.entries(node)) {
      if (
        DATE_PROPS.has(key) &&
        isString(value) &&
        !ISO_DATE.test(value.trim())
      ) {
        badDates.push(`${path ? `${path}.` : ""}${key}="${value}"`);
      }

      if (Array.isArray(value) || isJsonObject(value)) {
        walk(value, path ? `${path}.${key}` : key, depth + 1, underRetired);
      }
    }
  };

  // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
  walk(item.data as JsonObject, "", 0);

  return { required, recommended, badDates, unknownTypes };
};

/** A date property whose value is not ISO 8601, with the object it sits in. */
interface BadDate {
  item: StructuredDataItem;
  type: string;
  path: string;
  key: string;
  value: string;
}

/** Every date property of the page's structured data that is not ISO 8601. */
const badDatesOf = (items: StructuredDataItem[]): BadDate[] => {
  const out: BadDate[] = [];
  const seen = new Set<JsonObject | JsonValue[]>();

  const walk = (
    item: StructuredDataItem,
    node: JsonValue | undefined,
    path: string,
    depth: number
  ): void => {
    if (
      depth > 6 ||
      !(Array.isArray(node) || isJsonObject(node)) ||
      seen.has(node)
    ) {
      return;
    }

    seen.add(node);

    if (Array.isArray(node)) {
      for (const [i, n] of node.entries()) {
        walk(item, n, `${path}[${i}]`, depth);
      }

      return;
    }

    const type = typesOf(node["@type"])[0] ?? "object";

    for (const [key, value] of Object.entries(node)) {
      if (
        DATE_PROPS.has(key) &&
        isString(value) &&
        !ISO_DATE.test(value.trim())
      ) {
        out.push({ item, type, path, key, value });
      }

      walk(item, value, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  for (const item of items) {
    // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
    walk(item, item.data as JsonObject, "", 0);
  }

  return out;
};

/** The edit that writes one date as ISO 8601, in place when the source quotes it as written. */
const dateEdit = (bad: BadDate): FixEdit => {
  const iso = isoDate(bad.value);
  const value = iso ? json(iso) : `"${slot("ISO 8601 date, e.g. 2026-03-14")}"`;

  const write = iso
    ? undefined
    : `"${bad.value}" can be read more than one way (03/04 is March or April), so write the date it means.`;

  if (bad.item.source === "microdata") {
    return replaceHtml(
      bad.value,
      iso ?? slot("ISO 8601 date, e.g. 2026-03-14"),
      {
        at: `[itemprop="${bad.key}"]`,
        write:
          write ??
          "In a <time> element, write the ISO date in its datetime attribute and keep the visible text as it is.",
      }
    );
  }

  const current = jsonProperty(bad.item.scriptText, bad.key, bad.value);
  const code = `"${bad.key}": ${value}`;
  const at = jsonLdAt(bad.type, bad.path);

  return current
    ? replaceHtml(current, code, { at, write })
    : addHtml(
        at,
        code,
        write ?? `This replaces the "${bad.key}" the object has.`
      );
};

/** The JSON-LD block to add to a page without structured data: the site on its home page, else the page's subject. */
const starterBlock = (page: ExtractedPage, source: PageSource): FixEdit => {
  const origin = productionOrigin(page, source);
  const originUrl = origin.includes("{{") ? `"${origin}/"` : json(`${origin}/`);

  const props: [string, string][] = isHomePage(page.url)
    ? [
        ["@type", '"WebSite"'],
        ["name", `"${slot("site name")}"`],
        ["url", originUrl],
      ]
    : [
        [
          "@type",
          `"${slot("Article, Product, Event or another type that fits")}"`,
        ],
        [
          "name",
          // The main heading names the subject; a <title> often adds the site name.
          page.h1s[0] ? json(page.h1s[0]) : `"${slot("page subject")}"`,
        ],
        [
          "url",
          source === "html"
            ? `"${slot("page URL")}"`
            : json(page.canonical ?? page.url),
        ],
      ];

  const body = [["@context", '"https://schema.org"'], ...props]
    .map(([k, v]) => `  "${k}": ${v}`)
    .join(",\n");

  return addHtml(
    "head",
    `<script type="application/ld+json">\n{\n${body}\n}\n</script>`,
    isHomePage(page.url)
      ? `The site's name as it should show in search results, and its production origin. ${STRUCTURED_SLOTS_WRITE}`
      : `The schema.org type that fits the page, then the properties Google lists for it (Article: headline, image, datePublished, author; Product: name, image, offers). ${STRUCTURED_SLOTS_WRITE}`
  );
};

/**
 * Whether a JSON-LD @context names schema.org: `https://schema.org`, `http://schema.org/`,
 * `//schema.org` or a bare `schema.org`. The host decides, so `https://example.com/schema.org`
 * is no schema.org context (CodeQL js/incomplete-url-substring-sanitization).
 */
export const isSchemaOrgContext = (context: string | null): boolean => {
  const value = (context ?? "").trim();

  if (!value) {
    return false;
  }

  let absolute = value;

  if (value.startsWith("//")) {
    absolute = `https:${value}`;
  } else if (!value.includes("://")) {
    absolute = `https://${value}`;
  }

  try {
    const host = new URL(absolute).hostname.toLowerCase();

    return host === "schema.org" || host === "www.schema.org";
  } catch {
    return false;
  }
};

/** The edit that gives a JSON-LD object a schema.org @context. */
const contextEdit = (item: StructuredDataItem): FixEdit => {
  const at = jsonLdAt(item.types[0] ?? "object");
  const code = '"@context": "https://schema.org"';

  const current =
    item.context === null
      ? null
      : jsonProperty(item.scriptText, "@context", item.context);

  if (current) {
    return replaceHtml(current, code, { at });
  }

  return addHtml(
    at,
    code,
    item.context === null
      ? "Add it to the script's top-level object (the one with @graph, if the script has one)."
      : `This replaces the @context "${item.context}" the object has.`
  );
};

/** The edit that gives a structured data item its @type. */
const typeEdit = (item: StructuredDataItem): FixEdit => {
  const keys = Object.keys(item.data)
    .filter((k) => !k.startsWith("@"))
    .slice(0, 6);

  const write = `The schema.org type this object describes, judging by its properties (${keys.join(", ") || "none"}): Article, Product, Organization, Person, Event, ...`;

  return item.source === "microdata"
    ? addHtml(
        "[itemscope]:not([itemtype])",
        `itemtype="https://schema.org/${slot("type")}"`,
        write
      )
    : addHtml(
        jsonLdAt("object"),
        `"@type": "${slot("schema.org type")}"`,
        write
      );
};

/**
 * What tells a missing-property finding apart from others on the page: the type, the path and the
 * item's own @id or url. Not the item's place, which moves when an earlier script is fixed, and
 * not the missing properties, which shrink when some of them are added. Items alike in all of
 * these share it and are numbered.
 */
const issueKey = (
  item: StructuredDataItem,
  iss: { type: string; path: string }
): string => {
  // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
  const data = item.data as JsonObject;
  const name = data["@id"] ?? data["url"];

  return `${iss.type} ${iss.path} ${isString(name) ? name : ""}`;
};

/**
 * What tells one broken JSON-LD script from another while it is being fixed: the first @type its
 * text names, which a partial fix leaves alone. Not its place, which moves when an earlier block
 * is removed, nor its text, which every edit changes. An empty block has none; scripts alike share
 * it and are numbered.
 */
const brokenScriptKey = (text: string): string | undefined => {
  if (!text.trim()) {
    return undefined;
  }

  // At most 100 characters are tried after each "@type", so the pattern stays linear.
  const type = /"@type"\s*:\s*"(?<type>[^"\\]{1,100})"/u.exec(text)?.groups?.[
    "type"
  ];

  return type ?? "no @type";
};

export const structuredDataRules = [
  defineRule(
    {
      id: "structured-data.invalid-json",
      category: "structured-data",
      severity: "error",
      description:
        "A JSON-LD <script> block contains invalid JSON and will be ignored entirely.",
      recommendation:
        "Fix the JSON syntax (trailing commas, unescaped quotes, HTML comments inside the script). Serialise with JSON.stringify instead of hand-writing it.",
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) =>
      page.structuredDataErrors.map((e) =>
        make(`Invalid JSON-LD: ${e.message}`, {
          fix: invalidJsonEdits(
            e.text,
            page.markup.jsonLd[e.script],
            e.message
          ),
          key: brokenScriptKey(e.text),
          selector: 'script[type="application/ld+json"]',
          evidence: { snippet: e.snippet },
        })
      )
  ),
  defineRule(
    {
      id: "structured-data.missing",
      category: "structured-data",
      severity: "info",
      description: "The page has no structured data (JSON-LD or microdata).",
      recommendation:
        "Add JSON-LD for the page type (Article, Product, Organization, BreadcrumbList, Event, Recipe, ...) to qualify for rich results.",
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page, source }, make) =>
      page.structuredData.length === 0 && page.structuredDataErrors.length === 0
        ? make("Page has no structured data.", {
            fix: [starterBlock(page, source)],
          })
        : null
  ),
  defineRule(
    {
      id: "structured-data.missing-context",
      category: "structured-data",
      severity: "warning",
      description:
        "A JSON-LD item has no @context or a context other than schema.org.",
      recommendation:
        'Set "@context": "https://schema.org" on every top-level JSON-LD object.',
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) => {
      const bad = page.structuredData.filter(
        (i) => i.source === "json-ld" && !isSchemaOrgContext(i.context)
      );

      return bad.length
        ? make(`${bad.length} JSON-LD item(s) lack a schema.org @context.`, {
            fix: bad.map(contextEdit),
            selector: 'script[type="application/ld+json"]',
            evidence: {
              contexts: cap(bad.map((i) => i.context)),
              types: cap(bad.flatMap((i) => i.types)),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "structured-data.missing-type",
      category: "structured-data",
      severity: "warning",
      description: "A structured data item has no @type (or itemtype).",
      recommendation:
        'Add "@type" (e.g. "Article") to every structured data object.',
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) => {
      const bad = page.structuredData.filter((i) => i.types.length === 0);

      return bad.length
        ? make(`${bad.length} structured data item(s) have no @type.`, {
            fix: bad.map(typeEdit),
            evidence: {
              sources: cap(bad.map((i) => i.source)),
              keys: cap(bad.map((i) => Object.keys(i.data).slice(0, 8))),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "structured-data.missing-required",
      category: "structured-data",
      severity: "warning",
      description:
        "A structured data item of a known type is missing properties Google requires for rich results.",
      recommendation:
        "Add the missing properties listed in evidence. Validate with https://search.google.com/test/rich-results after fixing.",
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page, source }, make) =>
      page.structuredData.flatMap((item) => {
        const { required } = validateItem(item);

        return required.map((iss) =>
          make(`${iss.type} is missing required: ${iss.missing.join(", ")}.`, {
            fix: [
              addPropertiesEdit(item, iss.missing, {
                page,
                source,
                type: iss.type,
                path: iss.path,
              }),
            ],
            key: issueKey(item, iss),
            selector:
              item.source === "json-ld"
                ? 'script[type="application/ld+json"]'
                : `[itemtype*="${iss.type}"]`,
            evidence: {
              type: iss.type,
              missing: iss.missing,
              path: iss.path || "(root)",
              source: item.source,
              docs: SCHEMA_SPECS[iss.type]?.docs,
            },
          })
        );
      })
  ),
  defineRule(
    {
      id: "structured-data.missing-recommended",
      category: "structured-data",
      severity: "info",
      description:
        "A structured data item is missing properties Google recommends for richer results.",
      recommendation:
        "Add the recommended properties where the data exists; they unlock additional rich-result features.",
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page, source }, make) =>
      page.structuredData.flatMap((item) => {
        const { recommended } = validateItem(item);

        return recommended.map((iss) =>
          make(
            `${iss.type} is missing recommended: ${iss.missing.join(", ")}.`,
            {
              fix: [
                addPropertiesEdit(item, iss.missing, {
                  page,
                  source,
                  type: iss.type,
                  path: iss.path,
                }),
              ],
              key: issueKey(item, iss),
              evidence: {
                type: iss.type,
                missing: iss.missing,
                path: iss.path || "(root)",
                source: item.source,
              },
            }
          )
        );
      })
  ),
  defineRule(
    {
      id: "structured-data.invalid-date",
      category: "structured-data",
      severity: "warning",
      description: "Date properties in structured data that are not ISO 8601.",
      recommendation:
        "Use ISO 8601 dates such as 2026-03-14 or 2026-03-14T09:30:00+01:00.",
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) => {
      const bad = page.structuredData.flatMap((i) => validateItem(i).badDates);

      return bad.length
        ? make(`${bad.length} structured data date(s) are not ISO 8601.`, {
            fix: badDatesOf(page.structuredData).map(dateEdit),
            evidence: { examples: cap(bad) },
          })
        : null;
    }
  ),
];
