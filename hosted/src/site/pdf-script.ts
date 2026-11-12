/**
 * The code that draws a report's PDF (issue #157): the source of a function of pdfmake, a
 * report's PdfReport (pdf.ts) and `fontBase`, where the font files are. It carries PDF_DESIGN,
 * what every report's PDF shares, adds what pdfmake takes as functions (the table layouts, the
 * cover's ground, the head and foot of each page, and the page breaks that keep a heading with
 * what follows it), lets pdfmake fetch the fonts and nothing else, and returns pdfmake's document.
 * The website serves it after pdfmake at /pdfmake.js (pdf-assets.ts), so a page loads it on the
 * first "Download PDF" only, and the tests run the same source with pdfmake in Node
 * (test/pdf.test.ts).
 */
import { PDF_DESIGN } from "./pdf.js";

export const DRAW_PDF = `(pdfMake, report, fontBase) => {
  const DESIGN = ${JSON.stringify(PDF_DESIGN)};

  // A table layout's lines and padding (pdf.ts's TableLayout) as pdfmake's functions of a line.
  const layout = (spec) => {
    const across = (i, node) =>
      (i === 0 || i === node.table.body.length ? spec.frame : spec.rows) || null;
    const down = (i, node) =>
      (i === 0 && spec.bar) ||
      (i === 0 || i === node.table.widths.length ? spec.frame : spec.cols) ||
      null;

    return {
      hLineWidth: (i, node) => (across(i, node) || [0])[0],
      hLineColor: (i, node) => (across(i, node) || [0, "#ffffff"])[1],
      vLineWidth: (i, node) => (down(i, node) || [0])[0],
      vLineColor: (i, node) => (down(i, node) || [0, "#ffffff"])[1],
      paddingLeft: () => spec.padding[0],
      paddingTop: () => spec.padding[1],
      paddingRight: () => spec.padding[2],
      paddingBottom: () => spec.padding[3],
    };
  };

  const layouts = {};

  for (const [name, spec] of Object.entries(DESIGN.layouts)) {
    layouts[name] = layout(spec);
  }

  const fonts = {};

  for (const [name, files] of Object.entries(DESIGN.fonts)) {
    fonts[name] = {
      normal: fontBase + files.normal,
      bold: fontBase + files.bold,
      italics: fontBase + files.normal,
      bolditalics: fontBase + files.bold,
    };
  }

  pdfMake.addFonts(fonts);
  pdfMake.addTableLayouts(layouts);
  // The fonts only, which pdfmake keeps for the next PDF.
  pdfMake.setUrlAccessPolicy((url) => url.startsWith(fontBase));
  pdfMake.setUrlResourceCaching(true);

  // The head or foot with its page number: the report's own text, which names no page.
  const numbered = (node, page, pages) =>
    JSON.parse(
      JSON.stringify(node)
        .replaceAll("{page}", String(page))
        .replaceAll("{pages}", String(pages))
    );

  // A heading that only its own parts follow on its page would end the page: it starts the next
  // one instead, unless it starts its page already.
  const alone = (node, nodes) =>
    node.headlineLevel === 1 &&
    nodes.getPreviousNodesOnPage().length > 0 &&
    nodes.getFollowingNodesOnPage().every((next) => next.headlineLevel === 1);

  return pdfMake.createPdf({
    ...DESIGN.document,
    ...report.document,
    background: (page, size) =>
      page === 1
        ? { svg: DESIGN.cover, width: size.width, absolutePosition: { x: 0, y: 0 } }
        : null,
    header: (page, pages) => (page === 1 ? null : numbered(report.header, page, pages)),
    footer: (page, pages) =>
      page === 1 ? DESIGN.coverFooter : numbered(DESIGN.footer, page, pages),
    pageBreakBefore: alone,
  });
}`;
