import { isGenericTitle } from "../html/text.js";
import type { ExtractedPage, FixEdit } from "../types.js";
import { addHtml, removeHtml, replaceHtml, slot, withContent } from "./fix.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

const AT = "head > title";

/** The <title> element search engines read: the first one with text. */
const titleIndex = (page: ExtractedPage): number =>
  page.title === null ? -1 : page.titles.indexOf(page.title);

/** The edit that gives the page's title `content`: rewrites the <title> it has, or adds one. */
const writeTitle = (
  page: ExtractedPage,
  content: string,
  write: string
): FixEdit => {
  const index = Math.max(titleIndex(page), 0);
  const current = page.markup.titles[index];

  if (current === undefined) {
    return addHtml("head", `<title>${content}</title>`, write);
  }

  return replaceHtml(
    current,
    withContent(current, content) ?? `<title>${content}</title>`,
    { at: AT, write }
  );
};

export const titleRules = [
  defineRule(
    {
      id: "title.missing",
      category: "title",
      severity: "error",
      description: "The page has no <title> element or it is empty.",
      recommendation:
        "Add a unique, descriptive <title> in <head> (about 30-60 characters) that states what the page is about.",
      docs: GOOGLE_DOCS.titles,
    },
    ({ page }, make) =>
      page.title
        ? null
        : make("Page has no <title> or the title is empty.", {
            fix: [
              writeTitle(
                page,
                slot("page title"),
                "What this page is about in 30-60 characters, the most specific words first, then the site name if it fits."
              ),
            ],
            selector: "head > title",
          })
  ),
  defineRule(
    {
      id: "title.multiple",
      category: "title",
      severity: "warning",
      description: "More than one <title> element is present.",
      recommendation:
        "Keep exactly one <title>. Browsers and crawlers may pick different ones when several exist.",
      docs: GOOGLE_DOCS.titles,
    },
    ({ page }, make) => {
      if (page.titles.length <= 1) {
        return null;
      }

      // Keep the title search engines read now; remove the others.
      const keep = Math.max(titleIndex(page), 0);

      return make(`Page has ${page.titles.length} <title> elements.`, {
        fix: page.markup.titles.flatMap((tag, i) =>
          i === keep ? [] : [removeHtml(tag, "title")]
        ),
        selector: "title",
        evidence: { titles: page.titles },
      });
    }
  ),
  defineRule(
    {
      id: "title.too-long",
      category: "title",
      severity: "warning",
      description:
        "Title is longer than the configured maximum (default 60 characters) and will be truncated in search results.",
      recommendation:
        "Shorten the title to roughly 60 characters or fewer, keeping the most important words first.",
      docs: GOOGLE_DOCS.titles,
    },
    ({ page, thresholds }, make) =>
      page.title && page.title.length > thresholds.titleMaxChars
        ? make(
            `Title is ${page.title.length} characters (max ${thresholds.titleMaxChars}).`,
            {
              fix: [
                writeTitle(
                  page,
                  slot("shorter title"),
                  `The current title in at most ${thresholds.titleMaxChars} characters: keep the words that say what the page is, drop filler and repeated site names.`
                ),
              ],
              selector: "head > title",
              evidence: {
                title: page.title,
                length: page.title.length,
                max: thresholds.titleMaxChars,
              },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "title.too-short",
      category: "title",
      severity: "info",
      description:
        "Title is shorter than the configured minimum (default 30 characters).",
      recommendation:
        "Consider a more descriptive title that includes the page topic and, where sensible, the brand.",
      docs: GOOGLE_DOCS.titles,
    },
    ({ page, thresholds }, make) =>
      page.title && page.title.length < thresholds.titleMinChars
        ? make(
            `Title is only ${page.title.length} characters (recommended at least ${thresholds.titleMinChars}).`,
            {
              fix: [
                writeTitle(
                  page,
                  slot("longer title"),
                  `The current title grown to ${thresholds.titleMinChars}-${thresholds.titleMaxChars} characters with what the page offers: a product type, a place, the site name.`
                ),
              ],
              selector: "head > title",
              evidence: {
                title: page.title,
                length: page.title.length,
                min: thresholds.titleMinChars,
              },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "title.generic",
      category: "title",
      severity: "warning",
      description:
        'Title is a framework default or placeholder such as "React App", "Create Next App", "Home" or "Untitled".',
      recommendation:
        "Replace the placeholder with a title that describes this page. In frameworks, set it per route (metadata export, <Head>, useHead, <svelte:head>, etc.).",
      docs: GOOGLE_DOCS.titles,
    },
    ({ page }, make) =>
      page.title && isGenericTitle(page.title)
        ? make(
            `Title "${page.title}" looks like a placeholder or framework default.`,
            {
              fix: [
                writeTitle(
                  page,
                  slot("page title"),
                  "A title for this page in 30-60 characters. In a framework, set it per route (metadata export, <Head>, useHead, <svelte:head>) rather than in the shared index.html."
                ),
              ],
              selector: "head > title",
              evidence: { title: page.title },
            }
          )
        : null
  ),
];
