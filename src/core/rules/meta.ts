import { normalizeForComparison } from "../html/text.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

const SELECTOR = 'head > meta[name="description"]';

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
        : make("Page has no meta description.", { selector: SELECTOR })
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
    ({ page }, make) =>
      page.metaDescriptions.length > 1
        ? make(
            `Page has ${page.metaDescriptions.length} meta description tags.`,
            {
              selector: SELECTOR,
              evidence: { descriptions: page.metaDescriptions },
            }
          )
        : null
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
            selector: SELECTOR,
            evidence: {
              title: page.title,
              description: page.metaDescription,
            },
          })
        : null
  ),
];
