/**
 * Structured data that is valid but earns nothing, or less than it could, by Google's own rules:
 * a paywall Google cannot locate, an organization's reviews of itself, a home page without the
 * site's name.
 */
import {
  isArticleType,
  isEntity,
  isHomePage,
  typedNodes,
} from "../aeo/page.js";
import {
  cssSelectorValues,
  isClassSelector,
  isJsonObject,
  isString,
  typesOf,
} from "../html/structured-data.js";
import type { JsonObject, JsonValue } from "../html/structured-data.js";
import type {
  ExtractedPage,
  FixEdit,
  StructuredDataItem,
  Finding,
} from "../types.js";
import { hostOf, resolveUrl, stripWww } from "../url.js";
import { addHtml, removeEdit, slot } from "./fix.js";
import { json, jsonLdAt, productionOrigin } from "./page-fixes.js";
import { defineRule } from "./rule.js";
import { STRUCTURED_SLOTS_WRITE } from "./structured-data-fixes.js";
import { eachObject, valueEdit } from "./structured-data-values.js";
import type { ValueFix } from "./structured-data-values.js";

const SD =
  "https://developers.google.com/search/docs/appearance/structured-data/";

const JSON_LD = 'script[type="application/ld+json"]';

/* ---------------------------------------------------------------------------
 * Paywalled content
 * ------------------------------------------------------------------------- */

/** `false`, `"false"` or `"False"`, the forms Google's examples and tables write it in. */
const isFalse = (value: JsonValue | undefined): boolean =>
  value === false ||
  (isString(value) &&
    /^(?:https?:\/\/schema\.org\/)?false$/iu.test(value.trim()));

/**
 * Types Google reads paywall markup on (CreativeWork, Article, NewsArticle, Blog, Comment, HowTo,
 * Message, Review, WebPage) and their subtypes. Not Event or Place, where isAccessibleForFree means
 * a paid ticket or entrance, nor Course, where it means a paid course.
 */
const isPaywallType = (type: string): boolean =>
  isArticleType(type) ||
  type.endsWith("Page") ||
  [
    "CreativeWork",
    "Blog",
    "Comment",
    "HowTo",
    "Message",
    "Review",
    "SocialMediaPosting",
    "DiscussionForumPosting",
  ].includes(type);

/** A paywalled section itself: a WebPageElement (or WPHeader, WPFooter, ...) or an object with a cssSelector. */
const isSection = (node: JsonObject, types: string[]): boolean =>
  node["cssSelector"] !== undefined ||
  types.some((t) => t === "WebPageElement" || t.startsWith("WP"));

/** The objects a property holds, with the path to each. */
const objectsIn = (
  value: JsonValue | undefined,
  path: string
): { node: JsonObject; path: string }[] => {
  if (isJsonObject(value)) {
    return [{ node: value, path }];
  }

  return Array.isArray(value)
    ? value.flatMap((v, i) =>
        isJsonObject(v) ? [{ node: v, path: `${path}[${i}]` }] : []
      )
    : [];
};

/** An object that only points at another one by `@id`, which may be defined elsewhere. */
const isReference = (node: JsonObject): boolean =>
  Object.keys(node).every((k) => k === "@id");

/** The one class a selector such as `div.paywall` names, as `.paywall`; null for none or several. */
const onlyClass = (selector: string): string | null => {
  // One character class repeated after a fixed start: linear on any selector.
  const classes = [...selector.matchAll(/\.-?[_a-z -￿][-\w -￿]*/giu)];

  return classes.length === 1 ? (classes[0]?.[0] ?? null) : null;
};

const SECTION_SLOT = slot("class of the paywalled section, e.g. paywall");

const SECTION_WRITE =
  'The class the HTML gives the element that holds the paywalled text, after the dot. If that element has no class of its own, give it one (class="paywall") and name it here. Google reads only a .class selector.';

/** A paywall problem as the finding states it, with its edits and whether it is only a missing class. */
interface PaywallProblem {
  text: string;
  edits: FixEdit[];
  /** The class is not in the server's HTML, which a script may still add: info, not warning. */
  minor: boolean;
}

/** The edit that names the paywalled section, on an object that marks itself paywalled. */
const sectionEdit = (node: JsonObject, type: string, path: string): FixEdit => {
  const section = `{ "@type": "WebPageElement", "isAccessibleForFree": false, "cssSelector": ".${SECTION_SLOT}" }`;
  const at = jsonLdAt(type, path);

  return node["hasPart"] === undefined
    ? addHtml(at, `"hasPart": ${section}`, SECTION_WRITE)
    : addHtml(
        `${at} > hasPart`,
        section,
        `Add this object to hasPart (make hasPart an array if it holds one object). ${SECTION_WRITE}`
      );
};

