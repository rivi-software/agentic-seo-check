import { isJsonObject, isString, typesOf } from "../html/structured-data.js";
import type { JsonObject, JsonValue } from "../html/structured-data.js";
import type { StructuredDataItem } from "../types.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

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
    docs: `${G}sitelinks-searchbox`,
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
  Question: {
    required: ["name", "acceptedAnswer"],
    recommended: [],
    docs: `${G}faqpage`,
  },
  Answer: { required: ["text"], recommended: [], docs: `${G}faqpage` },
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

/** Walk one structured-data item (and nested typed objects) collecting spec violations. */
export const validateItem = (item: StructuredDataItem): ItemValidation => {
  const required: Issue[] = [];
  const recommended: Issue[] = [];
  const badDates: string[] = [];
  const unknownTypes: string[] = [];
  const visited = new Set<JsonObject | JsonValue[]>();

  const walk = (
    node: JsonValue | undefined,
    path: string,
    depth: number
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
        walk(n, `${path}[${i}]`, depth);
      }

      return;
    }

    for (const type of typesOf(node["@type"])) {
      const spec = SCHEMA_SPECS[type];

      if (!spec) {
        unknownTypes.push(type);
        continue;
      }

      const missing = missingProperties(node, spec);

      if (missing.required.length) {
        required.push({ type, missing: missing.required, path });
      }

      if (missing.recommended.length) {
        recommended.push({ type, missing: missing.recommended, path });
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        DATE_PROPS.has(key) &&
        isString(value) &&
        !ISO_DATE.test(value.trim())
      ) {
        badDates.push(`${path ? `${path}.` : ""}${key}="${value}"`);
      }

      if (Array.isArray(value) || isJsonObject(value)) {
        walk(value, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
  walk(item.data as JsonObject, "", 0);

  return { required, recommended, badDates, unknownTypes };
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
        "Add JSON-LD for the page type (Article, Product, Organization, BreadcrumbList, FAQPage, ...) to qualify for rich results.",
      docs: GOOGLE_DOCS.structuredData,
    },
    ({ page }, make) =>
      page.structuredData.length === 0 && page.structuredDataErrors.length === 0
        ? make("Page has no structured data.")
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
        (i) =>
          i.source === "json-ld" &&
          !(i.context ?? "").toLowerCase().includes("schema.org")
      );

      return bad.length
        ? make(`${bad.length} JSON-LD item(s) lack a schema.org @context.`, {
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
    ({ page }, make) =>
      page.structuredData.flatMap((item) => {
        const { required } = validateItem(item);

        return required.map((iss) =>
          make(`${iss.type} is missing required: ${iss.missing.join(", ")}.`, {
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
    ({ page }, make) =>
      page.structuredData.flatMap((item) => {
        const { recommended } = validateItem(item);

        return recommended.map((iss) =>
          make(
            `${iss.type} is missing recommended: ${iss.missing.join(", ")}.`,
            {
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
            evidence: { examples: cap(bad) },
          })
        : null;
    }
  ),
];
