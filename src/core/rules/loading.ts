import { isHomePage } from "../aeo/page.js";
import type { ImageInfo } from "../types.js";
import { isLocalHost } from "./canonical.js";
import { cap, defineRule } from "./rule.js";

/** Below this size compression saves less than the request costs (Lighthouse's own cut-off). */
const MIN_COMPRESSIBLE_BYTES = 1400;

/** An image shown before this many words of text is likely in the first screen. */
const ABOVE_FOLD_WORDS = 100;

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

/** Vector, animated and inline images, which one file serves at every size. */
const isFixedFormat = (src: string): boolean =>
  /^data:/iu.test(src) || /\.(?:svg|gif)(?:[?#]|$)/iu.test(src);

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
        page.htmlBytes < MIN_COMPRESSIBLE_BYTES
      ) {
        return null;
      }

      const encoding = (response.headers["content-encoding"] ?? "")
        .trim()
        .toLowerCase();

      return encoding === "" || encoding === "identity"
        ? make(
            `The ${Math.round(page.htmlBytes / 1024)} KB of HTML arrived without Content-Encoding.`,
            { evidence: { bytes: page.htmlBytes, contentEncoding: null } }
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
            selector: 'img[loading="lazy"][fetchpriority="high"]',
            evidence: { images: cap(contradicting.map((i) => i.src)) },
          }
        );
      }

      const first = page.images.find(
        (i) => i.src && !isVector(i.src) && !isSmall(i)
      );

      return first && isLazy(first) && first.wordsBefore < ABOVE_FOLD_WORDS
        ? make(
            `The first image (${first.src}) comes after ${first.wordsBefore} words of text and has loading="lazy".`,
            {
              selector: 'img[loading="lazy"]',
              evidence: { src: first.src, wordsBefore: first.wordsBefore },
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
            selector: 'head > link[rel="icon"]',
          })
        : null
  ),
];
