/**
 * A report's PDF (issue #157): the document pdf.ts builds, drawn by the code the website serves
 * to draw it (pdf-script.ts) with pdfmake in Node, from a page's report and a site's. Set PDF_OUT
 * to a directory to keep the files and look at them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInThisContext } from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditAeoHtml, auditSiteBoth } from "../../src/core/aeo/audit.ts";
import { auditHtml } from "../../src/core/audit.ts";
import type { Finding } from "../../src/core/types.ts";
import { startFixtureServer } from "../../test/helpers/fixture-server.ts";
import type { FixtureServer } from "../../test/helpers/fixture-server.ts";
import { MISSING_GLYPHS } from "../src/site/pdf-glyphs.ts";
import { DRAW_PDF } from "../src/site/pdf-script.ts";
import { PDF_DESIGN, PDF_FONTS, quote } from "../src/site/pdf.ts";
import type { PdfNode, PdfReport } from "../src/site/pdf.ts";
import { renderReport } from "../src/site/report.ts";
import { renderSiteReport } from "../src/site/site-report.ts";

const FONT_DIR = new URL("../assets/pdf/", import.meta.url).pathname;

interface OutputDocument {
  getBuffer: () => Promise<Buffer>;
}

/** What the test asks of pdfmake itself; the page's code asks the rest. */
interface PdfMake {
  setUrlAccessPolicy: (policy: (url: string) => boolean) => void;
  setLocalAccessPolicy: (policy: (path: string) => boolean) => void;
}

type Draw = (
  pdfMake: PdfMake,
  report: PdfReport,
  fontBase: string
) => OutputDocument;

// pdfmake's Node build is CommonJS: an instance with the browser build's methods.
// SAFETY: pdfmake 0.3's Node entry exports that instance, which has both policies (js/index.js).
const pdfMake = createRequire(import.meta.url)("pdfmake") as PdfMake;

// The code that draws the PDF, as the browser runs it from /pdfmake.js: the site's own source,
// never text from a page.
// SAFETY: DRAW_PDF is the source of a function of pdfmake, a PdfReport and the fonts' location.
const draw = runInThisContext(`(${DRAW_PDF})`) as Draw;

/** The report's data as the page's script reads it, from the HTML the website serves. */
const dataOf = (html: string): { pdf: PdfReport; name: string } => {
  const json =
    /<script type="application\/json" id="report-data">(?<json>.*?)<\/script>/su.exec(
      html
    )?.groups?.json;

  return JSON.parse(json ?? "null");
};

/** The PDF of `report`, drawn as the page draws it, with the fonts from assets/pdf/. */
const render = async (report: PdfReport, name: string): Promise<Buffer> => {
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy((file) => file.startsWith(FONT_DIR));

  const pdf = await draw(pdfMake, report, FONT_DIR).getBuffer();

  if (process.env.PDF_OUT) {
    mkdirSync(process.env.PDF_OUT, { recursive: true });
    writeFileSync(path.join(process.env.PDF_OUT, `${name}.pdf`), pdf);
  }

  return pdf;
};

/** How many pages a PDF has: pdfkit writes each page object's dictionary uncompressed. */
const pagesOf = (pdf: Buffer): number =>
  pdf.toString("latin1").match(/\/Type \/Page\b/gu)?.length ?? 0;

/** Every value of `key` anywhere in the document, as JSON has it. */
const valuesOf = (
  node: PdfNode | undefined,
  key: string
): (PdfNode | undefined)[] => {
  const found: (PdfNode | undefined)[] = [];

  JSON.stringify(node, (name: string, value: PdfNode | undefined) => {
    if (name === key) {
      found.push(value);
    }

    return value;
  });

  return found;
};

