/**
 * The tool's name, and RIVI Software's name, site and mark, as the CLI, the MCP server and the Markdown report show
 * them. The marks are copies of assets/rivi-mark.svg and assets/rivi-mark-on-dark.svg, inlined
 * because npm ships dist/ without assets/.
 */
import type { Icon } from "@modelcontextprotocol/sdk/types.js";

/**
 * The tool's name in text: titles, prose, the lockup. Identifiers keep `agentic-seo-check`: the
 * package, the commands, the MCP server's name, the User-Agent tokens and the repository.
 */
export const PRODUCT_NAME = "Agentic SEO Check";

/** The MCP server's `name`, the same for the local and the hosted server. */
export const MCP_SERVER_NAME = "agentic-seo-check";

export const MAKER = "RIVI Software";
export const MAKER_URL = "https://rivi.software";

export const REPOSITORY_URL =
  "https://github.com/rivi-software/agentic-seo-check";

/**
 * The project's website, with the page audit and the rules page (hosted/src/site/), and the hosted
 * MCP server at /mcp on the same hostname (issue #168).
 */
export const WEBSITE_URL = "https://agentic-seo.org";

/** The hosted MCP server's address, which is also its page for a browser. */
export const MCP_URL = `${WEBSITE_URL}/mcp`;

export const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" role="img" aria-label="RIVI Software"><rect width="40" height="40" rx="9" fill="#15171a"/><g fill="#f5f6f7"><rect x="8" y="16" width="3" height="8" rx="1.5"/><rect x="13.25" y="11" width="3" height="18" rx="1.5"/><rect x="18.5" y="7" width="3" height="26" rx="1.5" fill="#3be08a"/><rect x="23.75" y="12" width="3" height="16" rx="1.5"/><rect x="29" y="16" width="3" height="8" rx="1.5"/></g></svg>';

/** The mark on a dark ground: the light tile, as rivi.software's header and a PDF report's cover draw it. */
export const MARK_ON_DARK_SVG =
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
