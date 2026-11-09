import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import { canonicalRules } from "../src/core/rules/canonical.js";
import { documentRules } from "../src/core/rules/document.js";
import { headRules } from "../src/core/rules/head.js";
import { headingRules } from "../src/core/rules/headings.js";
import { hreflangRules } from "../src/core/rules/hreflang.js";
import { imageRules } from "../src/core/rules/images.js";
import { indexingRules } from "../src/core/rules/indexing.js";
import { linkRules } from "../src/core/rules/links.js";
import type { Finding, ResponseInfo } from "../src/core/types.js";
import { incompleteEdits, unquotedEdits, withoutFix } from "./helpers/fixes.js";

/** The rules this file covers; other rules' fixes are tested with their own files. */
const RULES = new Set(
  [
    ...canonicalRules,
    ...documentRules,
    ...headRules,
    ...headingRules,
    ...hreflangRules,
    ...imageRules,
    ...indexingRules,
    ...linkRules,
  ].map((r) => r.meta.id)
);

const URL_ = "https://www.example.com/widgets/blue/";

const response = (headers: Record<string, string> = {}): ResponseInfo => ({
  status: 200,
  finalUrl: URL_,
  redirectChain: [],
  timeMs: 50,
  contentType: "text/html; charset=utf-8",
  headers,
});

const doc = (head: string, body = "<p>Text</p>", html = '<html lang="en">') =>
  `<!doctype html>${html}<head><meta charset="utf-8"><title>Blue widgets for every workshop | Acme</title>${head}</head><body><h1>Blue widgets</h1><a href="/">Home</a>${body}</body></html>`;

/**
 * Audits `html` and checks the fixes of this file's rules: every finding has one, every quote is
 * in the source, every edit is complete.
 */
const audit = async (
  html: string,
  options: {
    url?: string;
    headers?: Record<string, string>;
    file?: boolean;
  } = {}
): Promise<Finding[]> => {
  // A file has no response, so no Content-Type header declares its charset.
  const result = await auditHtml(
    html,
    options.file
      ? { url: options.url ?? URL_, source: "file" }
      : {
          url: options.url ?? URL_,
          source: "url",
          response: response(options.headers),
        }
  );

  const mine = result.findings.filter((f) => RULES.has(f.rule));
  expect(withoutFix(mine)).toStrictEqual([]);
  expect(unquotedEdits(mine, html)).toStrictEqual([]);
  expect(incompleteEdits(mine)).toStrictEqual([]);

  return mine;
};

const fixOf = (findings: Finding[], rule: string) =>
  findings.find((f) => f.rule === rule)?.fix;

describe("canonical fixes", () => {
  it("adds a self-referencing canonical without tracking parameters", async () => {
    const findings = await audit(doc(""), {
      url: `${URL_}?utm_source=mail`,
    });

    expect(fixOf(findings, "canonical.missing")).toMatchObject([
      {
        in: "html",
        action: "add",
        at: "head",
        code: `<link rel="canonical" href="${URL_}">`,
      },
    ]);
  });

  it("leaves the origin to the author on a local URL", async () => {
    const findings = await audit(doc(""), {
      url: "http://localhost:3000/widgets/",
    });

    expect(fixOf(findings, "canonical.missing")).toMatchObject([
      {
        code: '<link rel="canonical" href="{{production origin}}/widgets/">',
        write: expect.stringContaining("production origin"),
      },
    ]);
  });

  it("keeps the <link> and drops the header's canonical, keeping its other entries", async () => {
    const findings = await audit(doc(`<link rel="canonical" href="${URL_}">`), {
      headers: {
        link: '</a.css>; rel=preload; as=style, <https://www.example.com/other>; rel="canonical"',
      },
    });

    expect(fixOf(findings, "canonical.header-conflict")).toMatchObject([
      {
        in: "http",
        action: "replace",
        at: "Link",
        current:
          'Link: </a.css>; rel=preload; as=style, <https://www.example.com/other>; rel="canonical"',
        code: "Link: </a.css>; rel=preload; as=style",
      },
    ]);
  });

  it("removes the canonicals that do not name this page", async () => {
    const findings = await audit(
      doc(
        `<link rel="canonical" href="https://www.example.com/a"><link rel="canonical" href="${URL_}">`
      )
    );

    expect(fixOf(findings, "canonical.multiple")).toStrictEqual([
      {
        in: "html",
        action: "remove",
        at: 'head > link[rel="canonical"]',
        current: '<link rel="canonical" href="https://www.example.com/a">',
      },
    ]);
  });

  it("makes a relative, insecure or invalid canonical absolute", async () => {
    const relative = await audit(
      doc('<link rel="canonical" href="/widgets/blue/">')
    );

    expect(fixOf(relative, "canonical.relative")).toMatchObject([
      {
        action: "replace",
        current: '<link rel="canonical" href="/widgets/blue/">',
        code: `<link rel="canonical" href="${URL_}">`,
      },
    ]);

    const insecure = await audit(
      doc('<link rel="canonical" href="http://www.example.com/widgets/blue/">')
    );

    expect(fixOf(insecure, "canonical.protocol-mismatch")).toMatchObject([
      { code: `<link rel="canonical" href="${URL_}">` },
    ]);

    const invalid = await audit(doc('<link rel="canonical" href="">'));

    expect(fixOf(invalid, "canonical.invalid")).toMatchObject([
      { code: `<link rel="canonical" href="${URL_}">` },
    ]);
  });

  it("points a canonical at another page back here only if the page should rank", async () => {
    const findings = await audit(
      doc('<link rel="canonical" href="https://www.example.com/widgets/">')
    );

    expect(fixOf(findings, "canonical.other-page")).toMatchObject([
      {
        code: `<link rel="canonical" href="${URL_}">`,
        write: expect.stringContaining("Only if this page should rank"),
      },
    ]);
  });
});

