import { isTag, isText, hasChildren } from "domhandler";

import type {
  ExtractedPage,
  HeadingInfo,
  HreflangInfo,
  ImageInfo,
  LinkInfo,
} from "../types.js";
import { isSameSite, resolveUrl, hostOf } from "../url.js";
import { attr, parseDocument, queryAll, queryOne, text } from "./dom.js";
import type { AnyNode, Document } from "./dom.js";
import { extractStructuredData } from "./structured-data.js";
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

const detectCharset = (doc: Document): string | null => {
  const metaCharset = queryOne(doc, "meta[charset]");
  const direct = metaCharset ? attr(metaCharset, "charset") : undefined;

  if (direct) {
    return direct.trim();
  }

  const httpEquiv = queryAll(doc, "meta[http-equiv]").find(
    (el) => (attr(el, "http-equiv") ?? "").toLowerCase() === "content-type"
  );

  const content = httpEquiv ? attr(httpEquiv, "content") : undefined;
  const match = content?.match(/charset=(?<charset>[\w-]+)/iu);

  return match?.groups?.charset ?? null;
};

/** Elements whose content is never visible page text. */
const HIDDEN_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "head",
]);

/** Elements that break words apart; padded with spaces so adjacent words don't fuse. */
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "tr",
  "td",
  "th",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "blockquote",
  "pre",
  "dd",
  "dt",
  "figcaption",
]);

const visibleText = (doc: Document): string => {
  const body = queryOne(doc, "body");

  if (!body) {
    return "";
  }

  const parts: string[] = [];

  const walk = (nodes: AnyNode[]): void => {
    for (const node of nodes) {
      if (isText(node)) {
        parts.push(node.data);
      } else if (isTag(node)) {
        if (HIDDEN_ELEMENTS.has(node.name)) {
          continue;
        }

        const block = BLOCK_ELEMENTS.has(node.name);

        if (block) {
          parts.push(" ");
        }

        walk(node.children);

        if (block) {
          parts.push(" ");
        }
      } else if (hasChildren(node)) {
        walk(node.children);
      }
    }
  };

  walk(body.children);

  return collapseWhitespace(parts.join(""));
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

  const titles = queryAll(doc, "title").map((el) =>
    collapseWhitespace(text(el))
  );

  const metaDescriptions = queryAll(doc, "meta[name]")
    .filter(
      (el) => (attr(el, "name") ?? "").trim().toLowerCase() === "description"
    )
    .map((el) => collapseWhitespace(attr(el, "content") ?? ""));

  const metaRobots = queryAll(doc, "meta[name]")
    .filter((el) =>
      ["robots", "googlebot", "googlebot-news", "bingbot"].includes(
        (attr(el, "name") ?? "").trim().toLowerCase()
      )
    )
    .map((el) => collapseWhitespace(attr(el, "content") ?? "").toLowerCase())
    .filter(Boolean);

  const canonicals = queryAll(doc, "link[rel]")
    .filter((el) => relList(attr(el, "rel")).includes("canonical"))
    .map((el) => (attr(el, "href") ?? "").trim());

  const headings: HeadingInfo[] = queryAll(doc, "h1, h2, h3, h4, h5, h6").map(
    (el) => ({
      level: Number(el.name.slice(1)),
      text: collapseWhitespace(text(el)),
    })
  );

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};

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
    } else if (key.startsWith("twitter:") && !(key in twitter)) {
      twitter[key.slice(8)] = content;
    }
  }

  const images: ImageInfo[] = queryAll(doc, "img").map((el) => ({
    src: attr(el, "src") ?? attr(el, "data-src") ?? null,
    alt: attr(el, "alt") ?? null,
    width: attr(el, "width") ?? null,
    height: attr(el, "height") ?? null,
    loading: attr(el, "loading") ?? null,
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
      };
    });

  const structured = extractStructuredData(doc);

  const bodyText = visibleText(doc);

  const htmlEl = queryOne(doc, "html");
  const viewportEl = queryOne(doc, 'meta[name="viewport" i]');

  return {
    url: options.url,
    hasDoctype,
    lang: attrOrNull(htmlEl ? attr(htmlEl, "lang") : undefined),
    charset: detectCharset(doc),
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
    structuredData: structured.items,
    structuredDataErrors: structured.errors,
    text: bodyText,
    wordCount: wordCount(bodyText),
    htmlBytes: Buffer.byteLength(html, "utf-8"),
    hasBaseHref: Boolean(baseHref),
  };
};