const paywallProblems = (
  node: JsonObject,
  types: string[],
  path: string,
  item: StructuredDataItem,
  page: ExtractedPage
): PaywallProblem[] => {
  const type = types[0] ?? "CreativeWork";

  const parts = objectsIn(
    node["hasPart"],
    path ? `${path}.hasPart` : "hasPart"
  );

  // A part defined elsewhere in the @graph may be the paywalled section; say nothing rather than guess.
  if (parts.some((p) => isReference(p.node))) {
    return [];
  }

  const withSelector = parts.filter(
    (p) => cssSelectorValues(p.node["cssSelector"]).length > 0
  );

  const paywalled = withSelector.filter((p) =>
    isFalse(p.node["isAccessibleForFree"])
  );

  if (paywalled.length === 0) {
    return [
      {
        text: "isAccessibleForFree is false, but hasPart names no paywalled section (a WebPageElement with isAccessibleForFree false and a cssSelector)",
        edits:
          withSelector.length > 0
            ? withSelector.map((p) =>
                addHtml(
                  jsonLdAt(
                    typesOf(p.node["@type"])[0] ?? "WebPageElement",
                    p.path
                  ),
                  '"isAccessibleForFree": false',
                  'Only on the section that is behind the paywall; this replaces the "isAccessibleForFree" the object has, if it has one.'
                )
              )
            : [sectionEdit(node, type, path)],
        minor: false,
      },
    ];
  }

  return paywalled.flatMap(({ node: part, path: at }): PaywallProblem[] => {
    const selectors = cssSelectorValues(part["cssSelector"]);
    const partType = typesOf(part["@type"])[0] ?? "WebPageElement";
    const problems: PaywallProblem[] = [];
    const invalid = selectors.filter((s) => !isClassSelector(s));

    if (invalid.length > 0) {
      const rewritten = selectors.map((s) =>
        isClassSelector(s) ? json(s) : json(onlyClass(s) ?? `.${SECTION_SLOT}`)
      );

      const fix: ValueFix = {
        property: "cssSelector",
        current: part["cssSelector"],
        value: Array.isArray(part["cssSelector"])
          ? `[${rewritten.join(", ")}]`
          : (rewritten[0] ?? `".${SECTION_SLOT}"`),
        write: rewritten.some((r) => r.includes("{{"))
          ? SECTION_WRITE
          : undefined,
      };

      problems.push({
        text: `cssSelector ${invalid.map((s) => JSON.stringify(s.slice(0, 80))).join(", ")} is not a .class selector, the only kind Google reads`,
        edits: [valueEdit(fix, item, partType, at)],
        minor: false,
      });
    }

    const missing = selectors.filter((s) =>
      page.cssSelectors.some((c) => c.selector === s && !c.found)
    );

    if (missing.length > 0) {
      problems.push({
        text: `no element in the HTML has the class ${missing.join(", ")}, so Google cannot find the paywalled section`,
        edits: missing.map((s) =>
          addHtml(
            "body",
            `<div class="${s.slice(1)}">${slot("the paywalled part of the article, as it is now")}</div>`,
            "Wrap the part of the article behind the paywall in an element with this class, or add the class to the element that already holds it. Its text stays as it is; it must be in the HTML Google renders."
          )
        ),
        minor: true,
      });
    }

    return problems;
  });
};

/* ---------------------------------------------------------------------------
 * Self-serving reviews
 * ------------------------------------------------------------------------- */

/**
 * Types Google gives review stars to that are not organizations, and people: none of them is the
 * Organization or LocalBusiness the self-serving guideline is about.
 */
const NOT_ORGANIZATION = new Set([
  "Person",
  "Product",
  "Brand",
  "Book",
  "Course",
  "CreativeWorkSeason",
  "CreativeWorkSeries",
  "Episode",
  "Event",
  "Game",
  "HowTo",
  "MediaObject",
  "Movie",
  "MusicPlaylist",
  "MusicRecording",
  "Recipe",
  "SoftwareApplication",
  "WebApplication",
  "MobileApplication",
  "VideoGame",
]);

const REVIEW_PROPERTIES = ["aggregateRating", "review"];

/** The first string a property holds. */
const firstString = (value: JsonValue | undefined): string | null => {
  if (isString(value)) {
    return value.trim() || null;
  }

  return Array.isArray(value) ? (value.find(isString)?.trim() ?? null) : null;
};

/**
 * Whether an organization object describes the site the page is on: its url (or its @id, as SEO
 * plugins write `https://www.example.com/#organization`) is the site's home page, or it names no
 * URL and sits on the home page.
 */
