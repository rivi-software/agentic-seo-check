import { isJsonObject, isString, typesOf } from "../html/structured-data.js";
import type { JsonObject, JsonValue } from "../html/structured-data.js";
import { robotsDirectives } from "../rules/indexing.js";
import type {
  AeoPageSummary,
  ExtractedPage,
  ResponseInfo,
  StructuredDataItem,
} from "../types.js";
import { normalizePath } from "../url.js";

/* ---------------------------------------------------------------------------
 * Robots directives per search engine
 * ------------------------------------------------------------------------- */

export type Engine = "google" | "bing";

/** Meta tags each engine reads: the generic one and its own. */
const META_NAMES: Record<Engine, string[]> = {
  google: ["robots", "googlebot"],
  bing: ["robots", "bingbot"],
};

const HEADER_AGENT: Record<Engine, string> = {
  google: "googlebot",
  bing: "bingbot",
};

/** Directives that carry a value after a colon, which is not a user agent prefix. */
const VALUE_DIRECTIVES = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

export interface ScopedDirective {
  /** The user agent the directive is for, or null when it is for every crawler. */
  agent: string | null;
  directive: string;
}

/**
 * X-Robots-Tag values. "googlebot: nosnippet, noarchive" scopes every directive after the prefix
 * to googlebot, up to the next prefix.
 */
export const parseRobotsHeader = (value: string): ScopedDirective[] => {
  const out: ScopedDirective[] = [];
  let agent: string | null = null;

  for (const piece of value.toLowerCase().split(",")) {
    let directive = piece.trim();
    const match = /^(?<name>[a-z0-9_-]+)\s*:\s*(?<rest>.*)$/u.exec(directive);
    const name = match?.groups?.name;

    if (name && !VALUE_DIRECTIVES.has(name)) {
      agent = name;
      directive = match.groups?.rest?.trim() ?? "";
    }

    if (directive) {
      out.push({ agent, directive: directive.replaceAll(/\s+/gu, "") });
    }
  }

  return out;
};

/** The robots directives one engine applies to the page, from its meta tags and X-Robots-Tag. */
export const directivesFor = (
  engine: Engine,
  page: ExtractedPage,
  response?: ResponseInfo
): string[] => {
  const out: string[] = [];

  for (const meta of page.answer.robotsMeta) {
    if (META_NAMES[engine].includes(meta.name)) {
      for (const d of meta.content.split(",")) {
        const directive = d.replaceAll(/\s+/gu, "");

        if (directive) {
          out.push(directive);
        }
      }
    }
  }

  const header = response?.headers["x-robots-tag"];

  if (header) {
    for (const d of parseRobotsHeader(header)) {
      if (d.agent === null || d.agent === HEADER_AGENT[engine]) {
        out.push(d.directive);
      }
    }
  }

  return [...new Set(out)];
};

/** The `max-snippet` limit, or null when none is set (-1 means no limit). */
export const maxSnippet = (directives: string[]): number | null => {
  for (const d of directives) {
    if (d.startsWith("max-snippet:")) {
      const n = Number(d.slice("max-snippet:".length));

      if (Number.isInteger(n)) {
        return n;
      }
    }
  }

  return null;
};

export const hasNoindex = (directives: string[]): boolean =>
  directives.includes("noindex") || directives.includes("none");

export const hasNosnippet = (directives: string[]): boolean =>
  directives.includes("nosnippet") || maxSnippet(directives) === 0;

/* ---------------------------------------------------------------------------
 * Structured data
 * ------------------------------------------------------------------------- */

export interface TypedNode {
  types: string[];
  node: JsonObject;
  /** True for the item itself, false for an object nested in it (publisher, author, mainEntity). */
  topLevel: boolean;
}

