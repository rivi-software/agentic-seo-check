/**
 * The Product Hunt badge, on the website's homepage and the hosted server's page, drawn as the
 * Claude Directory's beside it is, with the product's upvotes. Product Hunt draws its own badge
 * with the upvotes of the moment, at api.producthunt.com, which sets a cookie, would learn each
 * visitor's address, and looks like nothing else on the pages. So the Worker reads the count from
 * that badge itself and writes it into the page, kept four hours in the Cache API of the Cloudflare
 * location, as long as Product Hunt's own answer may be kept: a visitor's browser reaches Product
 * Hunt only by following the link. When Product Hunt answers with no count, the badge asks for an
 * upvote instead, which the location keeps five minutes, so it asks Product Hunt again at most that
 * often.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import { esc } from "../site/html.js";
import { icon } from "./icons.js";

/** The product's page on Product Hunt, with the campaign of Product Hunt's own embed code. */
export const PRODUCT_HUNT_URL =
  "https://www.producthunt.com/products/agentic-seo-check?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-agentic-seo-check";

/** Product Hunt's badge, which holds the upvotes of the moment. */
export const PRODUCT_HUNT_BADGE_URL =
  "https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1313023&theme=dark";

/** Where a location keeps the count: an address on its own hostname that no route serves. */
const KEEP_PATH = "/product-hunt/upvotes";

/** How long a Cloudflare location keeps the count: Product Hunt's answer allows four hours. */
const KEEP_SECONDS = 14_400;

/** How long a location keeps the answer that had no count. */
const MISSING_SECONDS = 300;

/** Product Hunt's badge is about 2 KB: an answer far larger is not the badge. */
const MAX_BYTES = 65_536;

/** The page waits for Product Hunt this long, once per location every four hours, and no longer. */
const TIMEOUT_MS = 1500;

/** Names the Worker to Product Hunt, so the request does not pass for a person's or an audit's. */
const USER_AGENT = `${PRODUCT_NAME} badge (+https://agentic-seo.rivi.software)`;

/** A count as Product Hunt writes one: digits, perhaps grouped or shortened ("1,204", "1.2K"). */
const COUNT = /^\d[\d,.]{0,8}K?$/u;

/**
 * The upvotes in Product Hunt's badge: the text after its upvote arrow, a `<polygon>`. Read with
 * `indexOf`, so a long answer costs one pass, and undefined when that text is not a count.
 */
export const upvotesIn = (svg: string): string | undefined => {
  const arrow = svg.indexOf("<polygon");
  const tspan = arrow === -1 ? -1 : svg.indexOf("<tspan", arrow);

  // indexOf from -1 would search from the start, before the arrow: stop at the first miss.
  if (tspan < 0) {
    return undefined;
  }

  const open = svg.indexOf(">", tspan);
  const close = open === -1 ? -1 : svg.indexOf("</tspan>", open);

  if (close < 0) {
    return undefined;
  }

  const text = svg.slice(open + 1, close).trim();

  return COUNT.test(text) ? text : undefined;
};

/**
 * The badge linked to the product's page, as Product Hunt's embed code has it, in the look of the
 * Claude Directory's: the upvotes when the Worker read them, and an invitation to upvote otherwise.
 */
export const productHuntBadge = (upvotes?: string): string => {
  const value =
    upvotes === undefined
      ? "Upvote"
      : `${esc(upvotes)}<span class="sr-only"> ${upvotes === "1" ? "upvote" : "upvotes"}</span>`;

  return `<a class="badge" href="${esc(PRODUCT_HUNT_URL)}" target="_blank" rel="noopener noreferrer"><span class="badge-key">Product Hunt</span><span class="badge-value">${icon("upvote")}${value}</span></a>`;
};

/** The part of the Cache API the count uses, so the tests can give their own. */
export interface UpvoteCache {
  match: (request: Request) => Promise<Response | undefined>;
  put: (request: Request, response: Response) => Promise<void>;
}

/** How Product Hunt is asked: the Worker's fetch, or the tests' own. */
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The Worker's own Cache API and fetch, unless the tests give theirs. */
export interface UpvoteOptions {
  cache?: UpvoteCache;
  fetch?: Fetcher;
}

/** The upvotes in Product Hunt's badge, or undefined when its answer holds none. */
const fetchUpvotes = async (fetcher: Fetcher): Promise<string | undefined> => {
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

    return svg.length <= MAX_BYTES ? upvotesIn(svg) : undefined;
  } catch {
    // Product Hunt is down, slow or unreachable: the badge asks for an upvote.
    return undefined;
  }
};

/**
 * The upvotes for the page at `request`: the count this location keeps, or else Product Hunt's,
 * which the location then keeps for as long as it may, or undefined when Product Hunt gave none.
 */
export const productHuntUpvotes = async (
  request: Request,
  ctx: Pick<ExecutionContext, "waitUntil">,
  options: UpvoteOptions = {}
): Promise<string | undefined> => {
  const cache = options.cache ?? (await caches.open("product-hunt"));
  const key = new Request(new URL(KEEP_PATH, request.url));
  const kept = await cache.match(key);

  if (kept) {
    return (await kept.text()) || undefined;
  }

  const upvotes = await fetchUpvotes(options.fetch ?? fetch);
  const keep = upvotes === undefined ? MISSING_SECONDS : KEEP_SECONDS;

  ctx.waitUntil(
    cache.put(
      key,
      new Response(upvotes ?? "", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": `public, max-age=${keep}`,
        },
      })
    )
  );

  return upvotes;
};
