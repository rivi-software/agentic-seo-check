/**
 * The frame of every page on both hostnames: the head a search engine reads, RIVI Software's
 * header and footer, and the stylesheet. The website (site/layout.ts) and the hosted server's
 * pages (pages.ts) differ in their origin and the header's button; the navigation and the footer
 * link the two hostnames, so they read as one site.
 */
import {
  MAKER,
  MAKER_URL,
  PRODUCT_NAME,
  REPOSITORY_URL,
} from "../../../src/brand.js";
import type { JsonObject } from "../../../src/core/html/structured-data.js";
import { ORIGIN as MCP_ORIGIN, SITE_ORIGIN } from "../limits.js";
import { esc, scriptSafe } from "../site/html.js";
import { GITHUB_MARK, icon, MARK } from "./icons.js";
import { cardAlt, OG_IMAGE } from "./og.js";
import type { ShareCard } from "./og.js";
import { productHuntBadge } from "./product-hunt.js";
import { FONT_PATHS, STYLE } from "./style.js";

export const ABUSE_URL = "https://help.rivi.software/contact";

/** RIVI Software's privacy policy, which covers the website, the hosted server and the CLI. */
export const PRIVACY_URL = "https://help.rivi.software/help/privacy-policy";

export const NPM_URL =
  "https://www.npmjs.com/package/@rivi-software/agentic-seo-check";

/** RIVI Software's account on X, which a card names and a post made from a report mentions. */
export const X_ACCOUNT = "rivi_software";

/** The hosted server's listing in the Claude Directory, where claude.ai adds it in one step. */
export const CLAUDE_DIRECTORY_URL =
  "https://claude.ai/directory/agentic-seo-check";

/**
 * A link to the listing drawn as a badge, like the README's. Words only: Anthropic's trademark
 * guidelines allow Claude's logo only where Anthropic approved it beforehand.
 */
export const directoryBadge = (): string =>
  `<a class="badge" href="${CLAUDE_DIRECTORY_URL}"><span class="badge-key">Claude Directory</span><span class="badge-value">${icon("check")}Listed</span></a>`;

/**
 * Where the tool is listed, side by side: the Claude Directory and Product Hunt, with the
 * `upvotes` the Worker read there.
 */
export const listingBadges = (upvotes?: string): string =>
  `<div class="badges">${directoryBadge()}${productHuntBadge(upvotes)}</div>`;

/** RIVI Software's page of the code it publishes, which lists this project. */
const OPEN_SOURCE_URL = `${MAKER_URL}/open-source`;

const PUBLISHER_ID = `${MAKER_URL}/#organization`;

export const publisher = { "@id": PUBLISHER_ID };

/** The hostname a page is served on, and what the header's button offers there. */
export interface Host {
  origin: string;
  action: { href: string; label: string };
  /** The hostname's share image, at OG_IMAGE.path. */
  card: ShareCard;
}

export interface FramePage {
  path: string;
  title: string;
  description: string;
  /** The page's own structured data, beside the publisher. */
  data: JsonObject;
  body: string;
  /** Loads Cloudflare Turnstile, for the audit form. */
  turnstile?: boolean;
  /** The page's own share image, in place of its hostname's card (a shared result's). */
  image?: { url: string; alt: string };
  /** Keeps the page out of search: it says little of its own (a shared result). */
  noindex?: boolean;
}

/**
 * The pages of both hostnames, in the order the header lists them: three, for the people who use
 * the tool. The page for site owners, which the User-Agent links to directly, is in the footer.
 */
const NAV: [href: string, label: string][] = [
  [`${SITE_ORIGIN}/`, "Audit"],
  [`${SITE_ORIGIN}/rules`, "Rules"],
  [`${MCP_ORIGIN}/`, "MCP server"],
];

const FOOTER: [heading: string, links: [href: string, label: string][]][] = [
  [
    "The tool",
    [
      [`${SITE_ORIGIN}/`, "Audit a page or site"],
      [`${SITE_ORIGIN}/rules`, "The rules"],
      [`${MCP_ORIGIN}/`, "Hosted MCP server"],
      [CLAUDE_DIRECTORY_URL, "In the Claude Directory"],
      [`${MCP_ORIGIN}/crawler`, "For site owners"],
    ],
  ],
  [
    "Open source",
    [
      [REPOSITORY_URL, "Code on GitHub"],
      [`${REPOSITORY_URL}#readme`, "The README"],
      [`${REPOSITORY_URL}/issues`, "Issues"],
      [NPM_URL, "The package on npm"],
    ],
  ],
  [
    MAKER,
    [
      [MAKER_URL, "rivi.software"],
      [OPEN_SOURCE_URL, "Open source at RIVI"],
      [ABUSE_URL, "Report abuse"],
      [`${SITE_ORIGIN}/llms.txt`, "llms.txt"],
    ],
  ],
];

/** `href` as a page on `origin` links it: a path on the same hostname, so local runs link up. */
export const linkFrom = (origin: string, href: string): string =>
  href.startsWith(`${origin}/`) ? href.slice(origin.length) : href;

