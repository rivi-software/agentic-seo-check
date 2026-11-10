/**
 * The frame of every page of the website (issue #39): the head a search engine reads, the RIVI
 * lockup and the navigation, and the footer with RIVI Software's line.
 */
import { MAKER, MAKER_URL, REPOSITORY_URL } from "../../../src/brand.js";
import type { JsonObject } from "../../../src/core/html/structured-data.js";
import { ORIGIN as MCP_ORIGIN, SITE_ORIGIN } from "../limits.js";
import { ABUSE_URL } from "../pages.js";
import { scriptSafe } from "./html.js";
import { FONT_PATH, STYLE } from "./style.js";

export { SITE_ORIGIN } from "../limits.js";

export const SITE_HOST = new URL(SITE_ORIGIN).hostname;

/** The hosted MCP server's own page, which says how to add it to an assistant. */
export const HOSTED_PAGE = `${MCP_ORIGIN}/`;

export const NPM_URL =
  "https://www.npmjs.com/package/@rivi-software/agentic-seo-check";

/**
 * The RIVI Software mark (assets/rivi-mark.svg), drawn with the page's colours so that it turns to
 * the on-dark mark with the theme.
 */
const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="36" height="36" aria-hidden="true"><rect width="40" height="40" rx="9" fill="var(--tile)"/><g fill="var(--bars)"><rect x="8" y="16" width="3" height="8" rx="1.5"/><rect x="13.25" y="11" width="3" height="18" rx="1.5"/><rect x="18.5" y="7" width="3" height="26" rx="1.5" fill="var(--signal)"/><rect x="23.75" y="12" width="3" height="16" rx="1.5"/><rect x="29" y="16" width="3" height="8" rx="1.5"/></g></svg>';

const PUBLISHER_ID = `${MAKER_URL}/#organization`;

const ORGANIZATION: JsonObject = {
  "@type": "Organization",
  "@id": PUBLISHER_ID,
  name: MAKER,
  url: MAKER_URL,
  logo: `${SITE_ORIGIN}/favicon.svg`,
  sameAs: ["https://github.com/rivi-software"],
};

export const publisher = { "@id": PUBLISHER_ID };

export interface SitePage {
  path: string;
  title: string;
  description: string;
  /** The page's own structured data, beside the publisher. */
  data: JsonObject;
  body: string;
  /** Loads the script of the audit form and the report's buttons. */
  script?: boolean;
  /** Loads Cloudflare Turnstile, for the audit form. */
  turnstile?: boolean;
}

const NAV: [path: string, label: string][] = [
  ["/", "Audit a page"],
  ["/rules", "Rules"],
];

const nav = (current: string): string =>
  NAV.map(
    ([path, label]) =>
      `<a href="${path}"${path === current ? ' aria-current="page"' : ""}>${label}</a>`
  ).join("");

export const layout = (page: SitePage): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<link rel="canonical" href="${SITE_ORIGIN}${page.path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin>
<meta property="og:type" content="website">
<meta property="og:site_name" content="agentic-seo-check">
<meta property="og:title" content="${page.title}">
<meta property="og:description" content="${page.description}">
<meta property="og:url" content="${SITE_ORIGIN}${page.path}">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${scriptSafe(
  JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [ORGANIZATION, page.data],
  })
)}</script>
<style>${STYLE}</style>${page.script ? '\n<script src="/site.js" defer></script>' : ""}${
  page.turnstile
    ? '\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : ""
}
</head>
<body>
<header class="wrap site-header">
<a class="brand" href="/">${MARK}<span>RIVI agentic-seo-check</span></a>
<nav class="site-nav" aria-label="Site">${nav(page.path)}<a href="${HOSTED_PAGE}">Hosted MCP server</a><a href="${REPOSITORY_URL}">GitHub</a></nav>
</header>
<main>
${page.body}
</main>
<footer class="site-footer">
<div class="wrap">
<p>agentic-seo-check is open source (MIT) and made by <a href="${MAKER_URL}">${MAKER}</a>. Code and issues: <a href="${REPOSITORY_URL}">github.com/rivi-software/agentic-seo-check</a>. The package: <a href="${NPM_URL}">@rivi-software/agentic-seo-check on npm</a>.</p>
<p>If this site or the hosted server has requested your site, <a href="${MCP_ORIGIN}/crawler">the page for site owners</a> says what the requests are and how to stop them. Report abuse through <a href="${ABUSE_URL}">help.rivi.software/contact</a>.</p>
</div>
</footer>
</body>
</html>
`;
