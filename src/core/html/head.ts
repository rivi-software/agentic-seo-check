import { isTag, isText } from "domhandler";
import { parse } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import type { HeadSignals, MetaRefresh } from "../types.js";
import { attr, queryAll, queryOne } from "./dom.js";
import type { AnyNode, Document, Element } from "./dom.js";
import { collapseWhitespace } from "./text.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * Meta names search engines read in <head> only. Robots meta tags are left out: Google honours
 * them in <body> too.
 */
const HEAD_META_NAMES = new Set(["description", "viewport"]);

/*
 * Where the author's <head> ends: the first `</head>` or `<body>` tag. Both alternatives are fixed
 * words followed by one character, so the search stays linear on long documents.
 */
const HEAD_END = /<\/head[\s/>]|<body[\s/>]/iu;

/** Longest stretch of source quoted for the element or text that ends <head>. */
const MAX_QUOTE = 120;

/** False for SVG and MathML elements such as an icon's `<title>`, which are not page metadata. */
export const isHtmlElement = (el: Element): boolean =>
  !el.namespace || el.namespace === HTML_NAMESPACE;

const relTokens = (el: Element): string[] =>
  (attr(el, "rel") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);

/**
 * The metadata element as it is written (`<meta name="description">`, `<link rel="canonical">`),
 * or null for elements that also belong in <body>, such as microdata `<meta itemprop>`.
 */
export const describeMetadata = (el: Element): string | null => {
  if (!isHtmlElement(el)) {
    return null;
  }

  if (el.name === "title") {
    return "<title>";
  }

  if (el.name === "meta") {
    const name = (attr(el, "name") ?? "").trim().toLowerCase();

    return HEAD_META_NAMES.has(name) ? `<meta name="${name}">` : null;
  }

  if (el.name === "link") {
    const rel = relTokens(el);

    if (rel.includes("canonical")) {
      return '<link rel="canonical">';
    }

    const hreflang = attr(el, "hreflang")?.trim();

    if (rel.includes("alternate") && hreflang) {
      return `<link rel="alternate" hreflang="${hreflang.slice(0, 20)}">`;
    }
  }

  return null;
};

interface BodyMetadata {
  described: string;
  /** Inside a hidden element, where React streams tags that its JavaScript then hoists into <head>. */
  streamed: boolean;
}

const isInsideHidden = (el: Element): boolean => {
  for (let node = el.parent; node && isTag(node); node = node.parent) {
    if (node.name === "body") {
      return false;
    }

    if (attr(node, "hidden") !== undefined) {
      return true;
    }
  }

  return false;
};

const metadataElements = (root: AnyNode): BodyMetadata[] =>
  queryAll(root, "title, meta[name], link[rel]").flatMap((el) => {
    const described = describeMetadata(el);

    return described ? [{ described, streamed: isInsideHidden(el) }] : [];
  });

/** Metadata elements under `root`, in document order, as `describeMetadata` writes them. */
const metadataIn = (root: AnyNode): string[] =>
  metadataElements(root).map((m) => m.described);

/** Characters that look like whitespace but end <head>, by the name a reader recognizes. */
const INVISIBLE_NAMES = new Map([
  [0xfe_ff, "byte order mark"],
  [0xa0, "no-break space, &nbsp;"],
]);

/** "U+FEFF (byte order mark)" for the characters in text that is not ASCII whitespace. */
const invisibleCharacters = (data: string): string =>
  [...new Set([...data].filter((c) => !"\t\n\f\r ".includes(c)))]
    .slice(0, 3)
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      const name = INVISIBLE_NAMES.get(code);
      const hex = code.toString(16).toUpperCase().padStart(4, "0");

      return name ? `U+${hex} (${name})` : `U+${hex}`;
    })
    .join(", ");

/** The source of an element's start tag, or a text node's first words. */
const quote = (node: AnyNode, source: string): string => {
  if (isText(node)) {
    const words = collapseWhitespace(node.data);

    if (!words) {
      return `invisible character ${invisibleCharacters(node.data)}`;
    }

    return `text "${words.length > 40 ? `${words.slice(0, 40)}…` : words}"`;
  }

  const location = isTag(node) ? node.sourceCodeLocation : undefined;

  if (!location) {
    return isTag(node) ? `<${node.name}>` : "unknown";
  }

  const end = Math.min(
    location.startTag?.endOffset ?? location.endOffset,
    location.startOffset + MAX_QUOTE
  );

  return collapseWhitespace(source.slice(location.startOffset, end));
};

interface HeadParse {
  /** The element or text the parser moved out of <head>, which ended it. */
  closedBy: AnyNode | null;
  /** Metadata written after it. */
  afterClose: string[];
  doc: Document;
}

/**
 * Parse only what the author wrote before `</head>` or `<body>`. Everything the parser puts in
 * <body> then sat inside <head> in the source: the first such node is what ended <head>, the way
 * Google stops reading <head> at the first element that does not belong there.
 */
