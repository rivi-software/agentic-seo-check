import type { ExtractedPage, PageSource } from "../types.js";
import { normalizeUrl, resolveUrl } from "../url.js";
import { addHtml, escapeAttribute, setAttributeEdit, slot } from "./fix.js";
import { isSlot, ORIGIN_SLOT_WRITE, productionOrigin } from "./page-fixes.js";
import { defineRule, GOOGLE_DOCS } from "./rule.js";

type OgProperty = (typeof OG_RECOMMENDED)[number];

/** The URL og:url should name: the canonical, or the page itself. */
const pageUrlFor = (page: ExtractedPage, source: PageSource): string => {
  if (page.canonical) {
    return page.canonical;
  }

  const origin = productionOrigin(page, source);

  if (!isSlot(origin)) {
    return page.url;
  }

  try {
    return `${origin}${new URL(page.url).pathname}`;
  } catch {
    return `${origin}/`;
  }
};

/** A tag to add, and what its slot needs when it has one. */
interface TagToAdd {
  code: string;
  write?: string;
}

/**
 * The <meta> tag for one Open Graph property, with the value the page already states elsewhere
 * (its title, description, canonical) or a slot for what only the author knows (the image).
 */
const ogTag = (
  page: ExtractedPage,
  source: PageSource,
  property: OgProperty
): TagToAdd => {
  const meta = (value: string) =>
    `<meta property="og:${property}" content="${value}">`;

  switch (property) {
    case "title": {
      return page.title
        ? { code: meta(escapeAttribute(page.title)) }
        : {
            code: meta(slot("page title")),
            write: "og:title: the page's title as it should read in a share.",
          };
    }

    case "description": {
      return page.metaDescription
        ? { code: meta(escapeAttribute(page.metaDescription)) }
        : {
            code: meta(slot("share description")),
            write:
              "og:description: one or two sentences on what the page offers.",
          };
    }

    case "image": {
      return {
        code: meta(
          `${productionOrigin(page, source)}${slot("/path/to/share-image.jpg")}`
        ),
        write:
          "og:image: the absolute URL of an image for share previews, at least 1200x630 pixels; the origin is the site's production origin.",
      };
    }

    case "url": {
      const url = pageUrlFor(page, source);

      return {
        code: meta(isSlot(url) ? url : escapeAttribute(url)),
        write: isSlot(url) ? ORIGIN_SLOT_WRITE : undefined,
      };
    }

    default: {
      return { code: meta("website") };
    }
  }
};

/** One edit adding the given Open Graph tags to <head>, with what the slots in them need. */
const addOgTags = (
  page: ExtractedPage,
  source: PageSource,
  properties: readonly OgProperty[]
) => {
  const tags = properties.map((p) => ogTag(page, source, p));
  const writes = tags.flatMap((t) => (t.write ? [t.write] : []));

  return addHtml(
    "head",
    tags.map((t) => t.code).join("\n"),
    writes.length > 0
      ? `${writes.join(" ")} og:type is "website"; use "article" for an article.`
      : undefined
  );
};

const OG_CORE = ["title", "description", "image"] as const;

const OG_RECOMMENDED = [
  "title",
  "description",
  "image",
  "url",
  "type",
] as const;

const TWITTER_CARDS = new Set([
  "summary",
  "summary_large_image",
  "app",
  "player",
]);

/** A large image card when the page has an image to show in it, else the small one. */
const cardFor = (page: ExtractedPage): string =>
  page.og["image"] || page.twitter["image"] ? "summary_large_image" : "summary";

