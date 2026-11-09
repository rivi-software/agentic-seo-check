import { normalizeUrl, resolveUrl } from "../url.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** The HTML spec's limit for the element that declares the encoding. */
const CHARSET_PRESCAN_BYTES = 1024;

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

export const headRules = [
  defineRule(
    {
      id: "head.closed-early",
      category: "document",
      severity: "error",
      description:
        "An element that does not belong in <head> (an <img>, <iframe>, <div>, stray text) ends it early, so search engines read the metadata after it as part of <body> and ignore it.",
      recommendation:
        "Move the element out of <head>, into <body>, or at least below every <title>, <meta> and <link>. Only <title>, <meta>, <link>, <script>, <style>, <base>, <noscript> and <template> belong in <head>. A tag manager's or ad pixel's <noscript><iframe> or <img> goes right after the opening <body> tag.",
      docs: GOOGLE_DOCS.validMetadata,
    },
    ({ page }, make) => {
      const { closedBy, closedInNoscript, afterClose } = page.head;

      if (!closedBy || afterClose.length === 0) {
        return null;
      }

      if (closedInNoscript) {
        return make(
          `A <noscript> in <head> holds ${closedBy}, which ends <head> for a parser that does not run JavaScript, so it reads the ${plural(afterClose.length, "metadata element")} after it as <body>: ${cap(afterClose, 5).join(", ")}.`,
          {
            severity: "info",
            recommendation:
              "Move the <noscript> block below every <title>, <meta> and <link>, or right after the opening <body> tag, where tag managers and ad pixels document it. Inside a <noscript> in <head>, only <link>, <meta> and <style> keep <head> open.",
            selector: "head > noscript",
            evidence: {
              closedBy,
              inNoscript: true,
              metadataAfter: cap(afterClose),
            },
          }
        );
      }

      // Losing the viewport costs the mobile layout; losing the rest costs what Google indexes.
      const onlyViewport = afterClose.every(
        (m) => m === '<meta name="viewport">'
      );

      // An invisible character is removed, not moved: it usually comes from a file saved with a BOM.
      const invisible = closedBy.startsWith("invisible character");

      return make(
        `<head> ends at ${closedBy}, so Google ignores the ${plural(afterClose.length, "metadata element")} after it: ${cap(afterClose, 5).join(", ")}.`,
        {
          severity: onlyViewport ? "warning" : "error",
          recommendation: invisible
            ? "Remove the invisible character from <head>. A U+FEFF byte order mark usually comes from a template or include file saved as UTF-8 with BOM: save it as UTF-8 without BOM. A U+00A0 comes from an &nbsp; in the template's <head>."
            : undefined,
          selector: "head",
          evidence: {
            closedBy,
            inNoscript: false,
            metadataAfter: cap(afterClose),
          },
        }
      );
    }
  ),
  defineRule(
    {
      id: "head.metadata-in-body",
      category: "document",
      severity: "warning",
      description:
        "Metadata that search engines read only in <head> (title, meta description, viewport, canonical, hreflang) is written in <body> (warning). Metadata a framework streams into a hidden part of <body> and moves into <head> with JavaScript, as Next.js does for an async generateMetadata, is info. Robots meta tags are not reported: Google honours them in <body> too.",
      recommendation:
        "Move these elements into <head>. Google accepts rel=canonical only in <head>. A framework that renders them in a page component usually has a head API for them (metadata export, <Head>, useHead, <svelte:head>).",
      docs: GOOGLE_DOCS.validMetadata,
    },
    ({ page }, make) => {
      const { inBody, streamedInBody } = page.head;

      if (inBody.length > 0) {
        return make(
          `${plural(inBody.length, "metadata element")} ${inBody.length === 1 ? "is" : "are"} in <body>: ${cap(inBody, 5).join(", ")}.`,
          { selector: "body", evidence: { elements: cap(inBody) } }
        );
      }

      // Next.js (15.2+) streams metadata from an async generateMetadata this way to clients it does
      // not count as HTML-limited bots; Googlebot reads it after rendering.
      return streamedInBody.length > 0
        ? make(
            `${plural(streamedInBody.length, "metadata element")} ${streamedInBody.length === 1 ? "is" : "are"} streamed into a hidden part of <body> (React or Next.js streaming metadata): ${cap(streamedInBody, 5).join(", ")}.`,
            {
              severity: "info",
              recommendation:
                "Google renders the page and reads streamed metadata, so this is fine for Google Search. Crawlers that do not run JavaScript only get it in <head> if the framework holds the response for them: in Next.js, add their User-Agents to htmlLimitedBots in next.config, or make generateMetadata static.",
              selector: "body [hidden]",
              evidence: { elements: cap(streamedInBody), streamed: true },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "meta-refresh.redirect",
      category: "indexing",
      severity: "warning",
      description:
        'A <meta http-equiv="refresh"> sends visitors to another URL. Google reads an instant one as a permanent redirect (info) and a delayed one as a temporary redirect (warning), and prefers a redirect from the server.',
      recommendation:
        "Redirect on the server with a 301 (or 308) to the new URL. If the server cannot redirect, set the meta refresh to 0 seconds, which Google reads as a permanent redirect.",
      docs: GOOGLE_DOCS.redirects,
    },
    ({ page }, make) => {
      const redirect = page.head.refresh.find((r) => r.url);

      if (!redirect?.url) {
        return null;
      }

      const target = resolveUrl(redirect.url, page.url) ?? redirect.url;
      const delay = redirect.seconds ?? 0;

      // A refresh to the page's own URL reloads it (a news front page); it redirects nowhere.
      if (
        (normalizeUrl(target) ?? target) ===
        (normalizeUrl(page.url) ?? page.url)
      ) {
        return null;
      }

      return make(
        delay > 0
          ? `Page redirects to ${target} with a meta refresh after ${plural(delay, "second")}, which Google treats as a temporary redirect.`
          : `Page redirects to ${target} with an instant meta refresh.`,
        {
          severity: delay > 0 ? "warning" : "info",
          selector: 'meta[http-equiv="refresh"]',
          evidence: { target, seconds: redirect.seconds },
        }
      );
    }
  ),
  defineRule(
    {
      id: "charset.late",
      category: "document",
      severity: "info",
      description:
        "The character encoding is declared after the first 1024 bytes, where the HTML spec requires it, and the Content-Type header does not declare it.",
      recommendation:
        'Put <meta charset="utf-8"> first in <head>, before any script, style or comment, or send the encoding in the Content-Type header (text/html; charset=utf-8).',
      docs: "https://html.spec.whatwg.org/multipage/semantics.html#charset",
    },
    ({ page, response }, make) => {
      const end = page.head.charsetEndByte;

      if (end === null || end <= CHARSET_PRESCAN_BYTES) {
        return null;
      }

      if (/charset=/iu.test(response?.contentType ?? "")) {
        return null;
      }

      return make(
        `The charset declaration ends at byte ${end}, past the first ${CHARSET_PRESCAN_BYTES}.`,
        { selector: "head > meta[charset]", evidence: { endsAtByte: end } }
      );
    }
  ),
];
