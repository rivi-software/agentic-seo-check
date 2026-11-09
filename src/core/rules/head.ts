import type { ExtractedPage, FixEdit, ResponseInfo } from "../types.js";
import { normalizeUrl, resolveUrl } from "../url.js";
import { isLocalHost } from "./canonical.js";
import {
  addHtml,
  escapeAttribute,
  isCut,
  removeEdit,
  replaceEdit,
} from "./fix.js";
import { liveUrl, ORIGIN_WRITE } from "./quoted-tags.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** The HTML spec's limit for the element that declares the encoding. */
const CHARSET_PRESCAN_BYTES = 1024;

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The edits that move what ended <head> to the start of <body>. A browser already shows it there,
 * so the page looks the same; only the metadata after it comes back into <head>.
 */
const moveToBody = (
  source: string | null,
  described: string,
  write: string
): FixEdit[] => {
  // Without a verbatim quote, the short description is the best handle on the element.
  const quoted = source ?? described;

  if (!source || isCut(source)) {
    return [
      removeEdit("html", quoted, {
        at: "head",
        write: `${write} Move the whole element there, with its content and end tag.`,
      }),
    ];
  }

  return [
    removeEdit("html", source, { at: "head" }),
    addHtml("body", source, write),
  ];
};

/** Moves metadata elements from <body> to <head>, where search engines read them. */
const moveToHead = (sources: string[], write?: string): FixEdit[] =>
  cap(sources, 5).flatMap((source) => [
    removeEdit("html", source, { at: "body" }),
    addHtml("head", source, write),
  ]);

/** "HTTP/1.1 200 OK" for the response, as near as the audit knows it. */
const statusLine = (response: ResponseInfo | undefined): string =>
  response?.status && response.status !== 200
    ? `HTTP/1.1 ${response.status}`
    : "HTTP/1.1 200 OK";

/** The server redirect that replaces a meta refresh to `target`, and the removal of the tag. */
const serverRedirect = (
  page: ExtractedPage,
  response: ResponseInfo | undefined,
  target: string,
  tag: string | undefined
): FixEdit[] => {
  const local = isLocalHost(page.url) || page.url.startsWith("file:");
  const location = liveUrl(target, local);

  const redirect = replaceEdit(
    "http",
    statusLine(response),
    `HTTP/1.1 301 Moved Permanently\nLocation: ${location}`,
    {
      write: [
        local ? ORIGIN_WRITE : undefined,
        `Set in the server, host or framework config (a redirects file or rule). If the server cannot redirect, keep the meta refresh with content="0; url=${target}", which Google reads as a permanent redirect.`,
      ]
        .filter(Boolean)
        .join(" "),
    }
  );

  return tag
    ? [redirect, removeEdit("html", tag, { at: 'meta[http-equiv="refresh"]' })]
    : [redirect];
};

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
            fix: moveToBody(
              page.head.sources.closedBy,
              closedBy,
              "Right after the opening <body> tag, where tag managers and ad pixels document their <noscript> block."
            ),
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

      const source = page.head.sources.closedBy;

      return make(
        `<head> ends at ${closedBy}, so Google ignores the ${plural(afterClose.length, "metadata element")} after it: ${cap(afterClose, 5).join(", ")}.`,
        {
          severity: onlyViewport ? "warning" : "error",
          fix:
            invisible && source
              ? [
                  removeEdit("html", source, {
                    at: "head",
                    write:
                      "Delete the invisible character. A byte order mark (U+FEFF) comes from a template or include saved as UTF-8 with BOM: save it without BOM. A no-break space comes from an &nbsp; in <head>.",
                  }),
                ]
              : moveToBody(
                  source,
                  closedBy,
                  "Right after the opening <body> tag, where the browser already shows it, so the page looks the same."
                ),
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
          {
            fix: moveToHead(
              page.head.sources.inBody,
              "In a framework, render it through the route's head API (metadata export, <Head>, useHead, <svelte:head>) instead of in the page body."
            ),
            selector: "body",
            evidence: { elements: cap(inBody) },
          }
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
              fix: moveToHead(
                page.head.sources.streamedInBody,
                "In Next.js these tags come from an async generateMetadata: make it static, or list the crawlers in htmlLimitedBots in next.config, so the server writes them in <head>."
              ),
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
    ({ page, response }, make) => {
      const index = page.head.refresh.findIndex((r) => r.url);
      const redirect = page.head.refresh[index];

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
          fix: serverRedirect(
            page,
            response,
            target,
            page.head.sources.refresh[index]
          ),
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

      const tag = page.markup.charset;

      // A <meta charset="utf-8"> moved first; an http-equiv declaration becomes the short form.
      const code =
        tag && /\scharset\s*=/iu.test(tag) && !/http-equiv/iu.test(tag)
          ? tag
          : `<meta charset="${escapeAttribute(page.charset ?? "utf-8")}">`;

      return make(
        `The charset declaration ends at byte ${end}, past the first ${CHARSET_PRESCAN_BYTES}.`,
        {
          fix: [
            ...(tag ? [removeEdit("html", tag, { at: "head" })] : []),
            addHtml(
              "head",
              code,
              "First in <head>, before any script, style or comment."
            ),
          ],
          selector: "head > meta[charset]",
          evidence: { endsAtByte: end },
        }
      );
    }
  ),
];
