import { isTag } from "domhandler";

import type {
  ExtractedPage,
  HeadingInfo,
  HreflangInfo,
  ImageInfo,
  LinkInfo,
  PageMarkup,
  TextBlock,
} from "../types.js";
import { isSameSite, resolveUrl, hostOf } from "../url.js";
import { extractAnswerSignals } from "./answer.js";
import {
  attr,
  HIDDEN_ELEMENTS,
  parseDocument,
  queryAll,
  queryOne,
  sourceOf,
  text,
  visibleText,
  wordsBeforeImages,
} from "./dom.js";
import type { AnyNode, Document, Element } from "./dom.js";
import { extractHeadSignals, isHtmlElement } from "./head.js";
import {
  extractMissingFragments,
  extractResources,
  upgradesInsecureRequests,
} from "./resources.js";
import { classSelectorsOf, extractStructuredData } from "./structured-data.js";
import { collapseWhitespace, wordCount } from "./text.js";

export interface ExtractOptions {
  /** Absolute URL of the document; relative links are resolved against it (or against <base href>). */
  url: string;
  /** Treat subdomains of the site host as internal. */
  includeSubdomains?: boolean;
  /** Host used to classify links as internal. Defaults to the host of `url`. */
  siteHost?: string;
}

const relList = (rel: string | null | undefined): string[] =>
  (rel ?? "").toLowerCase().split(/\s+/u).filter(Boolean);

const attrOrNull = (value: string | undefined): string | null =>
  value?.trim() || null;

const firstNonEmpty = (values: string[]): string | null => {
  for (const v of values) {
    if (v) {
      return v;
    }
  }

  return null;
};

/** The element that declares the character encoding, and the encoding it names. */
interface CharsetDeclaration {
  charset: string | null;
  el: Element | null;
}

const detectCharset = (doc: Document): CharsetDeclaration => {
  const metaCharset = queryOne(doc, "meta[charset]");
  const direct = metaCharset ? attr(metaCharset, "charset") : undefined;

  if (direct) {
    return { charset: direct.trim(), el: metaCharset };
  }

  const httpEquiv = queryAll(doc, "meta[http-equiv]").find(
    (el) => (attr(el, "http-equiv") ?? "").toLowerCase() === "content-type"
  );

  const content = httpEquiv ? attr(httpEquiv, "content") : undefined;
  const match = content?.match(/charset=(?<charset>[\w-]+)/iu);

  return { charset: match?.groups?.charset ?? null, el: httpEquiv ?? null };
};

const ROBOTS_META_NAMES = new Set([
  "robots",
  "googlebot",
  "googlebot-news",
  "bingbot",
]);

const nameOf = (el: Element): string =>
  (attr(el, "name") ?? "").trim().toLowerCase();

interface SocialTags {
  og: Record<string, string>;
  twitter: Record<string, string>;
  /** The tag of each property kept, keyed with its prefix ("og:image"). */
  social: Record<string, string>;
}

/** Open Graph and Twitter properties, with the tag each one comes from. */
const extractSocial = (
  doc: Document,
  tagOf: (el: Element) => string
): SocialTags => {
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const social: Record<string, string> = {};

  for (const el of queryAll(doc, "meta[property], meta[name]")) {
    const key = (attr(el, "property") ?? attr(el, "name") ?? "")
      .trim()
      .toLowerCase();

    const content = collapseWhitespace(attr(el, "content") ?? "");

    if (!key) {
      continue;
    }

    if (key.startsWith("og:") && !(key in og)) {
      og[key.slice(3)] = content;
      social[key] = tagOf(el);
    } else if (key.startsWith("twitter:") && !(key in twitter)) {
      twitter[key.slice(8)] = content;
      social[key] = tagOf(el);
    }
  }

  return { og, twitter, social };
};

const BLOCK_ELEMENTS = new Set([
  "p",
  "li",
  "dd",
  "dt",
  "td",
  "th",
  "blockquote",
  "figcaption",
]);

const MAX_BLOCKS = 300;

/**
 * The body's innermost text blocks with text, quoted as written, so a fix can rewrite one passage
 * (a placeholder paragraph, a hard-to-read one) instead of words cut out of the joined page text.
 * One walk from the top that skips hidden subtrees and stops at `MAX_BLOCKS`: a hostile page of
 * deep nesting and empty paragraphs costs no more than its size.
 */
