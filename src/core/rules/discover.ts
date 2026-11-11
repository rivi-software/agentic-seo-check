/**
 * Google Discover shows a page with a large image only when the page allows it. The rule lives
 * outside indexing.ts because the AEO helpers it reads import indexing.ts.
 */
import {
  directivesFor,
  hasNoindex,
  isArticleType,
  typedNodes,
} from "../aeo/page.js";
import { isJsonObject, typesOf } from "../html/structured-data.js";
import type { JsonValue } from "../html/structured-data.js";
import type { ExtractedPage } from "../types.js";
import { addHtml, setAttributeEdit } from "./fix.js";
import { readAttributes } from "./quoted-tags.js";
import { defineRule } from "./rule.js";

/** Whether a structured data value is, or lists, an object of an article type. */
const holdsArticle = (value: JsonValue | undefined): boolean =>
  (Array.isArray(value) ? value : [value]).some(
    (v) => isJsonObject(v) && typesOf(v["@type"]).some(isArticleType)
  );

/**
 * A page Google Discover would show with an image: an article by og:type, or by its own structured
 * data, an article item or a page whose mainEntity is one. A home page or a listing that only links
 * articles, in an ItemList say, is no article.
 */
const isArticlePage = (page: ExtractedPage): boolean =>
  page.og["type"]?.trim().toLowerCase() === "article" ||
  typedNodes(page.structuredData).some(
    ({ types, node, topLevel }) =>
      topLevel &&
      (types.some(isArticleType) || holdsArticle(node["mainEntity"]))
  );

/** An AMP page, which Google Discover shows with a large image without max-image-preview. */
const isAmp = (page: ExtractedPage): boolean => {
  const attributes = page.markup.html ? readAttributes(page.markup.html) : null;

  return Boolean(attributes?.has("amp") || attributes?.has("⚡"));
};

export const discoverRules = [
  defineRule(
    {
      id: "robots.max-image-preview-missing",
      category: "indexing",
      severity: "info",
      description:
        "An article page sets no max-image-preview, so Google Discover shows it with a small thumbnail instead of a large image.",
      recommendation:
        'Add max-image-preview:large to the page\'s robots meta tag (<meta name="robots" content="max-image-preview:large">), and give it an image at least 1200 pixels wide. Google Discover shows large images only to pages that allow them, or to AMP pages.',
      docs: "https://developers.google.com/search/docs/appearance/google-discover",
    },
    ({ page, response }, make) => {
      const directives = directivesFor("google", page, response);

      if (
        !isArticlePage(page) ||
        hasNoindex(directives) ||
        directives.some((d) => d.startsWith("max-image-preview")) ||
        isAmp(page)
      ) {
        return null;
      }

      const write =
        "Allows Google to show a large image of the page in Discover and in search results; it changes nothing else.";

      // Add to the page's robots meta tag when it has one with a value; else add one.
      const tag = page.markup.metaRobots.find((t) => {
        const attributes = readAttributes(t);

        return (
          attributes?.get("name")?.trim().toLowerCase() === "robots" &&
          (attributes.get("content") ?? "").trim() !== ""
        );
      });

      const content = tag ? readAttributes(tag)?.get("content")?.trim() : null;

      return make(
        "This article sets no max-image-preview, so Google Discover shows it with a small thumbnail.",
        {
          fix: [
            tag && content
              ? setAttributeEdit(
                  tag,
                  'meta[name="robots"]',
                  "content",
                  `${content}, max-image-preview:large`,
                  write
                )
              : addHtml(
                  "head",
                  '<meta name="robots" content="max-image-preview:large">',
                  write
                ),
          ],
          selector: 'head > meta[name="robots"]',
        }
      );
    }
  ),
];
