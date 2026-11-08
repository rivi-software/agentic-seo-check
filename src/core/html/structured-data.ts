import { isTag } from 'domhandler';
import { type Document, type Element, attr, childElements, hasAttr, queryAll, text } from './dom.js';
import type { StructuredDataError, StructuredDataItem } from '../types.js';
import { collapseWhitespace } from './text.js';

export interface StructuredDataExtraction {
  items: StructuredDataItem[];
  errors: StructuredDataError[];
}

export function extractStructuredData(doc: Document): StructuredDataExtraction {
  const items: StructuredDataItem[] = [];
  const errors: StructuredDataError[] = [];

  for (const el of queryAll(doc, 'script[type]')) {
    const type = (attr(el, 'type') ?? '').trim().toLowerCase();
    if (type !== 'application/ld+json') continue;
    const raw = text(el).trim();
    if (!raw) {
      errors.push({ source: 'json-ld', message: 'Empty JSON-LD script block', snippet: '' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCdata(raw));
    } catch (err) {
      errors.push({
        source: 'json-ld',
        message: `Invalid JSON: ${(err as Error).message}`,
        snippet: raw.slice(0, 200),
      });
      continue;
    }
    for (const node of flattenJsonLd(parsed, null)) items.push(node);
  }

  for (const item of extractMicrodata(doc)) items.push(item);

  return { items, errors };
}

function stripCdata(text: string): string {
  return text
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '')
    .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '')
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '');
}

function flattenJsonLd(node: unknown, inheritedContext: string | null): StructuredDataItem[] {
  if (Array.isArray(node)) return node.flatMap((n) => flattenJsonLd(n, inheritedContext));
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const context = contextString(obj['@context']) ?? inheritedContext;
  if (Array.isArray(obj['@graph'])) {
    return (obj['@graph'] as unknown[]).flatMap((n) => flattenJsonLd(n, context));
  }
  return [{ source: 'json-ld', types: typesOf(obj['@type']), context, data: obj }];
}

export function contextString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = contextString(v);
      if (s) return s;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const vocab = (value as Record<string, unknown>)['@vocab'];
    if (typeof vocab === 'string') return vocab;
  }
  return null;
}

export function typesOf(value: unknown): string[] {
  if (typeof value === 'string') return [shortType(value)];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map(shortType);
  return [];
}

/** `https://schema.org/Article` -> `Article`, `schema:Article` -> `Article`. */
export function shortType(type: string): string {
  const t = type.trim();
  const slash = t.lastIndexOf('/');
  const colon = t.lastIndexOf(':');
  const cut = Math.max(slash, t.startsWith('http') ? -1 : colon);
  return cut >= 0 ? t.slice(cut + 1) : t;
}

/* ---------------------------------------------------------------------------
 * Microdata
 * ------------------------------------------------------------------------- */

function extractMicrodata(doc: Document): StructuredDataItem[] {
  const items: StructuredDataItem[] = [];
  for (const el of queryAll(doc, '[itemscope]')) {
    // Top-level scopes only: nested scopes become property values.
    if (hasItemscopeAncestor(el)) continue;
    const data = microdataObject(el);
    items.push({
      source: 'microdata',
      types: typesOf(data['@type']),
      context: contextString(data['@context']),
      data,
    });
  }
  return items;
}

function hasItemscopeAncestor(el: Element): boolean {
  for (let p = el.parent; p && isTag(p); p = p.parent) {
    if (hasAttr(p, 'itemscope')) return true;
  }
  return false;
}

function microdataObject(scope: Element): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const itemtype = attr(scope, 'itemtype');
  if (itemtype) {
    const types = itemtype.split(/\s+/).filter(Boolean);
    obj['@type'] = types.length === 1 ? types[0] : types;
    const first = types[0];
    if (first) {
      try {
        const u = new URL(first);
        obj['@context'] = `${u.protocol}//${u.host}`;
      } catch {
        /* not a URL */
      }
    }
  }
  const itemid = attr(scope, 'itemid');
  if (itemid) obj['@id'] = itemid;

  const props: Element[] = [];
  collectProps(scope, props);
  for (const el of props) {
    const names = (attr(el, 'itemprop') ?? '').split(/\s+/).filter(Boolean);
    const value = hasAttr(el, 'itemscope') ? microdataObject(el) : microdataValue(el);
    for (const name of names) {
      const existing = obj[name];
      if (existing === undefined) obj[name] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else obj[name] = [existing, value];
    }
  }
  return obj;
}

/** Walk descendants, stopping at nested itemscopes (they are added as a single property). */
function collectProps(root: Element, out: Element[]): void {
  for (const child of childElements(root)) {
    if (hasAttr(child, 'itemprop')) out.push(child);
    if (!hasAttr(child, 'itemscope')) collectProps(child, out);
  }
}

function microdataValue(el: Element): unknown {
  const tag = el.name.toLowerCase();
  switch (tag) {
    case 'meta':
      return attr(el, 'content') ?? '';
    case 'img':
    case 'audio':
    case 'embed':
    case 'iframe':
    case 'source':
    case 'track':
    case 'video':
      return attr(el, 'src') ?? '';
    case 'a':
    case 'area':
    case 'link':
      return attr(el, 'href') ?? '';
    case 'object':
      return attr(el, 'data') ?? '';
    case 'data':
    case 'meter':
      return attr(el, 'value') ?? collapseWhitespace(text(el));
    case 'time':
      return attr(el, 'datetime') ?? collapseWhitespace(text(el));
    default: {
      const content = attr(el, 'content');
      return content !== undefined ? content : collapseWhitespace(text(el));
    }
  }
}
