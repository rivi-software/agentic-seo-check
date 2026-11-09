import { selectAll, selectOne } from "css-select";
import { hasChildren, isTag, isText } from "domhandler";
import type { AnyNode, Document, Element } from "domhandler";
import { textContent } from "domutils";
import { parse } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { collapseWhitespace, wordCount } from "./text.js";

export type { AnyNode, Document, Element } from "domhandler";

/** Elements whose content is never visible page text. */
export const HIDDEN_ELEMENTS = new Set([
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

/** The text a reader sees under `root`: hidden elements left out, whitespace collapsed. */
export const visibleText = (root: AnyNode): string => {
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

  walk(hasChildren(root) ? root.children : [root]);

  return collapseWhitespace(parts.join(""));
};

/** For each <img> under `root`, the number of visible words that come before it in the document. */
export const wordsBeforeImages = (root: AnyNode): Map<Element, number> => {
  const out = new Map<Element, number>();
  let words = 0;

  const walk = (nodes: AnyNode[]): void => {
    for (const node of nodes) {
      if (isText(node)) {
        words += wordCount(node.data);
      } else if (isTag(node)) {
        if (node.name === "img") {
          out.set(node, words);
        } else if (!HIDDEN_ELEMENTS.has(node.name)) {
          walk(node.children);
        }
      } else if (hasChildren(node)) {
        walk(node.children);
      }
    }
  };

  walk(hasChildren(root) ? root.children : [root]);

  return out;
};

/**
 * Parse a full HTML document with the WHATWG algorithm (parse5), scripting enabled like a browser.
 * Elements keep where they sit in `html`, so a fix can quote them (`sourceOf`).
 */
export const parseDocument = (html: string): Document =>
  parse(html, {
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
    treeAdapter: adapter,
  });

/** Longest quote of the source a fix carries; a page with a 50 KB data: URI in a tag gets a prefix. */
export const MAX_QUOTE_CHARS = 500;

/** `text` cut to `MAX_QUOTE_CHARS`, ending in "…" when cut. */
export const quote = (text: string): string =>
  text.length > MAX_QUOTE_CHARS
    ? `${text.slice(0, MAX_QUOTE_CHARS - 1)}…`
    : text;

/**
 * The element as `html` writes it: its start tag (`start`) or the whole element (`outer`), cut to
 * `MAX_QUOTE_CHARS`. Null for an element the parser added itself, such as a missing <head>.
 */
export const sourceOf = (
  el: Element,
  html: string,
  part: "start" | "outer" = "start"
): string | null => {
  const location = el.sourceCodeLocation;

  if (!location) {
    return null;
  }

  if (part === "start") {
    const start = location.startTag;

    return start ? quote(html.slice(start.startOffset, start.endOffset)) : null;
  }

  return quote(html.slice(location.startOffset, location.endOffset));
};

/** Descendants of `root` matching a CSS selector, in document order. */
export const queryAll = (root: AnyNode, selector: string): Element[] =>
  selectAll<AnyNode, Element>(selector, root);

/** First descendant of `root` matching a CSS selector. */
export const queryOne = (root: AnyNode, selector: string): Element | null =>
  selectOne<AnyNode, Element>(selector, root);

export const attr = (el: Element, name: string): string | undefined =>
  Object.hasOwn(el.attribs, name) ? el.attribs[name] : undefined;

export const hasAttr = (el: Element, name: string): boolean =>
  Object.hasOwn(el.attribs, name);

/** DOM `textContent`: concatenated text of all descendants, comments excluded. */
export const text = (node: AnyNode | AnyNode[]): string => textContent(node);

export const childElements = (el: Element): Element[] =>
  el.children.filter(isTag);