describe("document fixes", () => {
  it("adds the doctype, language, viewport and charset a bare page lacks", async () => {
    const html =
      "<html><head><title>Blue widgets for every workshop | Acme</title></head><body><h1>Blue widgets</h1><a href='/'>Home</a></body></html>";

    const findings = await audit(html, { file: true });

    expect(fixOf(findings, "doctype.missing")).toMatchObject([
      { action: "add", at: "document start", code: "<!doctype html>" },
    ]);
    expect(fixOf(findings, "html.lang-missing")).toMatchObject([
      {
        action: "replace",
        current: "<html>",
        code: '<html lang="{{language code}}">',
      },
    ]);
    expect(fixOf(findings, "viewport.missing")).toMatchObject([
      {
        action: "add",
        at: "head",
        code: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      },
    ]);
    expect(fixOf(findings, "charset.missing")).toMatchObject([
      { action: "add", at: "head", code: '<meta charset="utf-8">' },
    ]);
  });

  it("hyphenates a locale-style lang and leaves an unknown one to the author", async () => {
    const underscore = await audit(doc("", "<p>x</p>", '<html lang="en_US">'));

    expect(fixOf(underscore, "html.lang-invalid")).toMatchObject([
      { current: '<html lang="en_US">', code: '<html lang="en-US">' },
    ]);

    const word = await audit(doc("", "<p>x</p>", '<html lang="english">'));

    expect(fixOf(word, "html.lang-invalid")).toMatchObject([
      { code: '<html lang="{{language code}}">', write: expect.any(String) },
    ]);
  });

  it("lets users zoom again and keeps the rest of the viewport", async () => {
    const findings = await audit(
      doc(
        '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">'
      )
    );

    expect(fixOf(findings, "viewport.not-scalable")).toMatchObject([
      {
        code: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      },
    ]);
  });

  it("moves inline weight out of a very large page", async () => {
    const findings = await audit(
      doc(
        "",
        `<script>window.__STATE__=${JSON.stringify("x".repeat(1_600_000))}</script>`
      )
    );

    expect(fixOf(findings, "document.html-too-large")).toMatchObject([
      { action: "add", at: "body", write: expect.stringContaining("inline") },
    ]);
  });
});

