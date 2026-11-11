import {
  fillerIn,
  fleschReadingEase,
  isPlaceholderPassage,
} from "../html/text.js";
import type { ExtractedPage, FixEdit, TextBlock } from "../types.js";
import { addHtml, replaceHtml, slot } from "./fix.js";
import { bestBlock, rewriteBlock, sentences } from "./page-fixes.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

/** Where new body copy goes: the page's main content, or the body when it marks none. */
const CONTENT_AT = "main, article, body";

/** Words in a sentence, for picking the hardest one to read. */
const wordsIn = (sentence: string): number =>
  sentence.split(/\s+/u).filter(Boolean).length;

/** Words in the longest sentence of a block; 0 for one with no full sentence, such as a menu item. */
const longestIn = (text: string): number => {
  // A loop, not Math.max(...): a long block can hold more sentences than a call takes arguments.
  let most = 0;

  for (const sentence of sentences(text)) {
    most = Math.max(most, wordsIn(sentence));
  }

  return most;
};

const PLACEHOLDER_WRITE =
  "The text this part of the page was designed for (remove the element if it has none yet). Search the templates for other placeholder passages too.";

const READABILITY_WRITE =
  "This paragraph, which holds the page's longest sentence, rewritten in sentences of about 15-20 words with common words. Rewrite the page's other long sentences the same way, aiming for a Flesch score of 50-70.";

/** The filler, or "Lorem ipsum", as the page writes it, with its capitals. */
const placeholderQuote = (text: string): string =>
  fillerIn(text) ?? /lorem\s+ipsum/iu.exec(text)?.[0] ?? "Lorem ipsum";

/** The page holds filler copy, or a passage that opens with "Lorem ipsum". */
const hasPlaceholder = (page: ExtractedPage): boolean =>
  fillerIn(page.text) !== undefined ||
  page.markup.blocks.some((b) => isPlaceholderPassage(b.text)) ||
  page.headings.some((h) => isPlaceholderPassage(h.text));

/**
 * Each block that holds placeholder text, rewritten whole; when none does (the text sits straight
 * in a <div>, or in a heading), the placeholder words themselves.
 */
const placeholderFix = (blocks: TextBlock[], text: string) => {
  const found = blocks.filter((b) => isPlaceholderPassage(b.text));

  return found.length
    ? found.map((b) => rewriteBlock(b, "real copy", PLACEHOLDER_WRITE))
    : [
        replaceHtml(placeholderQuote(text), slot("real copy"), {
          at: "body",
          write: PLACEHOLDER_WRITE,
        }),
      ];
};

/**
 * The paragraph with the page's longest sentence, rewritten whole. A page whose blocks hold no full
 * sentence (its text is menus and labels) gets new copy instead: words cut from the joined page
 * text would not be in the source as written.
 */
const readabilityFix = (page: ExtractedPage): FixEdit => {
  const block = bestBlock(page.markup.blocks, (b) => longestIn(b.text));

  return block
    ? rewriteBlock(
        block,
        "the same text in shorter sentences",
        READABILITY_WRITE
      )
    : addHtml(
        CONTENT_AT,
        slot("shorter sentences"),
        "Rewrite the copy in shorter sentences with common words, aiming for a Flesch score of 50-70."
      );
};

export const contentRules = [
  defineRule(
    {
      id: "content.empty",
      category: "content",
      severity: "warning",
      description: "The HTML contains no visible text.",
      recommendation:
        "If the page is rendered client-side, use server-side rendering or static generation so the HTML carries the content. Re-run with render enabled to compare the rendered DOM.",
      docs: GOOGLE_DOCS.javascript,
    },
    ({ page }, make) =>
      page.wordCount === 0
        ? make("Page body has no visible text in the HTML response.", {
            fix: [
              addHtml(
                "body",
                `<main>\n  <h1>${slot("page heading")}</h1>\n  <p>${slot("page content")}</p>\n</main>`,
                "The page's heading and content, rendered on the server: with server-side rendering or static generation (or prerendering this route) the HTML response carries the text the JavaScript now builds in the browser."
              ),
            ],
          })
        : null
  ),
  defineRule(
    {
      id: "content.thin",
      category: "content",
      severity: "warning",
      description:
        "The page has very little text (default: fewer than 300 words).",
      recommendation:
        "Add substantive, useful content, or set noindex if the page is a utility page (login, cart, thank-you). Thin pages rarely rank and can drag down site quality signals.",
    },
    ({ page, thresholds }, make) =>
      page.wordCount > 0 && page.wordCount < thresholds.thinContentWords
        ? make(
            `Page has only ${page.wordCount} words of visible text (threshold ${thresholds.thinContentWords}).`,
            {
              // Adding useful text cannot hurt; noindex would drop the page from search, so it is
              // left to the author for utility pages.
              fix: [
                addHtml(
                  CONTENT_AT,
                  `<p>${slot("more content")}</p>`,
                  `About ${thresholds.thinContentWords - page.wordCount} more words that answer what a visitor comes to this page for: details, examples, answers to common questions. If this is a utility page (login, cart, thank-you), add <meta name="robots" content="noindex"> instead.`
                ),
              ],
              evidence: {
                wordCount: page.wordCount,
                threshold: thresholds.thinContentWords,
              },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "content.placeholder-text",
      category: "content",
      severity: "error",
      description: 'Placeholder text ("lorem ipsum") is present in the page.',
      recommendation:
        "Replace the placeholder copy with real content before publishing.",
    },
    ({ page }, make) =>
      hasPlaceholder(page)
        ? make('Page contains "lorem ipsum" placeholder text.', {
            fix: placeholderFix(page.markup.blocks, page.text),
          })
        : null
  ),
  defineRule(
    {
      id: "content.readability-low",
      category: "content",
      severity: "info",
      description:
        "Flesch Reading Ease below 30 (very difficult). Only evaluated for English or unspecified language, 100+ words.",
      recommendation:
        "Shorten sentences and prefer common words. Aim for a Flesch score of 50-70 for general audiences.",
    },
    ({ page }, make) => {
      if (page.lang && !page.lang.toLowerCase().startsWith("en")) {
        return null;
      }

      const score = fleschReadingEase(page.text);

      if (score === null || score >= 30) {
        return null;
      }

      return make(`Flesch Reading Ease is ${score} (very difficult).`, {
        fix: [readabilityFix(page)],
        evidence: { fleschReadingEase: score, wordCount: page.wordCount },
      });
    }
  ),
];
