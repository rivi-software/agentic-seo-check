import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import type { Finding, FixEdit, ResponseInfo } from "../src/core/types.js";
import { incompleteEdits, unquotedEdits, withoutFix } from "./helpers/fixes.js";

/** The page rules issue #77 adds; the structured data and site rules have tests of their own. */
const RULES = [
  "canonical.paginated-to-first",
  "hreflang.canonical-other-language",
  "links.hash-route",
  "robots.unavailable-after",
  "robots.max-image-preview-missing",
  "img.unsupported-format",
];

const PAGE = "https://www.example.com/widgets/blue/";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

const doc = (head: string, body = "<p>Text</p>", lang = "en") =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>Blue widgets for every workshop | Acme</title>${head}</head><body><h1>Blue widgets</h1><a href="/">Home</a>${body}</body></html>`;

const response = (
  url: string,
  headers: Record<string, string> = {}
): ResponseInfo => ({
  status: 200,
  finalUrl: url,
  redirectChain: [],
  timeMs: 50,
  contentType: "text/html; charset=utf-8",
  headers,
});

/**
 * The findings of the rules above on `html`, each with a complete fix that quotes the page as
 * written.
 */
const audit = async (
  html: string,
  options: { url?: string; headers?: Record<string, string> } = {}
): Promise<Finding[]> => {
  const url = options.url ?? PAGE;

  const result = await auditHtml(
    html,
    { url, source: "url", response: response(url, options.headers) },
    { onlyRules: RULES }
  );

  expect(withoutFix(result.findings)).toStrictEqual([]);
  expect(unquotedEdits(result.findings, html)).toStrictEqual([]);
  expect(incompleteEdits(result.findings)).toStrictEqual([]);

  return result.findings;
};

const rulesOf = (findings: Finding[]): string[] => findings.map((f) => f.rule);

/** `html` with each HTML edit of `fix` applied, in turn. */
const applied = (html: string, fix: FixEdit[] | undefined): string => {
  let out = html;

  for (const edit of fix ?? []) {
    if (edit.in === "html" && edit.action === "replace" && edit.current) {
      out = out.replace(edit.current, () => edit.code ?? "");
    }
  }

  return out;
};

describe("the pagination, hash route, robots date, preview and image format rules on the fixtures", () => {
  it.each([
    ["good-page.html", PAGE],
    ["aeo-good-page.html", "https://www.example.com/guides/choose-a-widget/"],
  ])("stay quiet on %s", async (name, url) => {
    await expect(audit(fixture(name), { url })).resolves.toStrictEqual([]);
  });
});

const canonical = (href: string) => `<link rel="canonical" href="${href}">`;

describe("canonical.paginated-to-first", () => {
  it.each([
    ["?page=3", "https://www.example.com/blog/?page=3"],
    ["?paged=2", "https://www.example.com/blog/?paged=2"],
    ["/page/2/", "https://www.example.com/blog/page/2/"],
  ])("fires on %s with the first page as canonical", async (_, url) => {
    const html = doc(canonical("https://www.example.com/blog/"));
    const [found] = await audit(html, { url });

    expect(found?.rule).toBe("canonical.paginated-to-first");
    expect(found?.severity).toBe("warning");
    expect(found?.fix).toStrictEqual([
      expect.objectContaining({
        action: "replace",
        code: canonical(url),
      }),
    ]);
    await expect(
      audit(applied(html, found?.fix), { url })
    ).resolves.toStrictEqual([]);
  });

  it("reads page=1 in the canonical as the first page", async () => {
    const findings = await audit(
      doc(canonical("https://www.example.com/blog/?page=1")),
      { url: "https://www.example.com/blog/?page=2" }
    );

    expect(rulesOf(findings)).toStrictEqual(["canonical.paginated-to-first"]);
  });

  it.each([
    ["page 1 naming the series", "https://www.example.com/blog/?page=1"],
    ["the first page", "https://www.example.com/blog/"],
    ["a page naming itself", "https://www.example.com/blog/?page=3"],
  ])("stays quiet on %s", async (_, url) => {
    const self = url.includes("page=3") ? url : "https://www.example.com/blog/";

    await expect(audit(doc(canonical(self)), { url })).resolves.toStrictEqual(
      []
    );
  });

  it("stays quiet when page 2 names another page than the first", async () => {
    // A view-all page or another listing: canonical.other-page covers it.
    await expect(
      audit(doc(canonical("https://www.example.com/blog/all/")), {
        url: "https://www.example.com/blog/?page=2",
      })
    ).resolves.toStrictEqual([]);
  });
});

describe("hreflang.canonical-other-language", () => {
  const DE = "https://www.example.com/de/widgets/";
  const EN = "https://www.example.com/en/widgets/";

  const set = (canonicalUrl: string) =>
    `<link rel="canonical" href="${canonicalUrl}"><link rel="alternate" hreflang="de" href="${DE}"><link rel="alternate" hreflang="en" href="${EN}"><link rel="alternate" hreflang="x-default" href="${EN}">`;

  it("fires when the German page names the English one as canonical", async () => {
    const html = doc(set(EN), "<p>Text</p>", "de");
    const [found] = await audit(html, { url: DE });

    expect(found).toMatchObject({
      rule: "hreflang.canonical-other-language",
      severity: "warning",
      evidence: { language: "de", canonicalLanguage: "en" },
    });
    expect(found?.fix?.[0]?.code).toBe(`<link rel="canonical" href="${DE}">`);
    await expect(
      audit(applied(html, found?.fix), { url: DE })
    ).resolves.toStrictEqual([]);
  });

  it.each([
    ["a self-referencing canonical", DE, "de"],
    // Not translated yet: the page shows the English text, and its <html lang> says so.
    ["a page whose <html lang> is the canonical's language", EN, "en"],
  ])("stays quiet on %s", async (_, canonicalUrl, lang) => {
    await expect(
      audit(doc(set(canonicalUrl), "<p>Text</p>", lang), { url: DE })
    ).resolves.toStrictEqual([]);
  });

  it("stays quiet when only the region differs", async () => {
    const html = doc(
      `<link rel="canonical" href="https://www.example.com/en-us/"><link rel="alternate" hreflang="en-gb" href="https://www.example.com/en-gb/"><link rel="alternate" hreflang="en-us" href="https://www.example.com/en-us/">`,
      "<p>Text</p>",
      "en-GB"
    );

    await expect(
      audit(html, { url: "https://www.example.com/en-gb/" })
    ).resolves.toStrictEqual([]);
  });
});

describe("links.hash-route", () => {
  it("rewrites hash routes as paths below the app's directory", async () => {
    const html = doc(
      "",
      '<a href="#/products">Products</a><a href="#!/cart">Cart</a><a href="/app/#/settings">Settings</a><a href="#/products">Products</a>'
    );

    const [found] = await audit(html, { url: "https://www.example.com/shop/" });

    expect(found?.rule).toBe("links.hash-route");
    expect(found?.evidence).toMatchObject({ count: 4 });
    expect(found?.fix?.map((e) => e.code)).toStrictEqual([
      '<a href="/shop/products">',
      '<a href="/shop/cart">',
      '<a href="/app/settings">',
    ]);
  });

  it("leaves ordinary fragments and placeholder links alone", async () => {
    await expect(
      audit(
        doc(
          "",
          '<a href="#reviews">Reviews</a><a href="#!">Menu</a><a href="#/">Top</a><h2 id="reviews">Reviews</h2>'
        )
      )
    ).resolves.toStrictEqual([]);
  });

  it("takes routes out of links.missing-fragment", async () => {
    const result = await auditHtml(
      doc("", '<a href="#/products">Products</a><a href="#gone">Gone</a>'),
      { url: PAGE, source: "url", response: response(PAGE) },
      { onlyRules: ["links.missing-fragment", "links.hash-route"] }
    );

    expect(
      result.findings.map((f) => [f.rule, f.evidence?.["fragments"]])
    ).toStrictEqual([
      ["links.hash-route", undefined],
      ["links.missing-fragment", ["#gone"]],
    ]);
  });
});

describe("robots.unavailable-after", () => {
  it("drops a date that has passed from the meta tag and the header", async () => {
    const tag =
      '<meta name="robots" content="index, unavailable_after: Fri, 25 Jun 2010 15:00:00 PST, noarchive">';

    const [found] = await audit(doc(tag), {
      headers: {
        "x-robots-tag": "googlebot: unavailable_after: 2001-01-01, noarchive",
      },
    });

    expect(found).toMatchObject({
      rule: "robots.unavailable-after",
      severity: "warning",
    });
    expect(found?.fix?.map((e) => e.code)).toStrictEqual([
      '<meta name="robots" content="index, noarchive">',
      "X-Robots-Tag: googlebot: noarchive",
    ]);
  });

  it("removes a robots tag that held only the date", async () => {
    const tag =
      '<meta name="googlebot" content="unavailable_after: 2020-09-21">';

    const [found] = await audit(doc(tag));

    expect(found?.fix).toStrictEqual([
      expect.objectContaining({ action: "remove", current: tag }),
    ]);
  });

  it("asks for an ISO 8601 date in place of one it cannot read", async () => {
    const [found] = await audit(
      doc(
        '<meta name="robots" content="noarchive, unavailable_after: 31/12/2099">'
      )
    );

    expect(found).toMatchObject({ severity: "info" });
    expect(found?.fix?.[0]?.code).toBe(
      '<meta name="robots" content="noarchive, unavailable_after: {{date in ISO 8601, e.g. 2026-12-31}}">'
    );
  });

  it.each([
    [
      "a date to come",
      '<meta name="robots" content="unavailable_after: 2999-01-01">',
    ],
    [
      "another crawler's tag",
      '<meta name="bingbot" content="unavailable_after: 2001-01-01">',
    ],
  ])("stays quiet on %s", async (_, tag) => {
    await expect(audit(doc(tag))).resolves.toStrictEqual([]);
  });

  it("stays quiet on a header for another crawler", async () => {
    await expect(
      audit(doc(""), {
        headers: { "x-robots-tag": "otherbot: unavailable_after: 2001-01-01" },
      })
    ).resolves.toStrictEqual([]);
  });
});

describe("robots.max-image-preview-missing", () => {
  const article =
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Blue widgets"}</script>';

  it("adds max-image-preview:large to the robots tag of an article", async () => {
    const html = doc(`${article}<meta name="robots" content="index, follow">`);
    const [found] = await audit(html);

    expect(found).toMatchObject({
      rule: "robots.max-image-preview-missing",
      severity: "info",
    });
    expect(found?.fix?.[0]?.code).toBe(
      '<meta name="robots" content="index, follow, max-image-preview:large">'
    );
    await expect(audit(applied(html, found?.fix))).resolves.toStrictEqual([]);
  });

  it("adds a robots tag to an article page by og:type", async () => {
    const [found] = await audit(
      doc('<meta property="og:type" content="article">')
    );

    expect(found?.fix).toStrictEqual([
      expect.objectContaining({
        action: "add",
        at: "head",
        code: '<meta name="robots" content="max-image-preview:large">',
      }),
    ]);
  });

  it("reads an article that is a page's mainEntity", async () => {
    const page =
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","mainEntity":{"@type":"NewsArticle","headline":"Blue widgets"}}</script>';

    await expect(audit(doc(page))).resolves.toStrictEqual([
      expect.objectContaining({ rule: "robots.max-image-preview-missing" }),
    ]);
  });

  it.each([
    ["a page that is no article", ""],
    [
      "a listing that links articles",
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@type":"BlogPosting","headline":"One","url":"https://www.example.com/one/"}}]}</script>',
    ],
    [
      "a chosen preview size",
      `${article}<meta name="robots" content="max-image-preview:standard">`,
    ],
    ["a noindex page", `${article}<meta name="robots" content="noindex">`],
  ])("stays quiet on %s", async (_, head) => {
    await expect(audit(doc(head))).resolves.toStrictEqual([]);
  });

  it("stays quiet on an AMP article and on one the header allows", async () => {
    await expect(
      audit(doc(article).replace('<html lang="en">', '<html amp lang="en">'))
    ).resolves.toStrictEqual([]);
    await expect(
      audit(doc(article), {
        headers: { "x-robots-tag": "max-image-preview:large" },
      })
    ).resolves.toStrictEqual([]);
  });
});

describe("img.unsupported-format", () => {
  it("converts HEIC and TIFF images to WebP, keeping the query", async () => {
    const html = doc(
      "",
      '<img src="/photos/IMG_1.HEIC?w=800" alt="A blue widget"><img src="scan.tiff" alt="A scan"><img src="/a.webp" alt="A"><img src="/b.avif" alt="B">'
    );

    const [found] = await audit(html);

    expect(found).toMatchObject({
      rule: "img.unsupported-format",
      severity: "info",
      evidence: { count: 2 },
    });
    expect(found?.fix).toStrictEqual([
      expect.objectContaining({
        in: "asset",
        url: "https://www.example.com/photos/IMG_1.HEIC?w=800",
        at: "whole file",
      }),
      expect.objectContaining({
        in: "html",
        code: '<img src="/photos/IMG_1.webp?w=800" alt="A blue widget">',
      }),
      expect.objectContaining({
        in: "asset",
        url: "https://www.example.com/widgets/blue/scan.tiff",
      }),
      expect.objectContaining({
        in: "html",
        code: '<img src="scan.webp" alt="A scan">',
      }),
    ]);
  });

  it("stays quiet on formats Google Images reads and on data URIs", async () => {
    await expect(
      audit(
        doc(
          "",
          '<img src="/a.jpg" alt="A"><img src="/b.svg" alt="B"><img src="data:image/tiff;base64,AAAA" alt="C"><img src="/heic/photo.png" alt="D">'
        )
      )
    ).resolves.toStrictEqual([]);
  });
});
