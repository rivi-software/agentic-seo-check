/**
 * The frame of every page on both hostnames: the head a search engine reads, RIVI Software's
 * header and footer, and the stylesheet. The website (site/layout.ts) and the hosted server's
 * pages (pages.ts) differ in their origin and the header's button; the navigation and the footer
 * link the two hostnames, so they read as one site.
 */
import { MAKER, MAKER_URL, REPOSITORY_URL } from "../../../src/brand.js";
import type { JsonObject } from "../../../src/core/html/structured-data.js";
import { ORIGIN as MCP_ORIGIN, SITE_ORIGIN } from "../limits.js";
import { esc, scriptSafe } from "../site/html.js";
import { GITHUB_MARK, icon, MARK } from "./icons.js";
import { cardAlt, OG_IMAGE } from "./og.js";
import type { ShareCard } from "./og.js";
import { FONT_PATHS, STYLE } from "./style.js";

export const ABUSE_URL = "https://help.rivi.software/contact";

export const NPM_URL =
  "https://www.npmjs.com/package/@rivi-software/agentic-seo-check";

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
}

/** The pages of both hostnames, in the order the header lists them. */
const NAV: [href: string, label: string][] = [
  [`${SITE_ORIGIN}/`, "Audit a page"],
  [`${SITE_ORIGIN}/rules`, "Rules"],
  [`${MCP_ORIGIN}/`, "MCP server"],
  [`${MCP_ORIGIN}/crawler`, "For site owners"],
];

const FOOTER: [heading: string, links: [href: string, label: string][]][] = [
  [
    "The tool",
    [
      [`${SITE_ORIGIN}/`, "Audit a page"],
      [`${SITE_ORIGIN}/rules`, "The rules"],
      [`${MCP_ORIGIN}/`, "Hosted MCP server"],
      [`${SITE_ORIGIN}/llms.txt`, "llms.txt"],
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
      [`${MCP_ORIGIN}/crawler`, "For site owners"],
      [ABUSE_URL, "Report abuse"],
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
<a class="site-logo" href="${linkFrom(host.origin, `${SITE_ORIGIN}/`)}">${MARK}<span>RIVI agentic-seo-check</span></a>
<p>SEO and AEO audits for coding agents, with the exact fix for every finding. Open source under the MIT License.</p>
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
<p>agentic-seo-check is open source (MIT) and made by <a href="${MAKER_URL}">${MAKER}</a>. If this site or the hosted server has requested your site, <a href="${linkFrom(host.origin, `${MCP_ORIGIN}/crawler`)}">the page for site owners</a> says what the requests are and how to stop them. Report abuse through <a href="${ABUSE_URL}">help.rivi.software/contact</a>.</p>
<a href="${MAKER_URL}">rivi.software</a>
</div>
</div>
</footer>`;

/** The whole document of `page`, on the hostname of `host`. */
export const frame = (host: Host, page: FramePage): string => {
  const url = `${host.origin}${page.path}`;

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
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${FONT_PATHS.sans}" as="font" type="font/woff2" crossorigin>
<meta name="theme-color" content="#08090a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="agentic-seo-check">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${host.origin}${OG_IMAGE.path}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${OG_IMAGE.width}">
<meta property="og:image:height" content="${OG_IMAGE.height}">
<meta property="og:image:alt" content="${esc(cardAlt(host.card))}">
<meta name="twitter:card" content="summary_large_image">
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
<a class="site-logo" href="${linkFrom(host.origin, `${SITE_ORIGIN}/`)}">${MARK}<span>RIVI agentic-seo-check</span></a>
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
</body>
</html>
`;
};
