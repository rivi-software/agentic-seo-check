/**
 * RIVI Software's name, site and mark as the CLI, the MCP server and the Markdown report show
 * them. The marks are copies of assets/rivi-mark.svg and assets/rivi-mark-on-dark.svg, inlined
 * because npm ships dist/ without assets/.
 */
import type { Icon } from "@modelcontextprotocol/sdk/types.js";

export const MAKER = "RIVI Software";
export const MAKER_URL = "https://rivi.software";

export const REPOSITORY_URL =
  "https://github.com/rivi-software/agentic-seo-check";

const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" role="img" aria-label="RIVI Software"><rect width="40" height="40" rx="9" fill="#15171a"/><g fill="#f5f6f7"><rect x="8" y="16" width="3" height="8" rx="1.5"/><rect x="13.25" y="11" width="3" height="18" rx="1.5"/><rect x="18.5" y="7" width="3" height="26" rx="1.5" fill="#3be08a"/><rect x="23.75" y="12" width="3" height="16" rx="1.5"/><rect x="29" y="16" width="3" height="8" rx="1.5"/></g></svg>';

const MARK_ON_DARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" role="img" aria-label="RIVI Software"><rect width="40" height="40" rx="9" fill="#f5f6f7"/><g fill="#15171a"><rect x="8" y="16" width="3" height="8" rx="1.5"/><rect x="13.25" y="11" width="3" height="18" rx="1.5"/><rect x="18.5" y="7" width="3" height="26" rx="1.5" fill="#0e9f55"/><rect x="23.75" y="12" width="3" height="16" rx="1.5"/><rect x="29" y="16" width="3" height="8" rx="1.5"/></g></svg>';

const dataUri = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;

/** The mark as MCP icons: the ink tile for light themes, the light tile for dark ones. */
export const MCP_ICONS: Icon[] = [
  {
    mimeType: "image/svg+xml",
    sizes: ["any"],
    src: dataUri(MARK_SVG),
    theme: "light",
  },
  {
    mimeType: "image/svg+xml",
    sizes: ["any"],
    src: dataUri(MARK_ON_DARK_SVG),
    theme: "dark",
  },
];
