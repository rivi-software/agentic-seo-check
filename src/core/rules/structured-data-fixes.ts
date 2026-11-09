/**
 * Fixes for structured data: the JSON-LD (or microdata) to add for a missing property, dates and
 * prices rewritten in the form Google reads, and broken JSON repaired where the repair is certain.
 */
import type {
  ExtractedPage,
  FixEdit,
  PageSource,
  StructuredDataItem,
} from "../types.js";
import { addHtml, replaceHtml, slot } from "./fix.js";
import { json, jsonLdAt, productionOrigin } from "./page-fixes.js";

/** What the slots in a structured data fix need, for `write`. */
export const STRUCTURED_SLOTS_WRITE =
  "Fill each {{…}} with this page's own value as it appears on the page: dates in ISO 8601 (2026-03-14 or 2026-03-14T09:30:00+01:00), prices as plain numbers with a dot (19.99), currencies as ISO 4217 codes (EUR), URLs absolute.";

/** A JSON string with a slot in it: `"{{hint}}"`. */
const s = (hint: string): string => `"${slot(hint)}"`;

/** A JSON object written with a space inside each brace, so "}}" only ever closes a slot. */
const object = (type: string, props: [string, string][]): string =>
  `{ "@type": "${type}", ${props.map(([k, v]) => `"${k}": ${v}`).join(", ")} }`;

const PERSON = object("Person", [
  ["name", s("name")],
  ["url", s("URL of their profile page")],
]);

const ORGANIZATION = object("Organization", [
  ["name", s("organization name")],
  ["url", s("its website URL")],
]);

const POSTAL_ADDRESS = object("PostalAddress", [
  ["streetAddress", s("street and number")],
  ["addressLocality", s("city")],
  ["postalCode", s("postal code")],
  ["addressCountry", s("two-letter country code, e.g. NL")],
]);

const ISO_DATE_SLOT = s("ISO 8601 date, e.g. 2026-03-14");

const DATE_TIME_SLOT = s(
  "ISO 8601 date and time, e.g. 2026-03-14T19:30:00+01:00"
);

const DURATION_SLOT = s("ISO 8601 duration, e.g. PT30M");

