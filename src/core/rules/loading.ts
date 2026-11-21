import { isHomePage } from "../aeo/page.js";
import { seesContentEncoding } from "../fetch.js";
import type { ExtractedPage, FixEdit, ImageInfo } from "../types.js";
import { isLocalHost } from "./canonical.js";
import {
  addEdit,
  addHtml,
  escapeAttribute,
  replaceHtml,
  setAttributeEdit,
  slot,
  withAttribute,
  withoutAttribute,
} from "./fix.js";
import { cap, defineRule } from "./rule.js";

/** A selector for an image by its src, for an edit that cannot quote the tag. */
const imageAt = (image: ImageInfo): string =>
  image.src ? `img[src="${image.src.replaceAll('"', String.raw`\"`)}"]` : "img";

/**
 * The edit that takes loading="lazy" off an image and, for the main image, asks the browser to
 * fetch it first.
 */
export const eagerEdit = (image: ImageInfo, priority: boolean): FixEdit => {
  const withoutLazy = withoutAttribute(image.tag, "loading");

  const rewritten =
    withoutLazy && priority
      ? withAttribute(withoutLazy, "fetchpriority", "high")
      : withoutLazy;

  if (rewritten) {
    return replaceHtml(image.tag, rewritten, { at: imageAt(image) });
  }

  return addHtml(
    imageAt(image),
    priority ? 'fetchpriority="high"' : 'loading="eager"',
    priority
      ? 'Set this attribute and delete loading="lazy" from the image.'
      : 'This replaces loading="lazy" on the image.'
  );
};

/** Below this size compression saves less than the request costs (Lighthouse's own cut-off). */
const MIN_COMPRESSIBLE_BYTES = 1400;

/** An image shown before this many words of text is likely in the first screen. */
const ABOVE_FOLD_WORDS = 100;

/** An image at least this wide (by its width attribute) in the first screen is likely its largest element. */
const HERO_MIN_WIDTH = 400;

/** Images narrower than this (by their width attribute) gain little from other sizes. */
const SRCSET_MIN_WIDTH = 640;

/** A width or height attribute in pixels; pages also write "800px", which browsers read as 800. */
const pixels = (value: string | null): number | null => {
  const digits =
    value === null ? undefined : /^\s*\d+(?:\.\d+)?/u.exec(value)?.[0];

  return digits === undefined ? null : Number(digits);
};

/** Icons, logos, spacers and tracking pixels: not the image a visitor waits for. */
const isSmall = (image: ImageInfo): boolean => {
  const width = pixels(image.width);
  const height = pixels(image.height);

  return (width !== null && width < 200) || (height !== null && height < 100);
};

/** A vector file: in the first screen it is nearly always a logo or an icon. */
const isVector = (src: string): boolean =>
  /\.svg(?:[?#]|$)/iu.test(src) || /^data:image\/svg/iu.test(src);

const isLazy = (image: ImageInfo): boolean =>
  image.loading?.trim().toLowerCase() === "lazy";

/**
 * The first large image of the page when it is likely the Largest Contentful Paint and nothing asks
 * the browser to fetch it first: in the first screen, not lazy (img.lazy-above-fold covers that),
 * with no fetchpriority of its own, and no other image the author marked high. Large by its width
 * attribute or its srcset, so a logo without dimensions is never taken for it.
 */
const unprioritizedHero = (page: ExtractedPage): ImageInfo | null => {
  if (
    page.images.some((i) => i.fetchpriority?.trim().toLowerCase() === "high")
  ) {
    return null;
  }

  const first = page.images.find(
    (i) => i.src && i.wordsBefore !== null && !isVector(i.src) && !isSmall(i)
  );

  if (
    !first ||
    first.wordsBefore === null ||
    first.wordsBefore >= ABOVE_FOLD_WORDS ||
    isLazy(first) ||
    first.fetchpriority !== null
  ) {
    return null;
  }

  const width = pixels(first.width);

  return (width !== null && width >= HERO_MIN_WIDTH) ||
    (width === null && (first.srcset !== null || first.inPicture))
    ? first
    : null;
};

/** Vector, animated and inline images, which one file serves at every size. */
const isFixedFormat = (src: string): boolean =>
  /^data:/iu.test(src) || /\.(?:svg|gif)(?:[?#]|$)/iu.test(src);

/** `defer` on a blocking script, written into its tag as the page writes it. */
const deferEdit = (src: string, tag: string | undefined): FixEdit =>
  setAttributeEdit(
    tag ?? null,
    `head > script[src="${src.replaceAll('"', String.raw`\"`)}"]`,
    "defer",
    true,
    "Only when no inline script further down calls this one before the page has loaded (a jQuery plugin set-up, for instance), and it is not a consent manager or A/B test that must run before anything renders; async suits independent scripts such as analytics."
  );

