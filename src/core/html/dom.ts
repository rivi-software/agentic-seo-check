import { selectAll, selectOne } from "css-select";
import { isTag } from "domhandler";
import type { AnyNode, Document, Element } from "domhandler";
import { textContent } from "domutils";
import { parse } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";

export type { AnyNode, Document, Element } from "domhandler";

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
