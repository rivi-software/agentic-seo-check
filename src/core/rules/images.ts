import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

const FILENAME_ALT =
  /^(?:img|image|dsc|dscn|dcim|photo|screenshot|screen shot|untitled)[-_ ]?\d*|\.(?:jpe?g|png|gif|webp|avif|svg)$/iu;

export const imageRules = [
  defineRule(
    {
      id: "img.alt-missing",
      category: "images",
      severity: "warning",
      description: "Images without an alt attribute.",
      recommendation:
        'Give every <img> an alt attribute: a short description for meaningful images, alt="" for purely decorative ones. Alt text is used for image search and accessibility.',
      docs: GOOGLE_DOCS.images,
    },
    ({ page }, make) => {
      const missing = page.images.filter((i) => i.alt === null);

      return missing.length
        ? make(
            `${missing.length} of ${page.images.length} images have no alt attribute.`,
            {
              selector: "img:not([alt])",
              evidence: {
                count: missing.length,
                total: page.images.length,
                examples: cap(missing.map((i) => i.src ?? "(no src)")),
              },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "img.alt-filename",
      category: "images",
      severity: "info",
      description:
        "Image alt text looks like a filename (IMG_1234.jpg, screenshot.png).",
      recommendation:
        "Replace filename-style alt text with a description of what the image shows.",
      docs: GOOGLE_DOCS.images,
    },
    ({ page }, make) => {
      const bad = page.images.filter(
        (i) => i.alt && FILENAME_ALT.test(i.alt.trim())
      );

      return bad.length
        ? make(`${bad.length} image(s) have filename-like alt text.`, {
            evidence: {
              examples: cap(bad.map((i) => ({ src: i.src, alt: i.alt }))),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "img.dimensions-missing",
      category: "images",
      severity: "info",
      description:
        "Images without explicit width and height attributes, which causes layout shift (CLS) while they load.",
      recommendation:
        "Add width and height attributes (or CSS aspect-ratio) to <img> elements so the browser can reserve space before the image loads.",
      docs: GOOGLE_DOCS.cwv,
    },
    ({ page }, make) => {
      const missing = page.images.filter(
        (i) => i.src && (!i.width || !i.height)
      );

      return missing.length
        ? make(
            `${missing.length} of ${page.images.length} images lack width/height attributes.`,
            {
              selector: "img:not([width]), img:not([height])",
              evidence: {
                count: missing.length,
                examples: cap(missing.map((i) => i.src)),
              },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "img.src-missing",
      category: "images",
      severity: "info",
      description:
        "Images without a src attribute (usually lazy-loading via data-src without a fallback).",
      recommendation:
        'Use native loading="lazy" with a real src, or ensure the lazy-loader also works without JavaScript, so crawlers can discover the images.',
      docs: GOOGLE_DOCS.images,
    },
    ({ page }, make) => {
      const missing = page.images.filter((i) => !i.src);

      return missing.length
        ? make(`${missing.length} image(s) have no src attribute.`, {
            selector: "img:not([src])",
            evidence: { count: missing.length },
          })
        : null;
    }
  ),
];