/** JSON for a property whose value is an object, an array, a URL, a date or a fixed term. */
const SKELETONS = new Map<string, string>([
  ["author", PERSON],
  ["creator", PERSON],
  ["performer", PERSON],
  ["organizer", ORGANIZATION],
  ["publisher", ORGANIZATION],
  ["provider", ORGANIZATION],
  ["hiringOrganization", ORGANIZATION],
  ["brand", object("Brand", [["name", s("brand name")]])],
  [
    "offers",
    object("Offer", [
      ["price", s("price, e.g. 19.99")],
      ["priceCurrency", s("currency code, e.g. EUR")],
      ["availability", '"https://schema.org/InStock"'],
    ]),
  ],
  [
    "aggregateRating",
    object("AggregateRating", [
      ["ratingValue", slot("average rating, e.g. 4.6")],
      ["reviewCount", slot("number of reviews")],
    ]),
  ],
  [
    "review",
    object("Review", [
      ["reviewRating", object("Rating", [["ratingValue", slot("rating")]])],
      ["author", PERSON],
    ]),
  ],
  ["reviewRating", object("Rating", [["ratingValue", slot("rating, e.g. 4")]])],
  ["itemReviewed", object("Thing", [["name", s("what is reviewed")]])],
  ["address", POSTAL_ADDRESS],
  [
    "location",
    object("Place", [
      ["name", s("venue name")],
      ["address", POSTAL_ADDRESS],
    ]),
  ],
  ["jobLocation", object("Place", [["address", POSTAL_ADDRESS]])],
  [
    "geo",
    object("GeoCoordinates", [
      ["latitude", slot("latitude")],
      ["longitude", slot("longitude")],
    ]),
  ],
  [
    "openingHoursSpecification",
    `[ ${object("OpeningHoursSpecification", [
      ["dayOfWeek", `[ ${s("days, e.g. Monday")} ]`],
      ["opens", s("opening time, e.g. 09:00")],
      ["closes", s("closing time, e.g. 17:00")],
    ])} ]`,
  ],
  [
    "itemListElement",
    `[ ${object("ListItem", [
      ["position", "1"],
      ["name", s("first item name")],
      ["item", s("first item URL")],
    ])}, ${object("ListItem", [
      ["position", "2"],
      ["name", s("second item name")],
      ["item", s("second item URL")],
    ])} ]`,
  ],
  [
    "mainEntity",
    `[ ${object("Question", [
      ["name", s("question as the page asks it")],
      [
        "acceptedAnswer",
        object("Answer", [["text", s("answer as the page gives it")]]),
      ],
    ])} ]`,
  ],
  [
    "acceptedAnswer",
    object("Answer", [["text", s("answer as the page gives it")]]),
  ],
  [
    "suggestedAnswer",
    object("Answer", [["text", s("answer as the page gives it")]]),
  ],
  ["step", `[ ${object("HowToStep", [["text", s("first step")]])} ]`],
  [
    "recipeInstructions",
    `[ ${object("HowToStep", [["text", s("first step")]])} ]`,
  ],
  ["recipeIngredient", `[ ${s("first ingredient with its amount")} ]`],
  [
    "baseSalary",
    object("MonetaryAmount", [
      ["currency", s("currency code, e.g. EUR")],
      [
        "value",
        object("QuantitativeValue", [
          ["value", slot("amount")],
          ["unitText", s("HOUR, MONTH or YEAR")],
        ]),
      ],
    ]),
  ],
  [
    "identifier",
    object("PropertyValue", [
      ["name", s("employer name")],
      ["value", s("job id")],
    ]),
  ],
  [
    "distribution",
    object("DataDownload", [
      ["encodingFormat", s("file type, e.g. CSV")],
      ["contentUrl", s("download URL")],
    ]),
  ],
  [
    "sameAs",
    `[ ${s("URL of the profile on another site, e.g. Wikipedia or LinkedIn")} ]`,
  ],
  ["eventStatus", '"https://schema.org/EventScheduled"'],
  ["eventAttendanceMode", '"https://schema.org/OfflineEventAttendanceMode"'],
  ["availability", '"https://schema.org/InStock"'],
  ["datePublished", ISO_DATE_SLOT],
  ["dateModified", ISO_DATE_SLOT],
  ["datePosted", ISO_DATE_SLOT],
  ["validThrough", DATE_TIME_SLOT],
  ["priceValidUntil", ISO_DATE_SLOT],
  ["startDate", DATE_TIME_SLOT],
  ["endDate", DATE_TIME_SLOT],
  ["uploadDate", DATE_TIME_SLOT],
  ["duration", DURATION_SLOT],
  ["prepTime", DURATION_SLOT],
  ["cookTime", DURATION_SLOT],
  ["totalTime", DURATION_SLOT],
  ["price", s("price, e.g. 19.99")],
  ["lowPrice", s("lowest price, e.g. 9.99")],
  ["highPrice", s("highest price, e.g. 49.99")],
  ["priceCurrency", s("currency code, e.g. EUR")],
  ["ratingValue", slot("rating, e.g. 4.6")],
  ["bestRating", slot("highest rating on the scale, e.g. 5")],
  ["worstRating", slot("lowest rating on the scale, e.g. 1")],
  ["ratingCount", slot("number of ratings")],
  ["reviewCount", slot("number of reviews")],
  ["offerCount", slot("number of offers")],
  ["employmentType", s("FULL_TIME, PART_TIME, CONTRACTOR, ...")],
  ["image", s("absolute URL of an image")],
  ["logo", s("absolute URL of the logo")],
  ["thumbnailUrl", s("absolute URL of the thumbnail")],
  ["contentUrl", s("absolute URL of the file")],
  ["embedUrl", s("absolute URL of the player")],
  ["license", s("URL of the license")],
]);

/** Types whose `name` (or `headline`) is the page's main heading when the object is the page's subject. */
const HEADLINE_TYPES = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "TechArticle",
  "Product",
  "Event",
  "Recipe",
  "Course",
  "SoftwareApplication",
  "Dataset",
  "HowTo",
  "JobPosting",
  "VideoObject",
  "LocalBusiness",
]);

interface PropertyContext {
  page: ExtractedPage;
  source: PageSource;
  type: string;
  path: string;
}

/** A value the page already states for a property of its main subject, or null. */
const statedValue = (prop: string, ctx: PropertyContext): string | null => {
  const { page, type } = ctx;
  // The main heading names the subject; a <title> often adds the site name or is a placeholder.
  const [heading] = page.h1s;
  const image = page.og["image"] ?? "";

  if (["name", "headline", "title"].includes(prop)) {
    return HEADLINE_TYPES.has(type) && heading ? json(heading) : null;
  }

  if (prop === "description") {
    return page.metaDescription ? json(page.metaDescription) : null;
  }

  if (prop === "url") {
    return json(page.canonical ?? page.url);
  }

  return prop === "image" && /^https?:\/\//iu.test(image) ? json(image) : null;
};

