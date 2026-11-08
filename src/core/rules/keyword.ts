import {
  includesKeyword,
  keywordOccurrences,
  normalizeForComparison,
  words,
} from "../html/text.js";
import { defineRule } from "./rule.js";

export const keywordRules = [
  defineRule(
    {
      id: "keyword.not-in-title",
      category: "keyword",
      severity: "warning",
      description: "The target keyword does not appear in the title.",
      recommendation:
        "Include the target keyword (or a close variant) near the start of the title.",
      requires: "keyword",
    },
    ({ page, keyword }, make) =>
      keyword && !includesKeyword(page.title, keyword)
        ? make(`Title does not contain "${keyword}".`, {
            selector: "head > title",
            evidence: { title: page.title, keyword },
          })
        : null
  ),
  defineRule(
    {
      id: "keyword.not-in-h1",
      category: "keyword",
      severity: "warning",
      description: "The target keyword does not appear in any H1.",
      recommendation:
        "Use the target keyword in the H1 so the main heading matches the search intent.",
      requires: "keyword",
    },
    ({ page, keyword }, make) =>
      keyword &&
      page.h1s.length > 0 &&
      !page.h1s.some((h) => includesKeyword(h, keyword))
        ? make(`No <h1> contains "${keyword}".`, {
            selector: "h1",
            evidence: { h1s: page.h1s, keyword },
          })
        : null
  ),
  defineRule(
    {
      id: "keyword.not-in-description",
      category: "keyword",
      severity: "info",
      description:
        "The target keyword does not appear in the meta description.",
      recommendation:
        "Mention the keyword in the meta description; matching terms are bolded in search snippets.",
      requires: "keyword",
    },
    ({ page, keyword }, make) =>
      keyword &&
      page.metaDescription &&
      !includesKeyword(page.metaDescription, keyword)
        ? make(`Meta description does not contain "${keyword}".`, {
            selector: 'head > meta[name="description"]',
            evidence: { keyword },
          })
        : null
  ),
  defineRule(
    {
      id: "keyword.not-in-body",
      category: "keyword",
      severity: "warning",
      description:
        "The target keyword does not appear in the visible body text.",
      recommendation:
        "Use the keyword naturally in the body copy, ideally in the first paragraph.",
      requires: "keyword",
    },
    ({ page, keyword }, make) =>
      keyword &&
      page.wordCount > 0 &&
      keywordOccurrences(page.text, keyword) === 0
        ? make(`Body text does not contain "${keyword}".`, {
            evidence: { keyword, wordCount: page.wordCount },
          })
        : null
  ),
  defineRule(
    {
      id: "keyword.not-in-url",
      category: "keyword",
      severity: "info",
      description: "The target keyword does not appear in the URL path.",
      recommendation:
        "Where the URL is still changeable, use a short slug containing the keyword (hyphen-separated).",
      requires: "keyword",
    },
    ({ page, keyword, source }, make) => {
      if (!keyword || source === "html") {
        return null;
      }

      let pathname = page.url;

      try {
        pathname = decodeURIComponent(new URL(page.url).pathname);
      } catch {
        /* keep */
      }

      const slug = pathname.replaceAll(/[-_/.+]+/gu, " ");

      return includesKeyword(slug, keyword)
        ? null
        : make(`URL path does not contain "${keyword}".`, {
            evidence: { path: pathname, keyword },
          });
    }
  ),
  defineRule(
    {
      id: "keyword.density-high",
      category: "keyword",
      severity: "info",
      description:
        "The target keyword makes up an unusually large share of the body text (default > 3%).",
      recommendation:
        "Reduce repetition; write for readers and use synonyms. Keyword stuffing can trigger spam filters.",
      requires: "keyword",
    },
    ({ page, keyword, thresholds }, make) => {
      if (!keyword || page.wordCount < 50) {
        return null;
      }

      const occurrences = keywordOccurrences(page.text, keyword);
      const kwWords = words(normalizeForComparison(keyword)).length || 1;
      const density = ((occurrences * kwWords) / page.wordCount) * 100;

      return density > thresholds.maxKeywordDensityPercent
        ? make(
            `Keyword density is ${density.toFixed(1)}% (${occurrences} occurrences in ${page.wordCount} words).`,
            {
              evidence: {
                occurrences,
                wordCount: page.wordCount,
                densityPercent: Number(density.toFixed(2)),
              },
            }
          )
        : null;
    }
  ),
];
