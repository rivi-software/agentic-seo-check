import type { FixEdit, ImageInfo } from "../types.js";
import {
  addHtml,
  escapeAttribute,
  rebuildEdit,
  replaceHtml,
  setAttributeEdit,
  slot,
  withAttribute,
} from "./fix.js";
import { readAttributes, withAttributeSelector } from "./quoted-tags.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** The selector of one image: by its src, unless that is a data: URI or too long to read. */
const imageAt = (image: ImageInfo, fallback: string): string =>
  image.src && !image.src.startsWith("data:") && image.src.length <= 200
    ? withAttributeSelector("img", "src", image.src)
    : fallback;

/** Images with a src but without a width or a height attribute, whose space the browser cannot reserve. */
export const unsizedImages = (images: readonly ImageInfo[]): ImageInfo[] =>
  images.filter((i) => i.src && (!i.width || !i.height));

/** The width and height an image lacks, written into its tag as the page writes it. */
export const sizeEdit = (i: ImageInfo): FixEdit => {
  const at = imageAt(i, "img:not([width]), img:not([height])");
  let code: string | null = i.tag;

  if (!i.width) {
    code = withAttribute(code, "width", slot("width"));
  }

  if (code && !i.height) {
    code = withAttribute(code, "height", slot("height"));
  }

  const write =
    "The image's size in pixels (its intrinsic width and height, or the size it is shown at with the same aspect ratio); CSS can still scale it.";

  return code
    ? replaceHtml(i.tag, code, { at, write })
    : addHtml(
        at,
        [
          i.width ? "" : `width="${slot("width")}"`,
          i.height ? "" : `height="${slot("height")}"`,
        ]
          .filter(Boolean)
          .join(" "),
        write
      );
};

const ALT_WRITE =
  'What the image shows, in a few words, for someone who cannot see it; leave it empty (alt="") when the image is only decoration.';

/** Attributes lazy-loaders keep the image URL in until JavaScript copies it to src. */
const LAZY_SRC = ["data-src", "data-lazy-src", "data-original"];

const FILENAME_ALT =
  /^(?:img|image|dsc|dscn|dcim|photo|screenshot|screen shot|untitled)[-_ ]?\d*|\.(?:jpe?g|png|gif|webp|avif|svg)$/iu;

/**
 * File types an <img src> may name that Google Images does not index: it supports BMP, GIF, JPEG,
 * PNG, WebP, SVG and AVIF. Phones save HEIC, scanners and design tools TIFF or PSD.
 */
const UNSUPPORTED_FORMATS = new Set([
  "heic",
  "heif",
  "tif",
  "tiff",
  "jxl",
  "jp2",
  "psd",
]);

/** Where the file name of an image URL as written ends, before its query or fragment. */
const pathEnd = (src: string): number => {
  const query = src.indexOf("?");
  const hash = src.indexOf("#");
  const ends = [query, hash].filter((i) => i !== -1);

  return ends.length > 0 ? Math.min(...ends) : src.length;
};

/** The extension of an image URL as written, lower-cased, or null when its file name has none. */
const extensionOf = (src: string): string | null => {
  if (src.startsWith("data:")) {
    return null;
  }

  const path = src.slice(0, pathEnd(src));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
};

/** `src` with its extension swapped for `.webp`, query and fragment kept. */
const asWebp = (src: string): string => {
  const end = pathEnd(src);
  const dot = src.lastIndexOf(".", end);

  return `${src.slice(0, dot)}.webp${src.slice(end)}`;
};

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
              fix: missing.map((i) =>
                setAttributeEdit(
                  i.tag,
                  imageAt(i, "img:not([alt])"),
                  "alt",
                  slot("what the image shows"),
                  ALT_WRITE
                )
              ),
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
            fix: bad.map((i) =>
              setAttributeEdit(
                i.tag,
                imageAt(i, withAttributeSelector("img", "alt", i.alt ?? "")),
                "alt",
                slot("what the image shows"),
                `${ALT_WRITE} Not the file name "${(i.alt ?? "").slice(0, 60)}".`
              )
            ),
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
      const missing = unsizedImages(page.images);

      return missing.length
        ? make(
            `${missing.length} of ${page.images.length} images lack width/height attributes.`,
            {
              fix: missing.map(sizeEdit),
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

      // A lazy-loader's URL attribute gives the src exactly; without one, the URL is a slot.
      const fix = missing.map((i) => {
        const attributes = readAttributes(i.tag);

        // The value is quoted as written, character references and all; only a `"` needs escaping.
        const lazy = LAZY_SRC.map((name) => attributes?.get(name)).find(
          Boolean
        );

        const code = lazy
          ? withAttribute(i.tag, "src", lazy.replaceAll('"', "&quot;"))
          : null;

        // No loading="lazy" here: on an image in the first screen, a hero, it would make
        // img.lazy-above-fold fire on the re-check.
        return code
          ? replaceHtml(i.tag, code, {
              at: "img:not([src])",
              write:
                'Add loading="lazy" as well when the image is further down than the first screen.',
            })
          : setAttributeEdit(
              i.tag,
              "img:not([src])",
              "src",
              slot("image URL"),
              'The URL of the image file. If a lazy-loader fills it in with JavaScript, give the <img> its real src and loading="lazy" instead.'
            );
      });

      return missing.length
        ? make(`${missing.length} image(s) have no src attribute.`, {
            fix,
            selector: "img:not([src])",
            evidence: { count: missing.length },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "img.unsupported-format",
      category: "images",
      severity: "info",
      description:
        "Images in a format Google Images does not index (HEIC, HEIF, TIFF, JPEG XL, JPEG 2000, PSD). Most browsers cannot show them either.",
      recommendation:
        "Convert these images to WebP, AVIF, JPEG or PNG, and point the <img src> at the converted file. Google Images indexes BMP, GIF, JPEG, PNG, WebP, SVG and AVIF.",
      docs: GOOGLE_DOCS.images,
    },
    ({ page }, make) => {
      const unsupported = page.images.flatMap((i) => {
        const format = i.src ? extensionOf(i.src) : null;

        return i.src && format && UNSUPPORTED_FORMATS.has(format)
          ? [{ image: i, src: i.src, format }]
          : [];
      });

      if (unsupported.length === 0) {
        return null;
      }

      const fix = unsupported.flatMap(({ image, src, format }) => {
        const webp = asWebp(src);
        let url: string | undefined;

        try {
          url = new URL(src, page.url).href;
        } catch {
          url = undefined;
        }

        return [
          rebuildEdit(
            url,
            "the image as WebP",
            `Convert ${src.slice(0, 120)} from ${format.toUpperCase()} to WebP (or AVIF, JPEG or PNG) and save it as ${webp.slice(0, 120)}.`
          ),
          setAttributeEdit(
            image.tag,
            imageAt(image, "img[src]"),
            "src",
            escapeAttribute(webp)
          ),
        ];
      });

      return make(
        `${unsupported.length} image(s) are in a format Google Images does not index: ${cap(
          unsupported.map((u) => u.src),
          5
        ).join(", ")}.`,
        {
          fix,
          evidence: {
            count: unsupported.length,
            examples: cap(
              unsupported.map(({ src, format }) => ({ src, format }))
            ),
          },
        }
      );
    }
  ),
];