const parseHead = (prefix: string, scriptingEnabled: boolean): HeadParse => {
  const doc = parse(prefix, {
    scriptingEnabled,
    sourceCodeLocationInfo: true,
    treeAdapter: adapter,
  });

  const body = queryOne(doc, "body");

  // Only ASCII whitespace keeps <head> open; a stray byte order mark or &nbsp; ends it.
  const closedBy =
    body?.children.find(
      (node) => isTag(node) || (isText(node) && /[^\t\n\f\r ]/u.test(node.data))
    ) ?? null;

  return {
    closedBy,
    afterClose: body && closedBy ? metadataIn(body) : [],
    doc,
  };
};

/** `<meta http-equiv="refresh" content="5; url=/next">` as seconds and target. */
const parseRefresh = (content: string): MetaRefresh => {
  const value = content.slice(0, 2048).trim();
  const separator = value.search(/[;,]/u);
  const time = (separator === -1 ? value : value.slice(0, separator)).trim();
  let target = separator === -1 ? "" : value.slice(separator + 1).trim();

  if (/^url\s*=/iu.test(target)) {
    target = target.slice(target.indexOf("=") + 1).trim();
  }

  if (/^["']/u.test(target)) {
    const closing = target.indexOf(target.charAt(0), 1);
    target = target.slice(1, closing === -1 ? undefined : closing);
  }

  const seconds = /^\d+(?:\.\d*)?$/u.test(time)
    ? Math.floor(Number(time))
    : null;

  return { seconds, url: target.trim() || null };
};

/** Byte offset where the element declaring the character encoding ends, in the source of <head>. */
const charsetEnd = (doc: Document, source: string): number | null => {
  const declaration = queryAll(doc, "meta").find(
    (el) =>
      attr(el, "charset") !== undefined ||
      (attr(el, "http-equiv") ?? "").trim().toLowerCase() === "content-type"
  );

  const end = declaration?.sourceCodeLocation?.endOffset;

  return end === undefined ? null : Buffer.byteLength(source.slice(0, end));
};

/** Metadata in <body>, apart from what a framework streams there for its JavaScript to move. */
const splitStreamed = (
  items: BodyMetadata[]
): Pick<HeadSignals, "inBody" | "streamedInBody"> => ({
  inBody: items.flatMap((m) => (m.streamed ? [] : [m.described])),
  streamedInBody: items.flatMap((m) => (m.streamed ? [m.described] : [])),
});

/** Types that make a <script> run as JavaScript; anything else (JSON, templates) never blocks. */
const isJavaScriptType = (type: string | undefined): boolean => {
  const t = (type ?? "").trim().toLowerCase();

  return t === "" || t.endsWith("javascript") || t.endsWith("ecmascript");
};

/**
 * Scripts in <head> the parser waits for: external, classic, neither async nor defer. A nomodule
 * script is a fallback for old browsers, which current ones neither download nor run.
 */
const blockingScripts = (doc: Document): string[] =>
  queryAll(doc, "head script[src]")
    .filter(
      (el) =>
        isJavaScriptType(attr(el, "type")) &&
        attr(el, "async") === undefined &&
        attr(el, "defer") === undefined &&
        attr(el, "nomodule") === undefined
    )
    .map((el) => (attr(el, "src") ?? "").trim());

const ICON_RELS = new Set([
  "icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
]);

const iconLinks = (doc: Document): string[] =>
  queryAll(doc, "link[rel][href]")
    .filter((el) => relTokens(el).some((rel) => ICON_RELS.has(rel)))
    .map((el) => (attr(el, "href") ?? "").trim());

export const extractHeadSignals = (
  html: string,
  doc: Document
): HeadSignals => {
  const refresh = queryAll(doc, "meta[http-equiv]")
    .filter(
      (el) => (attr(el, "http-equiv") ?? "").trim().toLowerCase() === "refresh"
    )
    .map((el) => parseRefresh(attr(el, "content") ?? ""));

  const body = queryOne(doc, "body");
  const metadataInBody = body ? metadataElements(body) : [];

  const end = HEAD_END.exec(html);

  if (!end) {
    return {
      closedBy: null,
      closedInNoscript: false,
      afterClose: [],
      ...splitStreamed(metadataInBody),
      refresh,
      charsetEndByte: null,
      blockingScripts: blockingScripts(doc),
      icons: iconLinks(doc),
    };
  }

  const prefix = html.slice(0, end.index);
  const browser = parseHead(prefix, true);

  // A <noscript> in <head> is text to a browser that runs scripts and markup to one that does not.
  const plain = browser.closedBy ? browser : parseHead(prefix, false);
  const { closedBy } = plain;

  return {
    closedBy: closedBy ? quote(closedBy, prefix) : null,
    closedInNoscript: !browser.closedBy && Boolean(closedBy),
    afterClose: plain.afterClose,
    // The parse of the whole page puts metadata after `closedBy` in <body> too; count it once.
    ...splitStreamed(metadataInBody.slice(browser.afterClose.length)),
    refresh,
    charsetEndByte: charsetEnd(browser.doc, prefix),
    blockingScripts: blockingScripts(doc),
    icons: iconLinks(doc),
  };
};