describe("head fixes", () => {
  it("moves what ended <head> to the start of <body>", async () => {
    const findings = await audit(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><img src="/pixel.gif"><title>Blue widgets for every workshop | Acme</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Blue widgets</h1><a href="/">Home</a></body></html>'
    );

    expect(fixOf(findings, "head.closed-early")).toStrictEqual([
      {
        in: "html",
        action: "remove",
        at: "head",
        current: '<img src="/pixel.gif">',
      },
      {
        in: "html",
        action: "add",
        at: "body",
        code: '<img src="/pixel.gif">',
        write: expect.stringContaining("opening <body> tag"),
      },
    ]);
  });

  it("moves a tag manager's whole <noscript> block", async () => {
    const block =
      '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe></noscript>';

    const findings = await audit(
      doc(`${block}<link rel="canonical" href="${URL_}">`)
    );

    expect(fixOf(findings, "head.closed-early")).toMatchObject([
      { action: "remove", current: block },
      { action: "add", at: "body", code: block },
    ]);
  });

  it("deletes an invisible character instead of moving it", async () => {
    const findings = await audit(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">&nbsp;<title>Blue widgets for every workshop | Acme</title></head><body><h1>Blue widgets</h1><a href="/">Home</a></body></html>'
    );

    expect(fixOf(findings, "head.closed-early")).toMatchObject([
      {
        action: "remove",
        current: "&nbsp;",
        write: expect.stringContaining("invisible"),
      },
    ]);
  });

  it("moves metadata from <body> into <head>, streamed or not", async () => {
    const link =
      '<link rel="alternate" hreflang="nl" href="https://www.example.com/nl/">';

    const findings = await audit(doc("", link));

    expect(fixOf(findings, "head.metadata-in-body")).toMatchObject([
      { action: "remove", at: "body", current: link },
      { action: "add", at: "head", code: link },
    ]);

    const streamed = await audit(
      doc(
        "",
        '<div hidden><meta name="description" content="Streamed in."></div>'
      )
    );

    expect(fixOf(streamed, "head.metadata-in-body")).toMatchObject([
      {
        action: "remove",
        current: '<meta name="description" content="Streamed in.">',
      },
      {
        action: "add",
        at: "head",
        write: expect.stringContaining("generateMetadata"),
      },
    ]);
  });

  it("replaces a meta refresh with a server redirect", async () => {
    const tag = '<meta http-equiv="refresh" content="5; url=/new/">';
    const findings = await audit(doc(tag));

    expect(fixOf(findings, "meta-refresh.redirect")).toMatchObject([
      {
        in: "http",
        action: "replace",
        current: "HTTP/1.1 200 OK",
        code: "HTTP/1.1 301 Moved Permanently\nLocation: https://www.example.com/new/",
      },
      { in: "html", action: "remove", current: tag },
    ]);
  });

  it("moves a late charset declaration to the top of <head>", async () => {
    const html = `<!doctype html><html lang="en"><head><title>Blue widgets for every workshop | Acme</title><script>${"var a=1;".repeat(200)}</script><meta charset="utf-8"></head><body><h1>Blue widgets</h1><a href="/">Home</a></body></html>`;

    const findings = await audit(html, { file: true });

    expect(fixOf(findings, "charset.late")).toMatchObject([
      { action: "remove", current: '<meta charset="utf-8">' },
      { action: "add", at: "head", code: '<meta charset="utf-8">' },
    ]);
  });
});

describe("heading fixes", () => {
  it("adds a missing <h1>", async () => {
    const findings = await audit(doc("").replace("<h1>Blue widgets</h1>", ""));

    expect(fixOf(findings, "h1.missing")).toMatchObject([
      { action: "add", at: "body", code: "<h1>{{page heading}}</h1>" },
    ]);
  });

  it("turns the extra <h1> into an <h2> and keeps its attributes", async () => {
    const findings = await audit(doc("", '<h1 class="promo">Spring sale</h1>'));

    expect(fixOf(findings, "h1.multiple")).toMatchObject([
      {
        current: '<h1 class="promo">Spring sale</h1>',
        code: '<h2 class="promo">Spring sale</h2>',
      },
    ]);
  });

  it("names an empty <h1> through the image it holds", async () => {
    const findings = await audit(
      doc("").replace("<h1>Blue widgets</h1>", '<h1><img src="/logo.svg"></h1>')
    );

    expect(fixOf(findings, "h1.empty")).toMatchObject([
      {
        current: '<img src="/logo.svg">',
        code: '<img src="/logo.svg" alt="{{page heading}}">',
      },
    ]);
  });

  it("shortens a long <h1>", async () => {
    const long = "Blue widgets ".repeat(8).trim();

    const findings = await audit(
      doc("").replace("<h1>Blue widgets</h1>", `<h1>${long}</h1>`)
    );

    expect(fixOf(findings, "h1.too-long")).toMatchObject([
      { current: `<h1>${long}</h1>`, code: "<h1>{{shorter heading}}</h1>" },
    ]);
  });

  it("removes empty headings and renumbers skipped levels without new skips", async () => {
    const findings = await audit(
      doc(
        "",
        "<h3></h3><h2>Specs</h2><h4>Size</h4><h5>Width</h5><h2>Price</h2>"
      )
    );

    expect(fixOf(findings, "headings.empty")).toMatchObject([
      { action: "remove", current: "<h3></h3>" },
    ]);
    expect(fixOf(findings, "headings.skipped-level")).toMatchObject([
      { current: "<h4>Size</h4>", code: "<h3>Size</h3>" },
      { current: "<h5>Width</h5>", code: "<h4>Width</h4>" },
    ]);
  });
});