export const socialRules = [
  defineRule(
    {
      id: "og.missing",
      category: "social",
      severity: "warning",
      description:
        "No Open Graph tags (og:title, og:description, og:image) are present.",
      recommendation:
        "Add og:title, og:description, og:image (absolute URL, at least 1200x630), og:url and og:type so shares on social platforms and chat apps render a rich preview.",
      docs: GOOGLE_DOCS.og,
    },
    ({ page, source }, make) =>
      OG_CORE.some((k) => page.og[k])
        ? null
        : make("Page has no Open Graph tags.", {
            fix: [addOgTags(page, source, OG_RECOMMENDED)],
            selector: 'head > meta[property^="og:"]',
          })
  ),
  defineRule(
    {
      id: "og.incomplete",
      category: "social",
      severity: "info",
      description:
        "Some Open Graph tags are present but one or more of og:title, og:description, og:image, og:url, og:type is missing.",
      recommendation:
        "Fill in the missing Open Graph properties. og:image and og:description have the biggest effect on share previews.",
      docs: GOOGLE_DOCS.og,
    },
    ({ page, source }, make) => {
      if (!OG_CORE.some((k) => page.og[k])) {
        return null;
      }

      const missing = OG_RECOMMENDED.filter((k) => !page.og[k]);

      return missing.length
        ? make(
            `Open Graph is missing: ${missing.map((m) => `og:${m}`).join(", ")}.`,
            {
              fix: [addOgTags(page, source, missing)],
              selector: 'head > meta[property^="og:"]',
              evidence: { missing, present: Object.keys(page.og) },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "og.image-not-absolute",
      category: "social",
      severity: "warning",
      description: "og:image is not an absolute URL.",
      recommendation:
        "Use a full https:// URL for og:image; most platforms ignore relative image paths.",
      docs: GOOGLE_DOCS.og,
    },
    ({ page, source }, make) => {
      const img = page.og["image"];

      if (!img || /^https?:\/\//iu.test(img)) {
        return null;
      }

      // The path the page meant, on the production origin (a slot when the page is on a dev host).
      const origin = productionOrigin(page, source);
      const resolved = resolveUrl(img, page.url);

      const absolute = isSlot(origin)
        ? `${origin}${resolved ? new URL(resolved).pathname + new URL(resolved).search : `/${img.replace(/^\/+/u, "")}`}`
        : (resolved ?? img);

      const selector = 'head > meta[property="og:image"]';

      return make(`og:image "${img}" is not an absolute URL.`, {
        fix: [
          setAttributeEdit(
            page.markup.social["og:image"] ?? null,
            selector,
            "content",
            isSlot(absolute) ? absolute : escapeAttribute(absolute),
            isSlot(absolute) ? ORIGIN_SLOT_WRITE : undefined
          ),
        ],
        selector,
        evidence: { image: img },
      });
    }
  ),
  defineRule(
    {
      id: "og.url-mismatch",
      category: "social",
      severity: "info",
      description: "og:url differs from the canonical URL.",
      recommendation:
        "Set og:url to the same URL as the canonical so share counts and previews consolidate.",
      docs: GOOGLE_DOCS.og,
    },
    ({ page }, make) => {
      const ogUrl = page.og["url"];

      if (!ogUrl || !page.canonical) {
        return null;
      }

      const a = normalizeUrl(ogUrl);
      const b = normalizeUrl(page.canonical);

      return a && b && a !== b
        ? make("og:url does not match the canonical URL.", {
            fix: [
              setAttributeEdit(
                page.markup.social["og:url"] ?? null,
                'head > meta[property="og:url"]',
                "content",
                escapeAttribute(page.canonical)
              ),
            ],
            selector: 'head > meta[property="og:url"]',
            evidence: { ogUrl, canonical: page.canonical },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "twitter.card-missing",
      category: "social",
      severity: "info",
      description: "No twitter:card meta tag is present.",
      recommendation:
        'Add <meta name="twitter:card" content="summary_large_image">; X/Twitter falls back to Open Graph for the other fields.',
      docs: GOOGLE_DOCS.twitter,
    },
    ({ page }, make) =>
      page.twitter["card"]
        ? null
        : make("Page has no twitter:card tag.", {
            fix: [
              addHtml(
                "head",
                `<meta name="twitter:card" content="${cardFor(page)}">`
              ),
            ],
            selector: 'head > meta[name="twitter:card"]',
          })
  ),
  defineRule(
    {
      id: "twitter.card-invalid",
      category: "social",
      severity: "warning",
      description:
        "twitter:card has a value other than summary, summary_large_image, app or player.",
      recommendation:
        "Use one of the supported card types, usually summary_large_image.",
      docs: GOOGLE_DOCS.twitter,
    },
    ({ page }, make) => {
      const { card } = page.twitter;

      return card && !TWITTER_CARDS.has(card.toLowerCase())
        ? make(`twitter:card "${card}" is not a valid card type.`, {
            fix: [
              setAttributeEdit(
                page.markup.social["twitter:card"] ?? null,
                'head > meta[name="twitter:card"]',
                "content",
                cardFor(page)
              ),
            ],
            selector: 'head > meta[name="twitter:card"]',
            evidence: { card },
          })
        : null;
    }
  ),
];