const isOwnSite = (node: JsonObject, pageUrl: string): boolean => {
  const named = firstString(node["url"]) ?? firstString(node["@id"]);

  if (!named) {
    return isHomePage(pageUrl);
  }

  const resolved = resolveUrl(named, pageUrl);
  const host = resolved ? hostOf(resolved) : null;
  const pageHost = hostOf(pageUrl);

  return (
    resolved !== null &&
    host !== null &&
    pageHost !== null &&
    stripWww(host) === stripWww(pageHost) &&
    isHomePage(resolved)
  );
};

/** Offset just past the string whose opening quote is at `i`, or -1. */
const stringEnd = (text: string, i: number): number => {
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === "\\") {
      j += 1;
    } else if (text[j] === '"') {
      return j + 1;
    }
  }

  return -1;
};

/** Offset just past the object or array that opens at `i`, strings skipped whole, or -1. */
const containerEnd = (text: string, i: number): number => {
  let depth = 0;

  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];

    if (ch === '"') {
      const end = stringEnd(text, j);

      if (end === -1) {
        return -1;
      }

      j = end - 1;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;

      if (depth === 0) {
        return j + 1;
      }
    }
  }

  return -1;
};

/** Offset just past the JSON value that starts at `i` (an object, array, string or scalar), or -1. */
const valueEnd = (text: string, i: number): number => {
  const open = text[i];

  if (open === "{" || open === "[") {
    return containerEnd(text, i);
  }

  if (open === '"') {
    return stringEnd(text, i);
  }

  let j = i;

  while (j < text.length && !/[\s,\]}]/u.test(text[j] ?? "")) {
    j += 1;
  }

  return j > i ? j : -1;
};

const isBlank = (ch: string | undefined): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/**
 * `"key": value` as the script writes it, with the comma that joins it to the object, so that
 * removing the quote leaves valid JSON; null when the script does not hold it exactly once.
 */
const propertyWithComma = (
  scriptText: string | undefined,
  key: string,
  value: JsonValue
): string | null => {
  if (!scriptText) {
    return null;
  }

  const name = JSON.stringify(key);
  const want = JSON.stringify(value);
  const spans: [number, number][] = [];

  for (
    let at = scriptText.indexOf(name), tries = 0;
    at !== -1 && tries < 50;
    at = scriptText.indexOf(name, at + 1), tries += 1
  ) {
    let i = at + name.length;

    while (isBlank(scriptText[i])) {
      i += 1;
    }

    if (scriptText[i] !== ":") {
      continue;
    }

    i += 1;

    while (isBlank(scriptText[i])) {
      i += 1;
    }

    const end = valueEnd(scriptText, i);

    if (end === -1) {
      continue;
    }

    try {
      if (JSON.stringify(JSON.parse(scriptText.slice(i, end))) === want) {
        spans.push([at, end]);
      }
    } catch {
      // Not this occurrence.
    }
  }

  const [span] = spans;

  if (spans.length !== 1 || !span) {
    return null;
  }

  let [start, end] = span;
  let before = start - 1;

  while (isBlank(scriptText[before])) {
    before -= 1;
  }

  if (scriptText[before] === ",") {
    start = before;
  } else {
    let after = end;

    while (isBlank(scriptText[after])) {
      after += 1;
    }

    if (scriptText[after] !== ",") {
      return null;
    }

    end = after + 1;

    while (isBlank(scriptText[end])) {
      end += 1;
    }
  }

  const quote = scriptText.slice(start, end);

  return scriptText.split(quote).length === 2 ? quote : null;
};

const REVIEW_WRITE =
  "Only the markup goes; the reviews stay on the page. If a review widget (Trustpilot, Google reviews, a WordPress plugin) adds this markup, turn off its rich snippet or schema setting instead.";

/** The edit that takes one review property off an organization object. */
const removeReviewEdit = (
  key: string,
  node: JsonObject,
  item: StructuredDataItem,
  type: string,
  path: string
): FixEdit => {
  const value = node[key];
  const at = jsonLdAt(type, path);

  const quote =
    value === undefined ? null : propertyWithComma(item.scriptText, key, value);

  return quote
    ? removeEdit("html", quote, { at, write: REVIEW_WRITE })
    : removeEdit("html", JSON.stringify(key), {
        at,
        write: `Delete the "${key}" property from this object: its key, its whole value and the comma that joins it to the next property. ${REVIEW_WRITE}`,
      });
};

/* ---------------------------------------------------------------------------
 * Rules
 * ------------------------------------------------------------------------- */

