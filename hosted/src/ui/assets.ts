/**
 * The files both hostnames serve beside their pages: the fonts rivi.software sets its pages in, as
 * Latin subsets under the SIL OFL 1.1 (Bricolage Grotesque for the headings,
 * assets/bricolage-grotesque-OFL.txt; Geist and Geist Mono for the rest, assets/geist-OFL.txt),
 * and each hostname's share image (ui/og.ts). Wrangler bundles their bytes (the Data rule in each
 * Worker's configuration). Only the routes import this module: Node runs the pages' tests and cannot
 * import a font or an image.
 */
import bricolage from "../../assets/bricolage-grotesque-latin.woff2";
import geist from "../../assets/geist-latin.woff2";
import geistMono from "../../assets/geist-mono-latin.woff2";
import serverCard from "../../assets/og-mcp.png";
import siteCard from "../../assets/og-site.png";
import { FONT_PATHS } from "./style.js";

const FONTS = new Map<string, ArrayBuffer>([
  [FONT_PATHS.display, bricolage],
  [FONT_PATHS.sans, geist],
  [FONT_PATHS.mono, geistMono],
]);

/** The font at `path` with the headers of a file that never changes, or null when there is none. */
export const fontResponse = (
  request: Request,
  path: string
): Response | null => {
  const font = FONTS.get(path);

  return font
    ? new Response(request.method === "HEAD" ? null : font, {
        headers: {
          "content-type": "font/woff2",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      })
    : null;
};

/**
 * The share image of the website or of the hosted server. It keeps its address when the card is
 * drawn again, so caches keep it for a day only.
 */
export const shareImageResponse = (
  request: Request,
  card: "site" | "server"
): Response => {
  const image = card === "site" ? siteCard : serverCard;

  return new Response(request.method === "HEAD" ? null : image, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
};