/** Whether `text` is in the document as one run. */
const hasText = (node: PdfNode | undefined, text: string): boolean =>
  JSON.stringify(node).includes(JSON.stringify(text).slice(1, -1));

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../test/fixtures/${name}`, import.meta.url),
    "utf-8"
  );

describe("a page's PDF", () => {
  const url = "https://shop.example.com/pricing";
  let html: string;
  let report: PdfReport;
  let pdf: Buffer;
  let findings: Finding[];

  beforeAll(async () => {
    const page = fixture("bad-page.html");
    const seo = await auditHtml(page, { url, source: "url", target: url });
    const aeo = await auditAeoHtml(page, { url });

    findings = [...seo.findings, ...aeo.findings];
    html = renderReport(seo, aeo);
    ({ pdf: report } = dataOf(html));
    pdf = await render(report, "page");
  });

  it("is a PDF of a cover, the contents, the summary, both audits' findings, the crawlers and what it is", () => {
    const { content } = report.document;

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pagesOf(pdf)).toBeGreaterThan(8);
    expect(
      [
        "PAGE AUDIT REPORT",
        "shop.example.com",
        "Contents",
        "At a glance",
        "Fix first",
        "Findings by section",
        "SEO findings",
        "AEO findings",
        "About this report",
      ].filter((part) => !hasText(content, part))
    ).toStrictEqual([]);
  });

  it("has every finding, with what to change, and links each one to fix first to it", () => {
    const { content } = report.document;
    const ids = new Set(valuesOf(content, "id"));
    const targets = valuesOf(content, "linkToDestination");

    expect(findings.length).toBeGreaterThan(20);
    expect(
      findings.filter(
        (finding) =>
          !hasText(content, finding.message) ||
          !hasText(content, finding.recommendation)
      )
    ).toStrictEqual([]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !ids.has(target))).toStrictEqual([]);
  });

  it("names the PDF's own fonts only, and links to http and https addresses only", () => {
    const fonts = new Set(
      valuesOf([report.document, PDF_DESIGN.document], "font")
    );

    const links = valuesOf(report.document.content, "link");

    expect(
      [...fonts].filter((font) => !(String(font) in PDF_FONTS))
    ).toStrictEqual([]);
    expect(links.length).toBeGreaterThan(0);
    expect(
      links.filter((link) => !/^https?:\/\//u.test(String(link)))
    ).toStrictEqual([]);
    expect(valuesOf(report.document.content, "image")).toStrictEqual([]);
  });

  it("is in the page's data beside the JSON and the Markdown, with the button that downloads it", () => {
    expect(html).toContain(
      '<button class="btn btn-secondary btn-sm" type="button" data-report="pdf">'
    );
    expect(html).toContain('<span class="btn-label">Download PDF</span>');
    expect(dataOf(html).name).toBe("shop.example.com");
  });
});

describe("a site's PDF", () => {
  let server: FixtureServer;
  let report: PdfReport;
  let pdf: Buffer;

  beforeAll(async () => {
    server = await startFixtureServer({
      "/": {
        body: fixture("bad-page.html").replace(
          "</body>",
          '<a href="/about">About</a></body>'
        ),
      },
      "/about": {
        body: '<!doctype html><html lang="en"><head><title>About the fixture</title></head><body><h1>About</h1><a href="/">Home</a><a href="/gone">Gone</a></body></html>',
      },
    });

    const audits = await auditSiteBoth(server.origin, {
      maxPages: 5,
      pageDetail: "summary",
    });

    ({ pdf: report } = dataOf(renderSiteReport(audits)));
    pdf = await render(report, "site");
  });

  afterAll(async () => {
    await server.close();
  });

  it("has the crawl, the findings across the site and on the pages, the homepage and the pages", () => {
    const { content } = report.document;

    expect(pagesOf(pdf)).toBeGreaterThan(8);
    expect(
      [
        "SITE AUDIT REPORT",
        "The crawl",
        "Across the site",
        "On the pages, by rule",
        "The homepage",
        "The pages",
        `${server.origin}/about`,
      ].filter((part) => !hasText(content, part))
    ).toStrictEqual([]);
  });
});

describe("text from the audited site in the PDF", () => {
  it("is kept as written where the fonts draw it", () => {
    expect(
      quote('<title>Zürich — Ünïcødé, Привет</title>\n  <meta name="x">')
    ).toBe('<title>Zürich — Ünïcødé, Привет</title>\n  <meta name="x">');
  });

  it("marks each run of characters the fonts lack, rather than leave it out", () => {
    expect(quote("Tokyo 東京駅 guide 🚀✨ now")).toStrictEqual([
      "Tokyo ",
      { text: "?", style: "missing" },
      " guide ",
      { text: "?", style: "missing" },
      " now",
    ]);
  });

  it("leaves out what nobody sees, and keeps line breaks", () => {
    expect(quote("a\u0000b​c­d\r\ne\tf")).toBe("abcd\ne  f");
  });
});

describe("the PDF's list of the characters its fonts draw", () => {
  it("is every character that all four Geist files have, and no other", () => {
    // fontkit reads the fonts as pdfmake does; it comes with pdfmake, through pdfkit.
    const fromPdfmake = createRequire(
      createRequire(import.meta.url).resolve("pdfmake")
    );

    // SAFETY: fontkit 2's CommonJS entry exports openSync, which returns a font with its cmap's
    // code points as characterSet.
    const fontkit = createRequire(fromPdfmake.resolve("pdfkit"))("fontkit") as {
      openSync: (file: string) => { characterSet: number[] };
    };

    const sets = Object.values(PDF_FONTS)
      .flatMap((font) => [font.normal, font.bold])
      .filter((file) => file.startsWith("geist"))
      .map(
        (file) =>
          new Set(fontkit.openSync(path.join(FONT_DIR, file)).characterSet)
      );

    const drawn = (code: number) => sets.every((set) => set.has(code));
    const missing = new RegExp(MISSING_GLYPHS.source, "u");
    const wrong: number[] = [];

    // The Basic Multilingual Plane past the controls, less the surrogates, and short of U+FFFE and
    // U+FFFF, which are no characters (a cmap ends with U+FFFF, which fontkit lists).
    for (let code = 0x20; code < 0xff_fe; code += 1) {
      if (
        (code < 0xd8_00 || code > 0xdf_ff) &&
        missing.test(String.fromCodePoint(code)) === drawn(code)
      ) {
        wrong.push(code);
      }
    }

    expect(wrong.map((code) => code.toString(16))).toStrictEqual([]);
  });
});
