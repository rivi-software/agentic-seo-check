/**
 * The Product Hunt badge, on the website's homepage and the hosted server's page. Product Hunt
 * draws it with the product's upvotes of the moment, at api.producthunt.com, which sets a cookie and
 * would learn each visitor's address. So each Worker fetches the badge itself and serves it from its
 * own hostname, kept for four hours in the Cache API of the Cloudflare location, as long as Product
 * Hunt's own answer may be kept: a visitor's browser reaches Product Hunt only by following the link.
 * When Product Hunt answers with no badge, the page shows its artwork without the count, which the
 * location keeps five minutes, so it asks Product Hunt again at most that often.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { esc } from "../site/html.js";

/** The product's page on Product Hunt, with the campaign of Product Hunt's own embed code. */
export const PRODUCT_HUNT_URL =
  "https://www.producthunt.com/products/agentic-seo-check?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-agentic-seo-check";

/** Where both hostnames serve the badge. */
export const PRODUCT_HUNT_BADGE_PATH = "/product-hunt.svg";

/** The badge in Product Hunt's dark theme, which suits the pages' dark look. */
export const PRODUCT_HUNT_BADGE_URL =
  "https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1313023&theme=dark";

/** How long a Cloudflare location keeps the badge: Product Hunt's answer allows four hours. */
const KEEP_SECONDS = 14_400;

/** How long a browser keeps the badge. */
const BROWSER_SECONDS = 3600;

/** How long the artwork without the count is kept, by a location and by a browser. */
const FALLBACK_SECONDS = 300;

/** Product Hunt's badge is about 2 KB: an answer far larger is not the badge. */
const MAX_BYTES = 65_536;

const TIMEOUT_MS = 5000;

/** Names the Worker to Product Hunt, so the request does not pass for a person's or an audit's. */
const USER_AGENT = `${PRODUCT_NAME} badge (+https://agentic-seo.rivi.software)`;

/**
 * Product Hunt's artwork without the count, for when it answers with no badge. It keeps the
 * badge's size, so the page around it does not move.
 */
export const FALLBACK_BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="54" viewBox="0 0 250 54"><rect x=".5" y=".5" width="249" height="53" rx="10" fill="#221D21" stroke="#221D21"/><g fill="#EEF2FF" font-family="Helvetica-Bold, Helvetica" font-weight="bold"><text x="53" y="20" font-size="9">FIND US ON</text><text x="52" y="40" font-size="21">Product Hunt</text></g><g transform="translate(11 12)"><circle cx="15.5" cy="15.5" r="15.5" fill="#FFF"/><path fill="#221D21" fill-rule="evenodd" d="M17.43 15.96h-4.34v-4.65h4.34a2.31 2.31 0 0 1 2.3 2.32 2.31 2.31 0 0 1-2.3 2.33m0-7.75h-7.4v15.5h3.06v-4.65h4.34a5.38 5.38 0 0 0 5.36-5.43 5.38 5.38 0 0 0-5.36-5.42"/></g></svg>`;

/** The badge linked to the product's page, as Product Hunt's embed code has it, served from this hostname. */
export const productHuntBadge = (): string =>
  `<a class="badge-image" href="${esc(PRODUCT_HUNT_URL)}" target="_blank" rel="noopener noreferrer"><img alt="${PRODUCT_NAME} - SEO and AEO audits with the fix for every finding | Product Hunt" width="250" height="54" src="${PRODUCT_HUNT_BADGE_PATH}"></a>`;

/**
 * An SVG on this hostname may be opened as a page of its own: this policy keeps it from running
 * a script or loading anything, whatever Product Hunt sends.
 */
const SVG_HEADERS = {
  "content-type": "image/svg+xml",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
};

/** The part of the Cache API the badge uses, so the tests can give their own. */
export interface BadgeCache {
  match: (request: Request) => Promise<Response | undefined>;
  put: (request: Request, response: Response) => Promise<void>;
}

/** How the badge is requested: the Worker's fetch, or the tests' own. */
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The Worker's own Cache API and fetch, unless the tests give theirs. */
export interface BadgeOptions {
  cache?: BadgeCache;
  fetch?: Fetcher;
}

/** Product Hunt's badge, or undefined when its answer is not one. */
const fetchBadge = async (fetcher: Fetcher): Promise<string | undefined> => {
  try {
    const res = await fetcher(PRODUCT_HUNT_BADGE_URL, {
      headers: { accept: "image/svg+xml", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const length = Number(res.headers.get("content-length") ?? 0);

    if (
      !res.ok ||
      !res.headers.get("content-type")?.startsWith("image/svg+xml") ||
      length > MAX_BYTES
    ) {
      await res.body?.cancel();

      return undefined;
    }

    const svg = await res.text();

    return svg.length <= MAX_BYTES && svg.includes("<svg") ? svg : undefined;
  } catch {
    // Product Hunt is down, slow or unreachable: the page shows the badge without the count.
    return undefined;
  }
};

const answer = (request: Request, svg: string, maxAge: number): Response =>
  new Response(request.method === "HEAD" ? null : svg, {
    headers: { ...SVG_HEADERS, "cache-control": `public, max-age=${maxAge}` },
  });

const browserSeconds = (svg: string): number =>
  svg === FALLBACK_BADGE ? FALLBACK_SECONDS : BROWSER_SECONDS;

/**
 * The badge at PRODUCT_HUNT_BADGE_PATH: the one this location keeps, or else Product Hunt's, or
 * its artwork without the count, which the location then keeps for as long as each may be kept.
 */
export const productHuntBadgeResponse = async (
  request: Request,
  ctx: Pick<ExecutionContext, "waitUntil">,
  options: BadgeOptions = {}
): Promise<Response> => {
  const cache = options.cache ?? (await caches.open("product-hunt"));

  // The cache keeps GET answers, and a HEAD asks for the same badge without its body.
  const key = new Request(new URL(PRODUCT_HUNT_BADGE_PATH, request.url), {
    method: "GET",
  });

  const kept = await cache.match(key);

  if (kept) {
    const svg = await kept.text();

    return answer(request, svg, browserSeconds(svg));
  }

  const svg = (await fetchBadge(options.fetch ?? fetch)) ?? FALLBACK_BADGE;
  const keep = svg === FALLBACK_BADGE ? FALLBACK_SECONDS : KEEP_SECONDS;

  ctx.waitUntil(
    cache.put(
      key,
      new Response(svg, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": `public, max-age=${keep}`,
        },
      })
    )
  );

  return answer(request, svg, browserSeconds(svg));
};