/** The value of a missing property: what the page already states, or a skeleton with slots. */
const valueFor = (prop: string, ctx: PropertyContext): string => {
  const { page, source, type, path } = ctx;

  if (prop === "url" && (type === "WebSite" || type === "Organization")) {
    const origin = productionOrigin(page, source);

    return origin.includes("{{") ? `"${origin}/"` : json(`${origin}/`);
  }

  const root = path === "" || path === "(root)";
  const stated = root ? statedValue(prop, ctx) : null;

  if (stated !== null) {
    return stated;
  }

  // A ListItem's position is its place in the list, which the path names.
  const index = /\[(?<i>\d+)\]$/u.exec(path)?.groups?.i;

  if (prop === "position" && index !== undefined) {
    return String(Number(index) + 1);
  }

  return SKELETONS.get(prop) ?? s(prop);
};

/** The first alternative of a "one of: a | b" requirement, the one most pages have data for. */
const propertyName = (missing: string): string =>
  missing.startsWith("one of: ")
    ? (missing.slice("one of: ".length).split(" | ")[0] ?? missing)
    : missing;

/** The edit that adds missing properties to a JSON-LD object or a microdata item. */
export const addPropertiesEdit = (
  item: StructuredDataItem,
  missing: string[],
  ctx: PropertyContext
): FixEdit => {
  const props = missing.map(propertyName);
  const alternatives = missing.filter((m) => m.startsWith("one of: "));

  const either =
    alternatives.length > 0
      ? ` For "${alternatives.join('", "')}", one of them is enough; this adds the first.`
      : "";

  if (item.source === "microdata") {
    return addHtml(
      `[itemtype*="${ctx.type}"]`,
      props
        .map((p) => `<meta itemprop="${p}" content="${slot(p)}">`)
        .join("\n"),
      `${STRUCTURED_SLOTS_WRITE} Properties that hold an object (an Offer, a Person) take an element with itemprop, itemscope and itemtype instead of a <meta>.${either}`
    );
  }

  const lines = props.map((p) => `"${p}": ${valueFor(p, ctx)}`);
  const code = lines.join(",\n");

  return addHtml(
    jsonLdAt(ctx.type, ctx.path),
    code,
    code.includes("{{")
      ? `Add these properties to the object. ${STRUCTURED_SLOTS_WRITE}${either}`
      : `Add these properties to the object.${either}`
  );
};

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const pad = (n: number): string => String(n).padStart(2, "0");

const isoOf = (year: number, month: number, day: number): string | null =>
  month >= 1 && month <= 12 && day >= 1 && day <= 31
    ? `${year}-${pad(month)}-${pad(day)}`
    : null;

const monthOf = (name: string): number =>
  MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/**
 * A date written another way, as ISO 8601: 14/03/2026, 2026/3/14, March 14, 2026, 14 March 2026.
 * Null when the form is ambiguous (03/04/2026 is March or April) or unknown.
 */
export const isoDate = (value: string): string | null => {
  const v = value.trim();

  const numeric = /^(?<a>\d{1,2})[./-](?<b>\d{1,2})[./-](?<y>\d{4})$/u.exec(
    v
  )?.groups;

  if (numeric) {
    const a = Number(numeric["a"]);
    const b = Number(numeric["b"]);
    const y = Number(numeric["y"]);

    if (a > 12) {
      return isoOf(y, b, a);
    }

    return b > 12 ? isoOf(y, a, b) : null;
  }

  const yearFirst = /^(?<y>\d{4})[./-](?<m>\d{1,2})[./-](?<d>\d{1,2})$/u.exec(
    v
  )?.groups;

  if (yearFirst) {
    return isoOf(
      Number(yearFirst["y"]),
      Number(yearFirst["m"]),
      Number(yearFirst["d"])
    );
  }

  const monthFirst =
    /^(?<m>[A-Za-z]{3,9})\.? (?<d>\d{1,2})(?:st|nd|rd|th)?,? (?<y>\d{4})$/u.exec(
      v
    )?.groups;

  const dayFirst =
    /^(?<d>\d{1,2})(?:st|nd|rd|th)?\.? (?<m>[A-Za-z]{3,9})\.?,? (?<y>\d{4})$/u.exec(
      v
    )?.groups;

  const named = monthFirst ?? dayFirst;

  if (named) {
    const month = monthOf(named["m"] ?? "");

    return month > 0
      ? isoOf(Number(named["y"]), month, Number(named["d"]))
      : null;
  }

  return null;
};

/**
 * A price as a plain number with a dot: "€19,99" → "19.99", "1.299,00 EUR" → "1299.00". Null when
 * unsure, so the fix asks for the price instead of writing a wrong one.
 */
