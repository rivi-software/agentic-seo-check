import { fleschReadingEase, hasPlaceholderText } from "../html/text.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

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
        ? make("Page body has no visible text in the HTML response.")
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
      hasPlaceholderText(page.text)
        ? make('Page contains "lorem ipsum" placeholder text.')
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

      return score !== null && score < 30
        ? make(`Flesch Reading Ease is ${score} (very difficult).`, {
            evidence: { fleschReadingEase: score, wordCount: page.wordCount },
          })
        : null;
    }
  ),
];