/** Every typed object in the page's structured data, nested ones included. */
export const typedNodes = (items: StructuredDataItem[]): TypedNode[] => {
  const out: TypedNode[] = [];
  const seen = new Set<JsonValue>();

  const walk = (value: JsonValue | undefined, depth: number, top: boolean) => {
    if (depth > 6 || out.length >= 500 || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      for (const v of value) {
        walk(v, depth, top);
      }

      return;
    }

    if (!isJsonObject(value) || seen.has(value)) {
      return;
    }

    seen.add(value);
    const types = typesOf(value["@type"]);

    if (types.length) {
      out.push({ types, node: value, topLevel: top });
    }

    for (const [key, v] of Object.entries(value)) {
      if (!key.startsWith("@")) {
        walk(v, depth + 1, false);
      }
    }
  };

  for (const item of items) {
    // SAFETY: extractStructuredData builds every item's data from JSON.parse or from microdata, and both hold JSON values alone.
    walk(item.data as JsonObject, 0, true);
  }

  return out;
};

export const isArticleType = (type: string): boolean =>
  type.endsWith("Article") ||
  type === "BlogPosting" ||
  type === "LiveBlogPosting" ||
  type === "Report";

/** schema.org types for an organization or a person, beyond the many that end in Organization or Business. */
const ENTITY_TYPES = new Set([
  "Organization",
  "Corporation",
  "NGO",
  "Airline",
  "Consortium",
  "Project",
  "WorkersUnion",
  "LibrarySystem",
  "FundingScheme",
  "LocalBusiness",
  "Store",
  "OnlineStore",
  "Restaurant",
  "Hotel",
  "PerformingGroup",
  "Person",
]);

/**
 * Whether a typed object describes an organization or a person. LocalBusiness alone has over a
 * hundred subtypes (Dentist, Bakery, ...), so an object with a name and a logo, address or phone
 * number counts too.
 */
export const isEntity = ({ types, node }: TypedNode): boolean =>
  types.some(
    (t) => ENTITY_TYPES.has(t) || /(?:Organization|Business|Store)$/u.test(t)
  ) ||
  (isString(node["name"]) &&
    (node["logo"] !== undefined ||
      node["address"] !== undefined ||
      node["telephone"] !== undefined));

/** The text of a name-like value: a string, or the `name` of an object, or of the first in a list. */
export const nameOf = (value: JsonValue | undefined): string | null => {
  if (isString(value)) {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    for (const v of value) {
      const name = nameOf(v);

      if (name) {
        return name;
      }
    }

    return null;
  }

  if (isJsonObject(value)) {
    const { name } = value;

    return isString(name) ? name.trim() || null : null;
  }

  return null;
};

const stringOf = (value: JsonValue | undefined): string | null =>
  isString(value) && value.trim() ? value.trim() : null;

export const articles = (page: ExtractedPage): TypedNode[] =>
  typedNodes(page.structuredData).filter((n) => n.types.some(isArticleType));

/** Lower-cased letters and digits only, so punctuation and spacing differences do not count. */
export const comparable = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["rsquo", "’"],
  ["lsquo", "‘"],
  ["rdquo", "”"],
  ["ldquo", "“"],
  ["ndash", "–"],
  ["mdash", "—"],
]);

const decodeEntity = (entity: string, body: string): string => {
  if (body.startsWith("#")) {
    const code =
      body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));

    return Number.isInteger(code) && code > 0 && code <= 0x10_ff_ff
      ? String.fromCodePoint(code)
      : entity;
  }

  return NAMED_ENTITIES.get(body.toLowerCase()) ?? entity;
};

/**
 * Structured-data text may hold HTML: tags, and entities such as &amp;. `[^<>]` stops each attempt
 * at the next bracket, so a run of "<" without ">" costs one pass, not one pass per bracket.
 */