/** `defer` on each script in <head> that blocks the parser. */
export const deferEdits = (page: ExtractedPage): FixEdit[] =>
  page.head.blockingScripts.map((src, i) =>
    deferEdit(src, page.head.sources.blockingScripts[i])
  );

/**
 * The first large image of the page, likely in the first screen and often the Largest Contentful
 * Paint, when it has loading="lazy": null otherwise. An image in a <template> is not on the page
 * until a script stamps it out.
 */
export const lazyFirstImage = (page: ExtractedPage): ImageInfo | null => {
  const first = page.images.find(
    (i) => i.src && i.wordsBefore !== null && !isVector(i.src) && !isSmall(i)
  );

  return first &&
    first.wordsBefore !== null &&
    isLazy(first) &&
    first.wordsBefore < ABOVE_FOLD_WORDS
    ? first
    : null;
};

/**
 * srcset and sizes for a large image: the file it has at its own width, plus smaller copies only
 * the author can make.
 */
const srcsetEdit = (image: ImageInfo): FixEdit => {
  const own = `${escapeAttribute(image.src ?? "")} ${pixels(image.width)}w`;
  const srcset = `${slot("smaller copies, e.g. /img-480.jpg 480w, /img-960.jpg 960w")}, ${own}`;
  const sizes = slot("display width, e.g. 100vw");

  const write =
    "srcset: smaller copies of the image (the framework's image component or a CDN image service makes them) with their pixel widths; sizes: how wide the image shows, such as 100vw or (min-width: 800px) 50vw, 100vw.";

  const withSrcset = withAttribute(image.tag, "srcset", srcset);

  const rewritten = withSrcset
    ? withAttribute(withSrcset, "sizes", sizes)
    : null;

  return rewritten
    ? replaceHtml(image.tag, rewritten, { at: imageAt(image), write })
    : addHtml(imageAt(image), `srcset="${srcset}" sizes="${sizes}"`, write);
};

