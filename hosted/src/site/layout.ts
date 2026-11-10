/**
 * The frame of every page of the website (issue #39): the shared frame of both hostnames
 * (ui/frame.ts) on the website's own, whose header offers the hosted MCP server.
 */
import { ORIGIN as MCP_ORIGIN, SITE_ORIGIN } from "../limits.js";
import { frame } from "../ui/frame.js";
import type { FramePage } from "../ui/frame.js";
import { SITE_CARD } from "../ui/og.js";

export { SITE_ORIGIN } from "../limits.js";

export { NPM_URL, publisher } from "../ui/frame.js";

export const SITE_HOST = new URL(SITE_ORIGIN).hostname;

/** The hosted MCP server's own page, which says how to add it to an assistant. */
export const HOSTED_PAGE = `${MCP_ORIGIN}/`;

export type SitePage = FramePage;

const SITE = {
  origin: SITE_ORIGIN,
  action: { href: `${HOSTED_PAGE}#add`, label: "Add to your assistant" },
  card: SITE_CARD,
};

export const layout = (page: SitePage): string => frame(SITE, page);
