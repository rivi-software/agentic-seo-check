/**
 * The tool's name and icon, and RIVI Software's name and site, as the CLI, the MCP server, the
 * website and the reports show them. The marks are copies of assets/icon.svg and
 * assets/icon-on-dark.svg, inlined because npm ships dist/ without assets/.
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
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" role="img" aria-label="Agentic SEO Check"><rect width="40" height="40" rx="9" fill="#15171a"/><g fill="none" stroke="#f5f6f7" stroke-linecap="round"><circle cx="17.5" cy="17.5" r="9.4" stroke-width="3"/><path d="M24.6 24.6 L31.2 31.2" stroke-width="3.5"/></g><path d="M17.5 11.3 C18.1 15.1 19.9 16.9 23.7 17.5 C19.9 18.1 18.1 19.9 17.5 23.7 C16.9 19.9 15.1 18.1 11.3 17.5 C15.1 16.9 16.9 15.1 17.5 11.3 Z" fill="#3be08a"/></svg>';

/** The icon on a dark ground: the light tile, as the website's header and a PDF report's cover draw it. */
export const MARK_ON_DARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" role="img" aria-label="Agentic SEO Check"><rect width="40" height="40" rx="9" fill="#f5f6f7"/><g fill="none" stroke="#15171a" stroke-linecap="round"><circle cx="17.5" cy="17.5" r="9.4" stroke-width="3"/><path d="M24.6 24.6 L31.2 31.2" stroke-width="3.5"/></g><path d="M17.5 11.3 C18.1 15.1 19.9 16.9 23.7 17.5 C19.9 18.1 18.1 19.9 17.5 23.7 C16.9 19.9 15.1 18.1 11.3 17.5 C15.1 16.9 16.9 15.1 17.5 11.3 Z" fill="#0e9f55"/></svg>';

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