describe("hreflang fixes", () => {
  it("fixes codes, relative URLs, duplicates, the self link and x-default", async () => {
    const findings = await audit(
      doc(
        [
          '<link rel="alternate" hreflang="en_GB" href="https://www.example.com/uk/">',
          '<link rel="alternate" hreflang="nederlands" href="/nl/">',
          '<link rel="alternate" hreflang="de" href="https://www.example.com/de/">',
          '<link rel="alternate" hreflang="de" href="https://www.example.com/de-2/">',
        ].join("")
      )
    );

    expect(fixOf(findings, "hreflang.invalid-code")).toMatchObject([
      {
        code: '<link rel="alternate" hreflang="en-GB" href="https://www.example.com/uk/">',
      },
      {
        code: '<link rel="alternate" hreflang="{{language code}}" href="/nl/">',
        write: expect.stringContaining("nederlands"),
      },
    ]);
    expect(fixOf(findings, "hreflang.relative-url")).toMatchObject([
      {
        current: '<link rel="alternate" hreflang="nederlands" href="/nl/">',
        code: '<link rel="alternate" hreflang="nederlands" href="https://www.example.com/nl/">',
      },
    ]);
    expect(fixOf(findings, "hreflang.duplicate-lang")).toMatchObject([
      {
        action: "remove",
        current:
          '<link rel="alternate" hreflang="de" href="https://www.example.com/de-2/">',
      },
    ]);
    expect(fixOf(findings, "hreflang.missing-self")).toMatchObject([
      {
        action: "add",
        code: `<link rel="alternate" hreflang="en" href="${URL_}">`,
      },
    ]);
    expect(fixOf(findings, "hreflang.missing-x-default")).toMatchObject([
      {
        code: '<link rel="alternate" hreflang="x-default" href="{{fallback page URL}}">',
      },
    ]);
  });
});

describe("image fixes", () => {
  it("gives each image the attribute it lacks", async () => {
    const findings = await audit(
      doc(
        "",
        '<img src="/a.png" width="10" height="10"><img alt="IMG_1234.jpg" src="/c.png" width="10" height="10"><img src="/d.png" alt="Dog"><img data-lazy-src="/e.png" alt="Cat" width="1" height="1">'
      )
    );

    expect(fixOf(findings, "img.alt-missing")).toMatchObject([
      {
        at: 'img[src="/a.png"]',
        code: '<img src="/a.png" width="10" height="10" alt="{{what the image shows}}">',
      },
    ]);
    expect(fixOf(findings, "img.alt-filename")).toMatchObject([
      {
        current: '<img alt="IMG_1234.jpg" src="/c.png" width="10" height="10">',
        code: '<img alt="{{what the image shows}}" src="/c.png" width="10" height="10">',
      },
    ]);
    expect(fixOf(findings, "img.dimensions-missing")).toMatchObject([
      {
        current: '<img src="/d.png" alt="Dog">',
        code: '<img src="/d.png" alt="Dog" width="{{width}}" height="{{height}}">',
      },
    ]);
    expect(fixOf(findings, "img.src-missing")).toMatchObject([
      {
        code: '<img data-lazy-src="/e.png" alt="Cat" width="1" height="1" src="/e.png">',
      },
    ]);
  });

  it("gives a lazy-loaded hero its src without making it lazy above the fold", async () => {
    const hero =
      '<img data-lazy-src="/hero.jpg" alt="A blue widget" width="1200" height="600">';

    const html = `<!doctype html><html lang="en"><head><title>Blue widgets</title></head><body><h1>Blue widgets</h1>${hero}<p>Text.</p></body></html>`;
    const rules = ["img.src-missing", "img.lazy-above-fold"];

    const before = await auditHtml(
      html,
      { url: "https://www.example.com/" },
      { onlyRules: rules }
    );

    const edit = before.findings.find((f) => f.rule === "img.src-missing")
      ?.fix?.[0];

    const after = await auditHtml(
      html.replace(edit?.current ?? "", edit?.code ?? ""),
      { url: "https://www.example.com/" },
      { onlyRules: rules }
    );

    expect(edit?.code).toBe(
      '<img data-lazy-src="/hero.jpg" alt="A blue widget" width="1200" height="600" src="/hero.jpg">'
    );
    expect(after.findings).toStrictEqual([]);
  });
});

