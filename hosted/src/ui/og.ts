/**
 * The share image of each hostname, which a link to one of its pages shows in a chat, a post or a
 * search result. scripts/og-image.ts draws each card as rivi.software draws its own (the lockup,
 * a pill, a two-tone heading, the mark's level bars and the domain) into assets/, and each
 * hostname serves its card at OG_IMAGE.path. The words are here so the frame can describe them.
 */
import { ORIGIN as MCP_ORIGIN, SITE_ORIGIN } from "../limits.js";

export const OG_IMAGE = { path: "/og.png", width: 1200, height: 630 } as const;

export interface ShareCard {
  /** The card's file in hosted/assets/. */
  file: string;
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
  pill: "Free and open source",
  title: "SEO and AEO audits",
  accent: "that name the fix.",
  note: "npx @rivi-software/agentic-seo-check audit",
  domain: new URL(SITE_ORIGIN).hostname,
};

export const SERVER_CARD: ShareCard = {
  file: "og-mcp.png",
  pill: "Hosted MCP server",
  title: "SEO and AEO audits",
  accent: "for your assistant.",
  note: `${MCP_ORIGIN}/mcp`,
  domain: new URL(MCP_ORIGIN).hostname,
};

/** What a card says, as its og:image:alt. */
export const cardAlt = (card: ShareCard): string =>
  `RIVI agentic-seo-check: ${card.title} ${card.accent} ${card.domain}`;
