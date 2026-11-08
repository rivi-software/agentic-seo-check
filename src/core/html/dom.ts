import { selectAll, selectOne } from 'css-select';
import { type AnyNode, type Document, type Element, isTag } from 'domhandler';
import { textContent } from 'domutils';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

export type { AnyNode, Document, Element };

/** Parse a full HTML document with the WHATWG algorithm (parse5), scripting enabled like a browser. */
export function parseDocument(html: string): Document {
  return parse(html, { treeAdapter: adapter, scriptingEnabled: true });
}

/** Descendants of `root` matching a CSS selector, in document order. */
export function queryAll(root: AnyNode, selector: string): Element[] {
  return selectAll<AnyNode, Element>(selector, root);
}

/** First descendant of `root` matching a CSS selector. */
export function queryOne(root: AnyNode, selector: string): Element | null {
  return selectOne<AnyNode, Element>(selector, root);
}

export function attr(el: Element, name: string): string | undefined {
  return Object.hasOwn(el.attribs, name) ? el.attribs[name] : undefined;
}

export function hasAttr(el: Element, name: string): boolean {
  return Object.hasOwn(el.attribs, name);
}

/** DOM `textContent`: concatenated text of all descendants, comments excluded. */
export function text(node: AnyNode | AnyNode[]): string {
  return textContent(node);
}

export function childElements(el: Element): Element[] {
  return el.children.filter(isTag);
}