describe("indexing fixes", () => {
  it("drops noindex from the meta tag and the header, and says when to keep it", async () => {
    const findings = await audit(
      doc('<meta name="robots" content="noindex, max-snippet:50">'),
      { headers: { "x-robots-tag": "googlebot: noindex, nofollow" } }
    );

    expect(fixOf(findings, "robots.noindex")).toMatchObject([
      {
        in: "html",
        current: '<meta name="robots" content="noindex, max-snippet:50">',
        code: '<meta name="robots" content="max-snippet:50">',
        write: expect.stringContaining("Keep it if"),
      },
      {
        in: "http",
        current: "X-Robots-Tag: googlebot: noindex, nofollow",
        code: "X-Robots-Tag: googlebot: nofollow",
      },
    ]);
  });

  it("removes a robots tag that is left empty, and splits none", async () => {
    const findings = await audit(doc('<meta name="robots" content="none">'));

    expect(fixOf(findings, "robots.noindex")).toMatchObject([
      { code: '<meta name="robots" content="nofollow">' },
    ]);
    expect(fixOf(findings, "robots.nofollow")).toMatchObject([
      { code: '<meta name="robots" content="noindex">' },
    ]);

    const only = await audit(doc('<meta name="robots" content="nofollow">'));

    expect(fixOf(only, "robots.nofollow")).toMatchObject([
      { action: "remove", current: '<meta name="robots" content="nofollow">' },
    ]);
  });

  it("removes the directive Google overrides, and fixes misspelled ones", async () => {
    const findings = await audit(
      doc('<meta name="robots" content="index, follow">'),
      {
        headers: { "x-robots-tag": "noindex" },
      }
    );

    const conflicting = findings.filter((f) => f.rule === "robots.conflicting");
    expect(conflicting).toHaveLength(1);
    expect(conflicting[0]?.fix).toMatchObject([
      {
        current: '<meta name="robots" content="index, follow">',
        code: '<meta name="robots" content="follow">',
      },
    ]);

    const misspelled = await audit(
      doc('<meta name="robots" content="no-index, noindex nofollow">')
    );

    expect(fixOf(misspelled, "robots.malformed-directive")).toMatchObject([
      { code: '<meta name="robots" content="noindex, noindex, nofollow">' },
    ]);
  });
});

describe("link fixes", () => {
  it("names, rewrites and repairs links", async () => {
    const findings = await audit(
      doc(
        "",
        [
          '<a href="https://www.example.com/cart"><svg></svg></a>',
          '<a href="/pricing/">Click here</a>',
          '<a href="#" onclick="go()">Open</a>',
          '<a href="http://www.example.com/about/">About</a>',
          '<a href="/team/" rel="nofollow noopener">Team</a>',
        ].join("")
      )
    );

    expect(fixOf(findings, "links.empty-anchor")).toMatchObject([
      {
        code: '<a href="https://www.example.com/cart" aria-label="{{where the link goes}}">',
      },
    ]);
    expect(fixOf(findings, "links.generic-anchor-text")).toMatchObject([
      {
        at: 'a[href="/pricing/"]',
        current: '<a href="/pricing/">Click here</a>',
        code: '<a href="/pricing/">{{what the link leads to}}</a>',
      },
    ]);
    expect(fixOf(findings, "links.uncrawlable-href")).toMatchObject([
      { code: '<a href="{{URL the link opens}}" onclick="go()">' },
    ]);
    expect(fixOf(findings, "links.insecure-internal")).toMatchObject([
      { code: '<a href="https://www.example.com/about/">' },
    ]);
    expect(fixOf(findings, "links.nofollow-internal")).toMatchObject([
      { code: '<a href="/team/" rel="noopener">' },
    ]);
  });

  it("asks for a first internal link", async () => {
    const findings = await audit(doc("").replace('<a href="/">Home</a>', ""));

    expect(fixOf(findings, "links.no-internal")).toMatchObject([
      { action: "add", at: "body", write: expect.stringContaining("<a href>") },
    ]);
  });
});
