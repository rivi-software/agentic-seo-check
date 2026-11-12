/**
 * What a report's PDF needs in the browser (issue #157), which only the website serves: pdfmake's
 * browser build, copied to .generated/pdfmake.txt before each build (scripts/pdfmake.ts, which
 * leaves out its source map line) so that Wrangler bundles it as text, followed by the code that
 * draws the PDF (pdf-script.ts) as `drawReportPdf`, at /pdfmake.js; and the PDF's fonts under
 * PDF_FONT_DIR, static TrueType instances of Geist, Geist Mono and Bricolage Grotesque
 * (assets/pdf/, SIL OFL 1.1). The page loads them on the first click of "Download PDF" only. Only
 * the routes import this module: Node runs the pages' tests and cannot import a font file or the
 * generated text.
 */
import PDFMAKE from "../../.generated/pdfmake.txt";
import bricolage600 from "../../assets/pdf/bricolage-grotesque-600.ttf";
import geist400 from "../../assets/pdf/geist-400.ttf";
import geist500 from "../../assets/pdf/geist-500.ttf";
import geist600 from "../../assets/pdf/geist-600.ttf";
import geistMono400 from "../../assets/pdf/geist-mono-400.ttf";
import { freshResponse } from "../fresh.js";
import { PDFMAKE_PATH } from "./files.js";
import { DRAW_PDF } from "./pdf-script.js";
import { PDF_FONT_DIR } from "./pdf.js";

/** pdfmake, then `drawReportPdf(report)`, which draws with it and this site's fonts. */
const SCRIPT = `${PDFMAKE}
;globalThis.drawReportPdf = (report) =>
  (${DRAW_PDF})(globalThis.pdfMake, report, location.origin + ${JSON.stringify(PDF_FONT_DIR)});
`;

/** The files PDF_FONTS names (pdf.ts), by name. */
const FONTS = new Map<string, ArrayBuffer>([
  ["geist-400.ttf", geist400],
  ["geist-500.ttf", geist500],
  ["geist-600.ttf", geist600],
  ["geist-mono-400.ttf", geistMono400],
  ["bricolage-grotesque-600.ttf", bricolage600],
]);

/**
 * pdfmake or one of the PDF's fonts at `path`, or null when it is neither. /pdfmake.js keeps its
 * address when a deploy changes it, so browsers ask for it on every visit (fresh.ts, issue #160);
 * a font never changes under its name, as the pages' fonts do not (ui/assets.ts): one cut again
 * takes a new one.
 */
export const pdfAssetResponse = (
  request: Request,
  path: string
): Response | Promise<Response> | null => {
  if (path === PDFMAKE_PATH) {
    return freshResponse(request, SCRIPT, {
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
  }

  const font = path.startsWith(PDF_FONT_DIR)
    ? FONTS.get(path.slice(PDF_FONT_DIR.length))
    : undefined;

  return font
    ? new Response(request.method === "HEAD" ? null : font, {
        headers: {
          "content-type": "font/ttf",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      })
    : null;
};