export const stripTags = (value: string): string =>
  value
    .replaceAll(/<[^<>]*>/gu, " ")
    .replaceAll(
      /&(?<body>#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z]{2,8});/gu,
      (entity, body: string) => decodeEntity(entity, body)
    );

export interface MarkedUpText {
  type: "Question" | "Answer" | "HowToStep";
  text: string;
}

const textsOf = (value: JsonValue | undefined): JsonValue[] => {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const pushStep = (out: MarkedUpText[], step: JsonValue): void => {
  if (isString(step)) {
    out.push({ type: "HowToStep", text: step });

    return;
  }

  if (!isJsonObject(step)) {
    return;
  }

  // A HowToSection holds its steps in itemListElement.
  const nested = step["itemListElement"];

  if (nested !== undefined) {
    for (const s of textsOf(nested)) {
      pushStep(out, s);
    }

    return;
  }

  const text = stringOf(step["text"]) ?? stringOf(step["name"]);

  if (text) {
    out.push({ type: "HowToStep", text });
  }
};

/** The questions, answers and steps FAQPage, QAPage and HowTo markup claims the page shows. */
export const markedUpTexts = (page: ExtractedPage): MarkedUpText[] => {
  const out: MarkedUpText[] = [];

  for (const { types, node } of typedNodes(page.structuredData)) {
    if (types.includes("FAQPage") || types.includes("QAPage")) {
      for (const q of textsOf(node["mainEntity"])) {
        if (!isJsonObject(q)) {
          continue;
        }

        const question = stringOf(q["name"]) ?? stringOf(q["text"]);

        if (question) {
          out.push({ type: "Question", text: question });
        }

        for (const a of [
          ...textsOf(q["acceptedAnswer"]),
          ...textsOf(q["suggestedAnswer"]),
        ]) {
          const answer = isJsonObject(a) ? stringOf(a["text"]) : null;

          if (answer) {
            out.push({ type: "Answer", text: answer });
          }
        }
      }
    }

    if (types.includes("HowTo")) {
      for (const step of textsOf(node["step"])) {
        pushStep(out, step);
      }
    }
  }

  return out.slice(0, 100);
};

/** Whether the URL is a site's home page (also /index.html in build output). */
export const isHomePage = (url: string): boolean => {
  try {
    return normalizePath(new URL(url).pathname) === "/";
  } catch {
    return false;
  }
};

/* ---------------------------------------------------------------------------
 * Summary
 * ------------------------------------------------------------------------- */

const googleSnippets = (
  page: ExtractedPage,
  directives: string[]
): AeoPageSummary["googleSnippets"] => {
  if (hasNosnippet(directives)) {
    return "blocked";
  }

  const limit = maxSnippet(directives);

  if (
    (limit !== null && limit > 0 && limit < 100) ||
    page.answer.nosnippetWords > 0
  ) {
    return "limited";
  }

  return "allowed";
};

const copilotAnswers = (
  directives: string[]
): AeoPageSummary["copilotAnswers"] => {
  // Bing: NOCACHE wins when a page has both tags.
  if (directives.includes("nocache")) {
    return hasNoindex(directives) ? "excluded" : "snippet-only";
  }

  return hasNoindex(directives) || directives.includes("noarchive")
    ? "excluded"
    : "allowed";
};

export const aeoPageSummary = (
  page: ExtractedPage,
  response?: ResponseInfo
): AeoPageSummary => {
  const article = articles(page)[0]?.node;

  return {
    indexable:
      !robotsDirectives(page, response).noindex &&
      (response?.status ?? 200) < 400,
    googleSnippets: googleSnippets(
      page,
      directivesFor("google", page, response)
    ),
    copilotAnswers: copilotAnswers(directivesFor("bing", page, response)),
    wordCount: page.wordCount,
    questions: page.answer.questions.length,
    structuredDataTypes: [
      ...new Set(page.structuredData.flatMap((i) => i.types)),
    ],
    author: article ? nameOf(article["author"]) : null,
    datePublished: article ? stringOf(article["datePublished"]) : null,
    dateModified: article ? stringOf(article["dateModified"]) : null,
  };
};