export const structuredDataEligibilityRules = [
  defineRule(
    {
      id: "structured-data.paywall-invalid",
      category: "structured-data",
      severity: "warning",
      description:
        "Paywalled content markup Google cannot use: isAccessibleForFree is false but hasPart names no paywalled section, or the section's cssSelector is not a .class selector (warning); no element in the HTML has that class (info). Without it, Google cannot tell a paywall from cloaking.",
      recommendation:
        'Give the object a hasPart of type WebPageElement with "isAccessibleForFree": false and a cssSelector that is a single class (".paywall"), and give the element that holds the paywalled text that class in the HTML.',
      docs: `${SD}paywalled-content`,
    },
    ({ page }, make) => {
      const findings: Finding[] = [];

      eachObject(page.structuredData, (node, path, item) => {
        const types = typesOf(node["@type"]);

        if (
          !isFalse(node["isAccessibleForFree"]) ||
          !types.some(isPaywallType) ||
          isSection(node, types)
        ) {
          return;
        }

        const problems = paywallProblems(node, types, path, item, page);

        if (problems.length === 0) {
          return;
        }

        const type = types[0] ?? "CreativeWork";

        findings.push(
          make(`${type}: ${problems.map((p) => p.text).join("; ")}.`, {
            severity: problems.every((p) => p.minor) ? "info" : "warning",
            fix: problems.flatMap((p) => p.edits),
            key: `${type} ${path}`,
            selector: JSON_LD,
            evidence: {
              type,
              path: path || "(root)",
              problems: problems.map((p) => p.text),
            },
          })
        );
      });

      return findings;
    }
  ),
  defineRule(
    {
      id: "structured-data.self-serving-review",
      category: "structured-data",
      severity: "info",
      description:
        "An Organization or LocalBusiness on its own site carries aggregateRating or review markup about itself. Google shows no review stars for such self-serving reviews, also when a widget adds them.",
      recommendation:
        "Remove aggregateRating and review from the organization's own markup, or turn off the review widget's markup setting. Keep the reviews on the page; put ratings on the products or services they are about (Product markup), which can earn stars.",
      docs: `${SD}review-snippet`,
    },
    ({ page }, make) => {
      const findings: Finding[] = [];

      eachObject(page.structuredData, (node, path, item) => {
        const types = typesOf(node["@type"]);
        const props = REVIEW_PROPERTIES.filter((p) => node[p] !== undefined);

        if (
          props.length === 0 ||
          types.length === 0 ||
          types.some((t) => NOT_ORGANIZATION.has(t)) ||
          !isEntity({ types, node, topLevel: path === "" }) ||
          !isOwnSite(node, page.url)
        ) {
          return;
        }

        const type = types[0] ?? "Organization";
        const name = firstString(node["name"]);

        findings.push(
          make(
            `${type}${name ? ` "${name.slice(0, 80)}"` : ""} carries ${props.join(" and ")} about itself on its own site; Google shows no review stars for it.`,
            {
              fix: props.map((p) =>
                removeReviewEdit(p, node, item, type, path)
              ),
              key: `${type} ${path}`,
              selector: JSON_LD,
              evidence: {
                type,
                name,
                path: path || "(root)",
                properties: props,
              },
            }
          )
        );
      });

      return findings;
    }
  ),
  defineRule(
    {
      id: "structured-data.site-name-missing",
      category: "structured-data",
      severity: "info",
      description:
        "The home page has structured data but no WebSite item, which Google reads first for the site name it shows in search results.",
      recommendation:
        'Add WebSite JSON-LD to the home page with the site\'s name and its home page URL: {"@type": "WebSite", "name": "Example", "url": "https://www.example.com/"}. Add alternateName for a shorter or longer name.',
      docs: "https://developers.google.com/search/docs/appearance/site-names",
    },
    ({ page, source }, make) => {
      // Without structured data, structured-data.missing already adds the WebSite item; with a
      // broken script, the WebSite item may be in it.
      if (
        source === "html" ||
        !isHomePage(page.url) ||
        page.structuredData.length === 0 ||
        page.structuredDataErrors.length > 0 ||
        typedNodes(page.structuredData).some((n) => n.types.includes("WebSite"))
      ) {
        return null;
      }

      const origin = productionOrigin(page, source);
      const siteName = page.og["site_name"]?.trim();

      const code = [
        '<script type="application/ld+json">',
        "{",
        '  "@context": "https://schema.org",',
        '  "@type": "WebSite",',
        `  "name": ${siteName ? json(siteName) : `"${slot("site name")}"`},`,
        `  "url": ${origin.includes("{{") ? `"${origin}/"` : json(`${origin}/`)}`,
        "}",
        "</script>",
      ].join("\n");

      return make("The home page has no WebSite structured data.", {
        fix: [
          addHtml(
            "head",
            code,
            code.includes("{{")
              ? `The site's name as it should show in search results, and its production origin. ${STRUCTURED_SLOTS_WRITE}`
              : "The name is the page's og:site_name; change it if the site goes by another name in search results."
          ),
        ],
        selector: JSON_LD,
        evidence: { ogSiteName: siteName ?? null },
      });
    }
  ),
];
