import { selectAll, selectOne } from "css-select";
import { hasChildren, isTag, isText } from "domhandler";
import type { AnyNode, Document, Element } from "domhandler";
import { textContent } from "domutils";
import { parse } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";

import { collapseWhitespace } from "./text.js";

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

/** Parse a full HTML document with the WHATWG algorithm (parse5), scripting enabled like a browser. */
export const parseDocument = (html: string): Document =>
  parse(html, { scriptingEnabled: true, treeAdapter: adapter });

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