const links = (host: Host, url: string, items: [string, string][]): string =>
  items
    .map(
      ([href, label]) =>
        `<a href="${linkFrom(host.origin, href)}"${href === url ? ' aria-current="page"' : ""}>${label}</a>`
    )
    .join("");

const footer = (host: Host): string => `<footer class="site-footer">
<div class="wrap">
<div class="footer-grid">
<div class="footer-brand">
<a class="site-logo" href="${linkFrom(host.origin, `${SITE_ORIGIN}/`)}">${MARK}<span>RIVI ${PRODUCT_NAME}</span></a>
<p>SEO and AEO audits with the exact fix for every finding.</p>
<a class="btn btn-secondary btn-sm" href="${REPOSITORY_URL}">${GITHUB_MARK}Star it on GitHub</a>
</div>
${FOOTER.map(
  (
    [heading, items],
    index
  ) => `<nav class="footer-col" aria-labelledby="footer-${index}">
<p class="footer-heading" id="footer-${index}">${heading}</p>
<ul>${items.map(([href, label]) => `<li><a href="${linkFrom(host.origin, href)}">${label}</a></li>`).join("")}</ul>
</nav>`
).join("\n")}
</div>
<div class="footer-bottom">
<p>Open source (MIT), made by <a href="${MAKER_URL}">${MAKER}</a>.</p>
<div class="footer-links"><a href="${PRIVACY_URL}">Privacy policy</a><button class="footer-consent" type="button" data-consent-settings hidden>Cookie settings</button><a href="${MAKER_URL}">rivi.software</a></div>
</div>
</div>
</footer>`;

/**
 * The cookie banner (issue #57). It stays hidden until site.js has loaded PostHog and the visitor
 * has made no choice, so a page without the script, or with the analytics off, shows none. Until a
 * choice, and after "Decline", PostHog counts the visit without a cookie.
 */
const CONSENT_BANNER = `<section class="consent" id="consent" aria-labelledby="consent-title" hidden>
<p class="consent-title" id="consent-title">One cookie, if you allow it</p>
<p>This site counts visits with PostHog (EU), without cookies. May it set a cookie that recognises your browser when you come back? <a href="${PRIVACY_URL}">Privacy policy</a></p>
<div class="consent-actions"><button class="btn btn-secondary btn-sm" type="button" data-consent="decline">Decline</button><button class="btn btn-primary btn-sm" type="button" data-consent="accept">Accept</button></div>
</section>`;

/**
 * The whole document of `page`, on the hostname of `host`. Every page opens with a heading in
 * Bricolage Grotesque over copy in Geist, so it preloads both: without that, the heading would
 * paint in Geist and then reflow.
 */
export const frame = (host: Host, page: FramePage): string => {
  const url = `${host.origin}${page.path}`;

  const image = page.image ?? {
    url: `${host.origin}${OG_IMAGE.path}`,
    alt: cardAlt(host.card),
  };

  const organization: JsonObject = {
    "@type": "Organization",
    "@id": PUBLISHER_ID,
    name: MAKER,
    url: MAKER_URL,
    logo: `${host.origin}/favicon.svg`,
    sameAs: ["https://github.com/rivi-software"],
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${url}">${page.noindex ? '\n<meta name="robots" content="noindex">' : ""}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${FONT_PATHS.display}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${FONT_PATHS.sans}" as="font" type="font/woff2" crossorigin>
<meta name="theme-color" content="#08090a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${PRODUCT_NAME}">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${esc(image.url)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${OG_IMAGE.width}">
<meta property="og:image:height" content="${OG_IMAGE.height}">
<meta property="og:image:alt" content="${esc(image.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@${X_ACCOUNT}">
<script type="application/ld+json">${scriptSafe(
    JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [organization, page.data],
    })
  )}</script>
<style>${STYLE}</style>
<script src="/site.js" defer></script>${
    page.turnstile
      ? '\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
      : ""
  }
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
<div class="wrap header-inner">
<a class="site-logo" href="${linkFrom(host.origin, `${SITE_ORIGIN}/`)}">${MARK}<span>RIVI ${PRODUCT_NAME}</span></a>
<nav class="nav" aria-label="Site">${links(host, url, NAV)}</nav>
<div class="header-actions">
<a class="btn btn-secondary btn-sm header-github" href="${REPOSITORY_URL}">${GITHUB_MARK}GitHub</a>
<a class="btn btn-primary btn-sm header-cta" href="${linkFrom(host.origin, host.action.href)}">${host.action.label}${icon("arrow", "arrow")}</a>
<details class="menu">
<summary><span class="menu-lines" aria-hidden="true"></span><span class="sr-only">Menu</span></summary>
<nav class="menu-panel" aria-label="Menu">${links(host, url, [...NAV, [REPOSITORY_URL, "GitHub"], [host.action.href, host.action.label]])}</nav>
</details>
</div>
</div>
</header>
<main id="main" tabindex="-1">
${page.body}
</main>
${footer(host)}
${CONSENT_BANNER}
</body>
</html>
`;
};