export const plainPrice = (value: string): string | null => {
  // One number only: "€19 - €29" or "€19,99 incl. 21% VAT" would otherwise join their digits.
  const numbers = value.match(/\d[\d.,]*/gu) ?? [];
  const digits = numbers.length === 1 ? (numbers[0] ?? "") : "";

  if (!/\d/u.test(digits)) {
    return null;
  }

  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    const plain = digits.replaceAll(thousands, "").replace(decimal, ".");

    // "1.299,-" leaves "1299.", which is still not a plain number.
    return /^\d+(?:\.\d+)?$/u.test(plain) ? plain : null;
  }

  if (lastComma !== -1) {
    if (/^\d+,\d{1,2}$/u.test(digits)) {
      return digits.replace(",", ".");
    }

    return /^\d{1,3}(?:,\d{3})+$/u.test(digits)
      ? digits.replaceAll(",", "")
      : null;
  }

  // "1.299" is over a thousand in much of Europe and just over one elsewhere: a slot, not a guess.
  return /^\d+(?:\.\d+)?$/u.test(digits) &&
    !/^\d{1,3}(?:\.\d{3})+$/u.test(digits)
    ? digits
    : null;
};

/** ISO 4217 codes for currency signs and names that name one currency. */
const CURRENCIES = new Map([
  ["€", "EUR"],
  ["euro", "EUR"],
  ["euros", "EUR"],
  ["£", "GBP"],
  ["us$", "USD"],
  ["usd$", "USD"],
  ["₹", "INR"],
  ["₩", "KRW"],
  ["₺", "TRY"],
  ["zł", "PLN"],
  ["kč", "CZK"],
  ["chf", "CHF"],
]);

/** The ISO 4217 code a currency value means, or null when it could be several ($, ¥, kr). */
export const currencyCode = (value: string): string | null =>
  CURRENCIES.get(value.trim().toLowerCase()) ?? null;

/** The offsets of commas that end a JSON object or array, read outside strings. */
const trailingCommas = (text: string): number[] => {
  const commas: number[] = [];
  let inString = false;
  let pending = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      pending = -1;
    } else if (ch === ",") {
      pending = i;
    } else if (ch === "}" || ch === "]") {
      if (pending !== -1) {
        commas.push(pending);
      }

      pending = -1;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      pending = -1;
    }
  }

  return commas;
};

/** Characters quoted before a trailing comma, so the quote is unique enough to find. */
const CONTEXT_CHARS = 30;

interface CommaSpan {
  start: number;
  /** Just past the bracket the last comma comes before. */
  end: number;
  commas: number[];
}

/**
 * The text to quote around each trailing comma: from its line's start, or 30 characters before it
 * on a long line, to the bracket after it. Commas whose quotes would overlap share one, since the
 * first edit applied would change the text the second one quotes.
 */
const commaSpans = (body: string, commas: number[]): CommaSpan[] => {
  const spans: CommaSpan[] = [];

  for (const i of commas) {
    const lineStart = body.lastIndexOf("\n", i) + 1;
    const start = i - lineStart <= 80 ? lineStart : i - CONTEXT_CHARS;
    const end = body.slice(i + 1).search(/[\]}]/u) + i + 2;
    const last = spans.at(-1);

    if (last && start < last.end) {
      last.end = Math.max(last.end, end);
      last.commas.push(i);
    } else {
      spans.push({ start, end, commas: [i] });
    }
  }

  return spans;
};

/**
 * Edits for a JSON-LD script that does not parse: one per trailing comma when removing them makes
 * the JSON valid, else a rewrite of the whole block with the parser's message.
 */
export const invalidJsonEdits = (
  text: string,
  tag: string | undefined,
  message: string
): FixEdit[] => {
  const at = 'script[type="application/ld+json"]';
  const body = text.trim();

  if (!body) {
    return [
      {
        in: "html",
        action: "remove",
        at,
        current: `${tag ?? '<script type="application/ld+json">'}${text}</script>`,
      },
    ];
  }

  const commas = trailingCommas(body);
  let repaired = body;

  for (const i of commas.toReversed()) {
    repaired = repaired.slice(0, i) + repaired.slice(i + 1);
  }

  let parses = false;

  try {
    JSON.parse(repaired);
    parses = commas.length > 0;
  } catch {
    parses = false;
  }

  // A short block is quoted whole; a long one gets an edit per comma, quoted from its line.
  if (parses && body.length <= 500) {
    return [replaceHtml(body, repaired, { at })];
  }

  if (parses) {
    return commaSpans(body, commas).map(({ start, end, commas: inSpan }) => {
      let code = body.slice(start, end);

      for (const i of inSpan.toReversed()) {
        code = code.slice(0, i - start) + code.slice(i - start + 1);
      }

      return replaceHtml(body.slice(start, end), code, { at });
    });
  }

  return [
    replaceHtml(
      body.length > 500 ? `${body.slice(0, 499)}…` : body,
      slot("the same data as valid JSON"),
      {
        at,
        write: `${message}. Write the block out again as valid JSON with the same data, best generated with JSON.stringify from the data the page renders rather than written by hand.`,
      }
    ),
  ];
};
