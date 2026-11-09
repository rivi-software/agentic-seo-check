import {
  includesKeyword,
  keywordOccurrences,
  normalizeForComparison,
  words,
} from "../html/text.js";
import type { ExtractedPage, FixEdit, PageSource } from "../types.js";
import {
  addHtml,
  replaceHtml,
  setAttributeEdit,
  slot,
  withContent,
} from "./fix.js";
import {
  bestBlock,
  permanentRedirect,
  rewriteBlock,
  statusLine,
} from "./page-fixes.js";
import { defineRule } from "./rule.js";

/** The <title> search engines read rewritten around the keyword, or a new one when the page has none. */
const titleEdit = (page: ExtractedPage, keyword: string): FixEdit => {
  const index = page.title === null ? -1 : page.titles.indexOf(page.title);
  const tag = page.markup.titles[Math.max(index, 0)];
  const content = slot("title with the keyword");

  const write = `A title of 30-60 characters with "${keyword}" (or a close variant) near the start.`;

  return tag === undefined
    ? addHtml("head", `<title>${content}</title>`, write)
    : replaceHtml(
        tag,
        withContent(tag, content) ?? `<title>${content}</title>`,
        {
          at: "head > title",
          write,
        }
      );
};

/** The first <h1>, rewritten around the keyword. */
const h1Edit = (page: ExtractedPage, keyword: string): FixEdit => {
  const index = page.headings.findIndex((h) => h.level === 1);
  const tag = page.markup.headings[index];
  const content = slot("heading with the keyword");
  const write = `The page's main heading, using "${keyword}" the way a visitor would say it.`;

  return tag === undefined
    ? addHtml("main, body", `<h1>${content}</h1>`, write)
    : replaceHtml(tag, withContent(tag, content) ?? `<h1>${content}</h1>`, {
        at: "h1",
        write,
      });
};

/** A path segment for the keyword: lowercase words joined with hyphens. */
const slugOf = (keyword: string): string =>
  words(normalizeForComparison(keyword))
    .join("-")
    .replaceAll(/[^\p{L}\p{N}-]/gu, "");

/**
 * The page moved to a path with the keyword in it. Renaming an indexed URL costs what search
 * engines know about it, so the edit says to do it only for a new page.
 */
const urlEdits = (
  page: ExtractedPage,
  source: PageSource,
  status: number | null,
  keyword: string
): FixEdit[] => {
  let url: URL;

  try {
    url = new URL(page.url);
  } catch {
    return [
      addHtml(
        "body",
        slot("page at a path with the keyword"),
        `Serve the page at a path with "${keyword}" in it, such as /${slugOf(keyword)}/, if it is not indexed yet.`
      ),
    ];
  }

  const segments = url.pathname.split("/");
  const last = segments.findLastIndex(Boolean);
  const slug = slugOf(keyword);

  // The home page keeps "/": the topic gets a page of its own, linked from it.
  if (last === -1) {
    return [
      addHtml(
        "nav, main",
        `<a href="/${slug}/">${slot("link text")}</a>`,
        `A home page's URL stays "/". Give "${keyword}" a page of its own at /${slug}/ and link to it with words a visitor would click.`
      ),
    ];
  }

  segments[last] = slug;
  const moved = new URL(segments.join("/"), url).href;

  return [
    {
      in: "http",
      action: "replace",
      at: "status line",
      current: statusLine(status ?? 200),
      code: permanentRedirect(
        source === "url" ? moved : new URL(moved).pathname
      ),
      write: `Only for a page that is not indexed or linked to yet: serve it at ${new URL(moved).pathname} and redirect the old path there. Leave an indexed URL as it is; a rename resets what search engines know about the page.`,
    },
  ];
};

/**
 * The paragraph that repeats the keyword most, rewritten whole; when no block holds it, new copy,
 * since words cut from the joined page text would not be in the source as written.
 */
const densityFix = (
  page: ExtractedPage,
  keyword: string,
  maxPercent: number
): FixEdit => {
  const block = bestBlock(page.markup.blocks, (b) =>
    keywordOccurrences(b.text, keyword)
  );

  return block
    ? rewriteBlock(
        block,
        "the same paragraph, the keyword fewer times",
        `Write "${keyword}" fewer times: use a synonym, a pronoun or nothing, as a reader would write it. Do the same in other paragraphs until it is under ${maxPercent}% of the words.`
      )
    : addHtml(
        "body",
        slot("copy with fewer repetitions"),
        `Rewrite the copy so "${keyword}" is under ${maxPercent}% of the words.`
      );
};

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
            fix: [titleEdit(page, keyword)],
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
            fix: [h1Edit(page, keyword)],
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
            fix: [
              setAttributeEdit(
                page.markup.metaDescriptions[
                  Math.max(
                    page.metaDescriptions.indexOf(page.metaDescription),
                    0
                  )
                ] ?? null,
                'head > meta[name="description"]',
                "content",
                slot("description with the keyword"),
                `The description (70-160 characters) with "${keyword}" worked in where it reads naturally; search engines bold the words a searcher typed.`
              ),
            ],
            selector: 'head > meta[name="description"]',
            evidence: { description: page.metaDescription, keyword },
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
            fix: [
              addHtml(
                "main p, body p",
                slot("sentence with the keyword"),
                `A sentence in the first paragraph that uses "${keyword}" naturally, as part of what the page says.`
              ),
            ],
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
    ({ page, keyword, source, response }, make) => {
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
            fix: urlEdits(page, source, response?.status ?? null, keyword),
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
              fix: [
                densityFix(page, keyword, thresholds.maxKeywordDensityPercent),
              ],
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