export const loadingRules = [
  defineRule(
    {
      id: "loading.render-blocking-script",
      category: "performance",
      severity: "info",
      description:
        'Scripts in <head> load without async, defer or type="module", so the browser stops building the page until each one has downloaded and run.',
      recommendation:
        'Add defer to scripts the page needs once it is parsed, or async to independent ones such as analytics; type="module" scripts are deferred already. A script that must run before anything renders (a consent manager, an A/B test) can stay, but keep it small.',
      docs: "https://developer.chrome.com/docs/lighthouse/performance/render-blocking-resources",
    },
    ({ page }, make) => {
      const scripts = page.head.blockingScripts;

      return scripts.length > 0
        ? make(
            `${scripts.length} script(s) in <head> block rendering: ${cap(scripts, 3).join(", ")}.`,
            {
              fix: deferEdits(page),
              selector: "head > script[src]:not([async]):not([defer])",
              evidence: { count: scripts.length, scripts: cap(scripts) },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "loading.no-compression",
      category: "performance",
      severity: "warning",
      description:
        "The HTML is sent uncompressed although the request accepted gzip, so every visitor and crawler downloads several times more bytes than needed.",
      recommendation:
        "Turn on gzip or Brotli compression for text/html (and CSS, JavaScript, JSON, SVG) in the web server, CDN or hosting settings: gzip on in nginx, mod_deflate in Apache, compression() middleware in Express.",
      docs: "https://developer.chrome.com/docs/lighthouse/performance/uses-text-compression",
    },
    ({ page, source, response }, make) => {
      if (
        source !== "url" ||
        !response ||
        response.status !== 200 ||
        isLocalHost(response.finalUrl) ||
        page.htmlBytes < MIN_COMPRESSIBLE_BYTES ||
        // In a Worker the site's Content-Encoding never reaches the audit: no sign either way.
        !seesContentEncoding()
      ) {
        return null;
      }

      const encoding = (response.headers["content-encoding"] ?? "")
        .trim()
        .toLowerCase();

      return encoding === "" || encoding === "identity"
        ? make(
            `The ${Math.round(page.htmlBytes / 1024)} KB of HTML arrived without Content-Encoding.`,
            {
              fix: [
                addEdit("http", "response headers", "Content-Encoding: gzip", {
                  write:
                    "Turn on compression in the web server or CDN so it sends this header with a gzip (or br) body: `gzip on; gzip_types text/html text/css application/javascript application/json image/svg+xml;` in nginx, mod_deflate in Apache, compression() middleware in Express, or the CDN's compression setting. Never set the header by hand: the body must be compressed to match it.",
                }),
              ],
              evidence: { bytes: page.htmlBytes, contentEncoding: null },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "img.lazy-above-fold",
      category: "images",
      severity: "info",
      description:
        'The first large image on the page, likely in the first screen and often the Largest Contentful Paint, has loading="lazy", which delays it (info). An image with both fetchpriority="high" and loading="lazy" contradicts itself (warning).',
      recommendation:
        'Remove loading="lazy" from images in the first screen, and give the main one fetchpriority="high". Keep lazy loading for images further down the page. In Next.js, set priority (or preload) on that <Image>.',
      docs: "https://web.dev/articles/browser-level-image-lazy-loading",
    },
    ({ page }, make) => {
      const contradicting = page.images.filter(
        (i) => isLazy(i) && i.fetchpriority === "high"
      );

      if (contradicting.length > 0) {
        return make(
          `${contradicting.length} image(s) have both fetchpriority="high" and loading="lazy".`,
          {
            severity: "warning",
            fix: contradicting.map((image) => eagerEdit(image, false)),
            selector: 'img[loading="lazy"][fetchpriority="high"]',
            evidence: { images: cap(contradicting.map((i) => i.src)) },
          }
        );
      }

      const first = lazyFirstImage(page);

      return first
        ? make(
            `The first image (${first.src}) comes after ${first.wordsBefore} words of text and has loading="lazy".`,
            {
              fix: [eagerEdit(first, true)],
              selector: 'img[loading="lazy"]',
              evidence: { src: first.src, wordsBefore: first.wordsBefore },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "img.lcp-fetchpriority-missing",
      category: "images",
      severity: "info",
      description:
        'The first large image on the page, likely in the first screen and often the Largest Contentful Paint, has no fetchpriority="high", and no other image does, so the browser fetches it with the other images rather than first.',
      recommendation:
        'Add fetchpriority="high" to the main image of the first screen (in Next.js, priority or preload on that <Image>), and to no more than one or two images per page.',
      docs: "https://web.dev/articles/fetch-priority",
    },
    ({ page }, make) => {
      const hero = unprioritizedHero(page);

      return hero
        ? make(
            `The first large image (${hero.src}) comes after ${hero.wordsBefore} words of text and has no fetchpriority="high".`,
            {
              fix: [
                setAttributeEdit(
                  hero.tag,
                  imageAt(hero),
                  "fetchpriority",
                  "high",
                  "Only if this image is the largest element of the first screen; if a carousel shows it, only on its first slide."
                ),
              ],
              selector: imageAt(hero),
              evidence: { src: hero.src, wordsBefore: hero.wordsBefore },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "img.srcset-missing",
      category: "images",
      severity: "info",
      description: `Images ${SRCSET_MIN_WIDTH} pixels wide or more (by their width attribute) have no srcset or <picture>, so phones download the full-size file.`,
      recommendation:
        'Offer smaller versions with srcset and sizes (srcset="hero-480.jpg 480w, hero-960.jpg 960w" sizes="100vw"), or use the framework\'s image component (next/image, astro:assets, NuxtImg), which generates them.',
      docs: "https://web.dev/articles/serve-responsive-images",
    },
    ({ page }, make) => {
      const large = page.images.filter((i) => {
        const width = pixels(i.width);

        return (
          i.src !== null &&
          !isFixedFormat(i.src) &&
          !i.srcset &&
          !i.inPicture &&
          width !== null &&
          width >= SRCSET_MIN_WIDTH
        );
      });

      return large.length > 0
        ? make(
            `${large.length} image(s) at least ${SRCSET_MIN_WIDTH} pixels wide have no srcset.`,
            {
              fix: large.map((image) => srcsetEdit(image)),
              evidence: {
                count: large.length,
                examples: cap(
                  large.map((i) => ({ src: i.src, width: i.width }))
                ),
              },
            }
          )
        : null;
    }
  ),
  defineRule(
    {
      id: "favicon.missing",
      category: "document",
      severity: "info",
      description:
        'The home page has no <link rel="icon"> (or apple-touch-icon). Google takes the icon it shows next to the site in search results from the home page.',
      recommendation:
        'Add <link rel="icon" href="/favicon.svg"> (or a square PNG larger than 48x48 pixels) to the home page\'s <head>, and keep the file crawlable. Google documents only the link, not a /favicon.ico fallback.',
      docs: "https://developers.google.com/search/docs/appearance/favicon-in-search",
    },
    // An error or a bot challenge is not the home page the site serves.
    ({ page, source, response }, make) =>
      source !== "html" &&
      (response?.status ?? 200) < 400 &&
      isHomePage(page.url) &&
      page.head.icons.length === 0
        ? make("The home page links to no icon.", {
            fix: [
              addHtml(
                "head",
                `<link rel="icon" href="${slot("/favicon.svg")}">`,
                "The path of the site's icon: an SVG, or a square PNG larger than 48x48 pixels. Add the file if the site has none, and keep it crawlable."
              ),
            ],
            selector: 'head > link[rel="icon"]',
          })
        : null
  ),
];
