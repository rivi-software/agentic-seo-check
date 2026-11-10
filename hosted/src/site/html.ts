/**
 * Escaping for the website's HTML. A report quotes the audited page (titles, tags, header values),
 * which someone else wrote: every such value goes through `esc` before it is put in a page.
 */

const ENTITIES = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

/** `text` as HTML text or a quoted attribute value. */
export const esc = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (char) => ENTITIES.get(char) ?? char);

/** JSON text for a <script> element: "<" escaped, so nothing in it can close the element. */
export const scriptSafe = (json: string): string =>
  json.replaceAll("<", "\\u003c");

/** A URL as a link target: http and https only, so a page's text never becomes a script URL. */
export const safeHref = (url: string): string | null =>
  /^https?:\/\//iu.test(url) ? esc(url) : null;