const extractBlocks = (
  body: Element | null,
  tagOf: (el: Element, part?: "start" | "outer") => string
): TextBlock[] => {
  const out: TextBlock[] = [];

  // Whether `nodes` hold a block, so a block knows whether it is the innermost one.
  const walk = (nodes: AnyNode[]): boolean => {
    let holdsBlock = false;

    for (const node of nodes) {
      if (out.length >= MAX_BLOCKS) {
        return true;
      }

      if (!isTag(node) || HIDDEN_ELEMENTS.has(node.name)) {
        continue;
      }

      const inner = walk(node.children);

      if (BLOCK_ELEMENTS.has(node.name)) {
        holdsBlock = true;
        const blockText = inner ? "" : visibleText(node);

        if (blockText) {
          out.push({
            text: blockText,
            outer: tagOf(node, "outer"),
            tag: tagOf(node),
            name: node.name,
          });
        }
      } else if (inner) {
        holdsBlock = true;
      }
    }

    return holdsBlock;
  };

  if (body) {
    walk(body.children);
  }

  return out;
};

export const extractPage = (
  html: string,
  options: ExtractOptions
): ExtractedPage => {
  const doc = parseDocument(html);
  const hasDoctype = /^\s*<!doctype\s+html/iu.test(html);
  const baseEl = queryOne(doc, "base[href]");
  const baseHref = baseEl ? attr(baseEl, "href") : undefined;
  const base = (baseHref && resolveUrl(baseHref, options.url)) || options.url;
  const siteHost = options.siteHost ?? hostOf(options.url) ?? "";

  // Elements the parser added itself have no source; their quote is the bare start tag.
  const tagOf = (el: Element, part: "start" | "outer" = "start"): string =>
    sourceOf(el, html, part) ?? `<${el.name}>`;

  // An inline SVG icon's <title> is its accessible name, not a second page title.
  const titleEls = queryAll(doc, "title").filter(isHtmlElement);
  const titles = titleEls.map((el) => collapseWhitespace(text(el)));

  const descriptionEls = queryAll(doc, "meta[name]").filter(
    (el) => nameOf(el) === "description"
  );

  const metaDescriptions = descriptionEls.map((el) =>
    collapseWhitespace(attr(el, "content") ?? "")
  );

  const robotsEls = queryAll(doc, "meta[name]").filter((el) =>
    ROBOTS_META_NAMES.has(nameOf(el))
  );

  const metaRobots = robotsEls
    .map((el) => collapseWhitespace(attr(el, "content") ?? "").toLowerCase())
    .filter(Boolean);

  const canonicalEls = queryAll(doc, "link[rel]").filter((el) =>
    relList(attr(el, "rel")).includes("canonical")
  );

  const canonicals = canonicalEls.map((el) => (attr(el, "href") ?? "").trim());
  const headingEls = queryAll(doc, "h1, h2, h3, h4, h5, h6");

  const headings: HeadingInfo[] = headingEls.map((el) => ({
    level: Number(el.name.slice(1)),
    text: collapseWhitespace(text(el)),
  }));

  const { og, twitter, social } = extractSocial(doc, tagOf);

  const body = queryOne(doc, "body");
  const position = body ? wordsBeforeImages(body) : new Map<Element, number>();

  const images: ImageInfo[] = queryAll(doc, "img").map((el) => ({
    src: attr(el, "src") ?? attr(el, "data-src") ?? null,
    alt: attr(el, "alt") ?? null,
    width: attr(el, "width") ?? null,
    height: attr(el, "height") ?? null,
    loading: attr(el, "loading") ?? null,
    srcset: attr(el, "srcset") ?? null,
    inPicture:
      el.parent !== null && isTag(el.parent) && el.parent.name === "picture",
    fetchpriority: attr(el, "fetchpriority")?.trim().toLowerCase() ?? null,
    tag: tagOf(el),
    wordsBefore: position.get(el) ?? null,
  }));

  const links: LinkInfo[] = queryAll(doc, "a[href]").map((el) => {
    const href = (attr(el, "href") ?? "").trim();

    // Fragment-only and empty hrefs are not links to other documents.
    const url =
      href === "" || href.startsWith("#") ? null : resolveUrl(href, base);

    const rel = attr(el, "rel") ?? null;
    const relTokens = relList(rel);
    const linkText = collapseWhitespace(text(el));
    const ariaLabel = collapseWhitespace(attr(el, "aria-label") ?? "");
    const title = collapseWhitespace(attr(el, "title") ?? "");

    const imgAlt = queryAll(el, "img[alt]")
      .map((img) => collapseWhitespace(attr(img, "alt") ?? ""))
      .find(Boolean);

    return {
      href,
      url,
      text: linkText,
      rel,
      internal: url
        ? isSameSite(url, siteHost, options.includeSubdomains)
        : false,
      nofollow: relTokens.includes("nofollow"),
      hasAccessibleName: Boolean(linkText || ariaLabel || title || imgAlt),
      tag: tagOf(el),
      outer: tagOf(el, "outer"),
    };
  });

  const hreflang: HreflangInfo[] = queryAll(doc, "link[rel]")
    .filter(
      (el) =>
        relList(attr(el, "rel")).includes("alternate") && attr(el, "hreflang")
    )
    .map((el) => {
      const href = (attr(el, "href") ?? "").trim();

      return {
        lang: (attr(el, "hreflang") ?? "").trim(),
        href,
        url: resolveUrl(href, base),
        tag: tagOf(el),
      };
    });

  const structured = extractStructuredData(doc);

  // A paywalled section's class, looked up while the DOM is open; rules never see the DOM.
  const cssSelectors = classSelectorsOf(structured.items).map((selector) => {
    try {
      return { selector, found: queryOne(doc, selector) !== null };
    } catch {
      return { selector, found: false };
    }
  });

  const bodyText = body ? visibleText(body) : "";

  const htmlEl = queryOne(doc, "html");
  const headEl = queryOne(doc, "head");
  const viewportEl = queryOne(doc, 'meta[name="viewport" i]');
  const charset = detectCharset(doc);

  const markup: PageMarkup = {
    html: htmlEl ? sourceOf(htmlEl, html) : null,
    head: headEl ? sourceOf(headEl, html) : null,
    titles: titleEls.map((el) => tagOf(el, "outer")),
    metaDescriptions: descriptionEls.map((el) => tagOf(el)),
    metaRobots: robotsEls.map((el) => tagOf(el)),
    canonicals: canonicalEls.map((el) => tagOf(el)),
    headings: headingEls.map((el) => tagOf(el, "outer")),
    viewport: viewportEl ? tagOf(viewportEl) : null,
    charset: charset.el ? tagOf(charset.el) : null,
    social,
    jsonLd: queryAll(doc, "script[type]")
      .filter(
        (el) =>
          (attr(el, "type") ?? "").trim().toLowerCase() ===
          "application/ld+json"
      )
      .map((el) => tagOf(el)),
    blocks: extractBlocks(body, tagOf),
  };

  return {
    url: options.url,
    hasDoctype,
    lang: attrOrNull(htmlEl ? attr(htmlEl, "lang") : undefined),
    charset: charset.charset,
    viewport: attrOrNull(viewportEl ? attr(viewportEl, "content") : undefined),
    titles,
    title: firstNonEmpty(titles),
    metaDescriptions,
    metaDescription: firstNonEmpty(metaDescriptions),
    metaRobots,
    canonicals,
    canonical: canonicals[0] ? resolveUrl(canonicals[0], base) : null,
    headings,
    h1s: headings.flatMap((h) => (h.level === 1 ? [h.text] : [])),
    og,
    twitter,
    images,
    links,
    hreflang,
    resources: extractResources(doc, base),
    upgradesInsecureRequests: upgradesInsecureRequests(doc),
    missingFragments: extractMissingFragments(doc),
    structuredData: structured.items,
    structuredDataErrors: structured.errors,
    cssSelectors,
    text: bodyText,
    wordCount: wordCount(bodyText),
    htmlBytes: Buffer.byteLength(html, "utf-8"),
    hasBaseHref: Boolean(baseHref),
    head: extractHeadSignals(html, doc),
    markup,
    answer: extractAnswerSignals(doc, bodyText, html),
  };
};

/**
 * Gives each page's links the strings of an equal link an earlier page had, for an audit that
 * keeps many pages' extracts (a crawl, a directory). A site repeats its menu and footer on every
 * page, and the site rules read every page's links at the end: 100 pages with an 800-link menu
 * kept 80,000 copies of the same few strings, the largest part of what ran the hosted Worker out
 * of memory. Only strings are shared, never a link, so each page still has links of its own.
 */
export const linkStringSharer = (): ((links: LinkInfo[]) => void) => {
  /** The first link with each `outer`, the whole `<a>` element as the page writes it. */
  const seen = new Map<string, LinkInfo>();

  return (links) => {
    for (const link of links) {
      const known = seen.get(link.outer);

      if (!known) {
        seen.set(link.outer, link);
        continue;
      }

      // `outer` is cut at 500 characters, and `url` depends on the page's address: share the
      // strings only when every one of them is equal.
      if (
        known.href === link.href &&
        known.url === link.url &&
        known.text === link.text &&
        known.rel === link.rel &&
        known.tag === link.tag
      ) {
        link.href = known.href;
        link.url = known.url;
        link.text = known.text;
        link.rel = known.rel;
        link.tag = known.tag;
        link.outer = known.outer;
      }
    }
  };
};
