import type { ExtractedPage } from "../types.js";
import { addHtml, escapeAttribute, setAttributeEdit, slot } from "./fix.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

const BCP47 = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/u;

const VIEWPORT = 'head > meta[name="viewport"]';

const VIEWPORT_CODE =
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** What the page itself says about its language, for the agent to confirm. */
const languageHint = (page: ExtractedPage): string => {
  const { locale } = page.og;

  return locale ? ` The page's og:locale is "${locale.slice(0, 20)}".` : "";
};

/**
 * The viewport content without what blocks zooming (user-scalable=no or 0, maximum-scale=1), or
 * the standard viewport when nothing else is left.
 */
const zoomableViewport = (content: string): string => {
  const kept = content
    .split(/[,;]/u)
    .map((part) => part.trim())
    .filter((part) => {
      const v = part.toLowerCase().replaceAll(/\s/gu, "");

      return (
        part !== "" &&
        !/^user-scalable=(?:no|0)$/u.test(v) &&
        !/^maximum-scale=1(?:\.0*)?$/u.test(v)
      );
    });

  return kept.length > 0
    ? kept.join(", ")
    : "width=device-width, initial-scale=1";
};

export const documentRules = [
  defineRule(
    {
      id: "html.lang-missing",
      category: "document",
      severity: "warning",
      description: "The <html> element has no lang attribute.",
      recommendation:
        'Set <html lang="xx"> (for example "en", "nl", "en-GB") so search engines and screen readers know the content language.',
    },
    ({ page }, make) =>
      page.lang
        ? null
        : make("<html> has no lang attribute.", {
            fix: [
              setAttributeEdit(
                page.markup.html,
                "html",
                "lang",
                slot("language code"),
                `The language the page is written in, as a BCP 47 tag: en, nl, en-GB.${languageHint(page)}`
              ),
            ],
            selector: "html",
          })
  ),
  defineRule(
    {
      id: "html.lang-invalid",
      category: "document",
      severity: "warning",
      description: "The <html lang> value is not a valid BCP 47 language tag.",
      recommendation: 'Use a BCP 47 tag such as "en", "en-US" or "pt-BR".',
    },
    ({ page }, make) => {
      if (!page.lang || BCP47.test(page.lang)) {
        return null;
      }

      // "en_US" is a locale written with an underscore; the tag is the same with a hyphen.
      const hyphenated = page.lang.replaceAll("_", "-");
      const exact = BCP47.test(hyphenated);

      return make(`<html lang="${page.lang}"> is not a valid language tag.`, {
        fix: [
          setAttributeEdit(
            page.markup.html,
            "html",
            "lang",
            exact ? escapeAttribute(hyphenated) : slot("language code"),
            exact
              ? undefined
              : `The language the page is written in, as a BCP 47 tag such as en, en-US or pt-BR, instead of "${page.lang.slice(0, 40)}".${languageHint(page)}`
          ),
        ],
        selector: "html",
        evidence: { lang: page.lang },
      });
    }
  ),
  defineRule(
    {
      id: "viewport.missing",
      category: "document",
      severity: "warning",
      description:
        'No <meta name="viewport"> is present, so the page is not mobile-friendly.',
      recommendation:
        'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>. Google indexes the mobile version of pages first.',
      docs: GOOGLE_DOCS.mobile,
    },
    ({ page }, make) =>
      page.viewport
        ? null
        : make("Page has no viewport meta tag.", {
            // An empty viewport tag gets its content; with none, the tag goes into <head>.
            fix: [
              page.markup.viewport
                ? setAttributeEdit(
                    page.markup.viewport,
                    VIEWPORT,
                    "content",
                    "width=device-width, initial-scale=1"
                  )
                : addHtml("head", VIEWPORT_CODE),
            ],
            selector: VIEWPORT,
          })
  ),
  defineRule(
    {
      id: "viewport.not-scalable",
      category: "document",
      severity: "info",
      description:
        "The viewport disables user zoom (user-scalable=no or maximum-scale=1).",
      recommendation:
        "Remove user-scalable=no and maximum-scale limits; blocking zoom is an accessibility problem flagged by Lighthouse.",
    },
    ({ page }, make) => {
      const v = (page.viewport ?? "").toLowerCase().replaceAll(/\s/gu, "");

      return /user-scalable=(?:no|0)/u.test(v) ||
        /maximum-scale=1(?:\.0*)?(?:,|$)/u.test(v)
        ? make("Viewport prevents users from zooming.", {
            fix: [
              page.markup.viewport
                ? setAttributeEdit(
                    page.markup.viewport,
                    VIEWPORT,
                    "content",
                    escapeAttribute(zoomableViewport(page.viewport ?? ""))
                  )
                : addHtml("head", VIEWPORT_CODE),
            ],
            selector: VIEWPORT,
            evidence: { viewport: page.viewport },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "charset.missing",
      category: "document",
      severity: "info",
      description:
        "No character encoding is declared, in the HTML or in the Content-Type header.",
      recommendation:
        'Add <meta charset="utf-8"> as the first element in <head>.',
    },
    // The HTML spec asks for <meta charset> only when Content-Type carries no charset.
    ({ page, response }, make) =>
      page.charset || /charset=/iu.test(response?.contentType ?? "")
        ? null
        : make("No <meta charset> declaration found.", {
            fix: [
              addHtml(
                "head",
                '<meta charset="utf-8">',
                "First in <head>, before any script, style or comment. If the file is saved in another encoding, save it as UTF-8 (or name that encoding)."
              ),
            ],
            selector: "head > meta[charset]",
          })
  ),
  defineRule(
    {
      id: "doctype.missing",
      category: "document",
      severity: "info",
      description: "The document does not start with <!DOCTYPE html>.",
      recommendation:
        "Start the document with <!DOCTYPE html> to avoid quirks-mode rendering.",
    },
    ({ page }, make) =>
      page.hasDoctype
        ? null
        : make("Document has no HTML5 doctype.", {
            fix: [
              addHtml(
                "document start",
                "<!doctype html>",
                "As the very first line of the document, before <html>."
              ),
            ],
          })
  ),
  defineRule(
    {
      id: "document.html-too-large",
      category: "document",
      severity: "info",
      description: "The HTML document is larger than 1.5 MB.",
      recommendation:
        "Reduce inline scripts/styles/data (large JSON state, inline SVG sprites). Very large documents slow parsing and may be truncated by crawlers.",
    },
    ({ page }, make) =>
      page.htmlBytes > 1_500_000
        ? make(`HTML is ${(page.htmlBytes / 1_000_000).toFixed(1)} MB.`, {
            fix: [
              addHtml(
                "body",
                `<script src="${slot("/assets/moved-inline-script.js")}" defer></script>`,
                "Move the largest inline block out of the HTML into a file the page loads: inline JavaScript or JSON state into a script file (or fetch the data), an inline SVG sprite into an .svg file used with <use href>, inline CSS into a stylesheet. Write that file's path in the slot, and remove the inline block."
              ),
            ],
            evidence: { bytes: page.htmlBytes },
          })
        : null
  ),
];
