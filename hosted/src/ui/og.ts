/**
 * The share image of each hostname, which a link to one of its pages shows in a chat, a post or a
 * search result. scripts/og-image.ts draws each card as rivi.software draws its own (the lockup,
 * a pill, a two-tone heading, the mark's level bars and the domain) into assets/. The website's
 * pages and the server's share one hostname (issue #168), so each card has a path of its own, which
 * the website serves. The words are here so the frame can describe them.
 */
// From brand.ts, not limits.ts: scripts/og-image.ts runs in Node, which cannot load the Worker's
// modules limits.ts imports.
import { MCP_URL, PRODUCT_NAME, WEBSITE_URL } from "../../../src/brand.js";

export const OG_IMAGE = { width: 1200, height: 630 } as const;

export interface ShareCard {
  /** The card's file in hosted/assets/. */
  file: string;
  /** Where the card is served. */
  path: string;
  /** The pill above the heading. */
  pill: string;
  /** The heading: `title` in white, then `accent` in the muted ink. */
  title: string;
  accent: string;
  /** The line at the foot, on the left, in the mono font. */
  note: string;
  /** The hostname at the foot, on the right. */
  domain: string;
}

export const SITE_CARD: ShareCard = {
  file: "og-site.png",
  path: "/og.png",
  pill: "Free and open source",
  title: "SEO and AEO audits",
  accent: "that name the fix.",
  note: "npx @rivi-software/agentic-seo-check audit",
  domain: new URL(WEBSITE_URL).hostname,
};

export const SERVER_CARD: ShareCard = {
  file: "og-mcp.png",
  path: "/og-mcp.png",
  pill: "Hosted MCP server",
  title: "SEO and AEO audits",
  accent: "for your assistant.",
  note: MCP_URL,
  domain: new URL(WEBSITE_URL).hostname,
};

/** What a card says, as its og:image:alt. */
export const cardAlt = (card: ShareCard): string =>
  `RIVI ${PRODUCT_NAME}: ${card.title} ${card.accent} ${card.domain}`;
