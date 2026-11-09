import { normalizeForComparison } from "../html/text.js";
import type { ExtractedPage, FixEdit } from "../types.js";
import { addHtml, removeHtml, setAttributeEdit, slot } from "./fix.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

const SELECTOR = 'head > meta[name="description"]';

/** The meta description search engines read: the first one with text. */
const descriptionIndex = (page: ExtractedPage): number =>
  page.metaDescription === null
    ? -1
    : page.metaDescriptions.indexOf(page.metaDescription);

/** The edit that sets the page's meta description: rewrites the tag it has, or adds one. */
const writeDescription = (
  page: ExtractedPage,
  hint: string,
  write: string
): FixEdit => {
  const tag = page.markup.metaDescriptions[Math.max(descriptionIndex(page), 0)];

  return tag === undefined
    ? addHtml(
        "head",
        `<meta name="description" content="${slot(hint)}">`,
        write
      )
    : setAttributeEdit(tag, SELECTOR, "content", slot(hint), write);
};

const DESCRIBE =
  "A summary of this page in 70-160 characters that tells a searcher what they get by clicking.";

export const metaRules = [
  defineRule(
    {
      id: "meta-description.missing",
      category: "meta",
      severity: "warning",
      description: 'No <meta name="description"> is present or it is empty.',
      recommendation:
        "Add a unique meta description (about 70-160 characters) that summarises the page and invites the click. Search engines may show it as the snippet.",
      docs: GOOGLE_DOCS.snippets,
    },
    ({ page }, make) =>
      page.metaDescription
        ? null
        : make("Page has no meta description.", {
            fix: [writeDescription(page, "page description", DESCRIBE)],
            selector: SELECTOR,
          })
  ),
  defineRule(
    {
      id: "meta-description.multiple",
      category: "meta",
      severity: "warning",
      description: "More than one meta description is present.",
      recommendation:
        "Keep a single meta description; remove or merge the others.",
      docs: GOOGLE_DOCS.snippets,
    },
    ({ page }, make) => {
      if (page.metaDescriptions.length <= 1) {
        return null;
      }

      // Keep the description search engines read now; remove the others.
      const keep = Math.max(descriptionIndex(page), 0);

      return make(
        `Page has ${page.metaDescriptions.length} meta description tags.`,
        {
          fix: page.markup.metaDescriptions.flatMap((tag, i) =>
            i === keep ? [] : [removeHtml(tag, SELECTOR)]
          ),
          selector: SELECTOR,
          evidence: { descriptions: page.metaDescriptions },
        }
      );
    }
  ),
  defineRule(
    {
      id: "meta-description.too-long",
      category: "meta",
      severity: "warning",
      description:
        "Meta description exceeds the configured maximum (default 160 characters) and will be truncated.",
      recommendation:
        "Trim the description to about 160 characters, front-loading the key message.",
      docs: GOOGLE_DOCS.snippets,
    },
    ({ page, thresholds }, make) =>
      page.metaDescription &&
      page.metaDescription.length > thresholds.descriptionMaxChars
        ? make(
            `Meta description is ${page.metaDescription.length} characters (max ${thresholds.descriptionMaxChars}).`,
            {
              fix: [
                writeDescription(
                  page,
                  "shorter description",
                  `The current description in at most ${thresholds.descriptionMaxChars} characters, the key message first.`
                ),
              ],
              selector: SELECTOR,
              evidence: {
                description: page.metaDescription,
                length: page.metaDescription.length,
                max: thresholds.descriptionMaxChars,
              },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "meta-description.too-short",
      category: "meta",
      severity: "info",
      description:
        "Meta description is shorter than the configured minimum (default 70 characters).",
      recommendation:
        "Expand the description so it summarises the page content and its value to the visitor.",
      docs: GOOGLE_DOCS.snippets,
    },
    ({ page, thresholds }, make) =>
      page.metaDescription &&
      page.metaDescription.length < thresholds.descriptionMinChars
        ? make(
            `Meta description is only ${page.metaDescription.length} characters (recommended at least ${thresholds.descriptionMinChars}).`,
            {
              fix: [
                writeDescription(
                  page,
                  "longer description",
                  `The current description grown to ${thresholds.descriptionMinChars}-${thresholds.descriptionMaxChars} characters with what the page offers and why it is worth the click.`
                ),
              ],
              selector: SELECTOR,
              evidence: {
                description: page.metaDescription,
                length: page.metaDescription.length,
                min: thresholds.descriptionMinChars,
              },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "meta-description.same-as-title",
      category: "meta",
      severity: "info",
      description: "Meta description is identical to the title.",
      recommendation:
        "Write a description that adds information beyond the title instead of repeating it.",
      docs: GOOGLE_DOCS.snippets,
    },
    ({ page }, make) =>
      page.metaDescription &&
      page.title &&
      normalizeForComparison(page.metaDescription) ===
        normalizeForComparison(page.title)
        ? make("Meta description repeats the title verbatim.", {
            fix: [
              writeDescription(
                page,
                "page description",
                "A description that adds to the title: what the page covers or offers, in 70-160 characters."
              ),
            ],
            selector: SELECTOR,
            evidence: {
              title: page.title,
              description: page.metaDescription,
            },
          })
        : null
  ),
];
