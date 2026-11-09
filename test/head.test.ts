import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import { extractPage } from "../src/core/html/extract.js";
import type { ResponseInfo } from "../src/core/types.js";

const good = readFileSync(
  new URL("fixtures/good-page.html", import.meta.url),
  "utf-8"
);

const URL_ = "https://www.example.com/widgets/blue/";

const response = (headers: Record<string, string>): ResponseInfo => ({
  status: 200,
  finalUrl: URL_,
  redirectChain: [],
  timeMs: 10,
  contentType: headers["content-type"] ?? "text/html",
  headers,
});

const page = (head: string, body = "<h1>Blue widgets</h1>") =>
  `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

const audit = (html: string, headers?: Record<string, string>) =>
  auditHtml(
    html,
    headers
      ? { url: URL_, source: "url", response: response(headers) }
      : { url: URL_, source: "url" }
  );

const findingsOf = async (
  rule: string,
  html: string,
  headers?: Record<string, string>
) => {
  const result = await audit(html, headers);

  return result.findings.filter((f) => f.rule === rule);
};

const NEW_RULES = new Set([
  "head.closed-early",
  "head.metadata-in-body",
  "meta-refresh.redirect",
  "charset.late",
  "robots.conflicting",
  "robots.malformed-directive",
  "canonical.header-conflict",
]);

describe("head and indexing signals", () => {
  it("stay quiet on the good page", async () => {
    const result = await audit(good, { "content-type": "text/html" });
    const rules = result.findings.map((f) => f.rule);

    expect(rules.filter((r) => NEW_RULES.has(r))).toStrictEqual([]);
  });

  it("head.closed-early names the element and the metadata Google ignores", async () => {
    const [f] = await findingsOf(
      "head.closed-early",
      page(
        '<meta charset="utf-8"><title>Blue widgets for home workshops</title><img src="/pixel.gif"><meta name="description" content="Blue widgets."><link rel="canonical" href="https://www.example.com/widgets/blue/">'
      )
    );

    expect(f?.severity).toBe("error");
    expect(f?.evidence).toMatchObject({
      closedBy: '<img src="/pixel.gif">',
      metadataAfter: ['<meta name="description">', '<link rel="canonical">'],
    });
  });

  it("head.closed-early reads stray text as the end of <head>", async () => {
    const [f] = await findingsOf(
      "head.closed-early",
      page(
        '<title>Blue widgets for home workshops</title>}}<link rel="canonical" href="https://www.example.com/widgets/blue/">'
      )
    );

    expect(f?.evidence).toMatchObject({ closedBy: 'text "}}"' });
  });

  it("head.closed-early is info for a pixel inside <noscript>", async () => {
    const [f] = await findingsOf(
      "head.closed-early",
      page(
        '<title>Blue widgets for home workshops</title><noscript><img src="https://px.example/p.gif"></noscript><link rel="canonical" href="https://www.example.com/widgets/blue/">'
      )
    );

    expect(f?.severity).toBe("info");
    expect(f?.evidence).toMatchObject({ inNoscript: true });
  });

  it("head.closed-early stays quiet when nothing follows, or the <noscript> holds a stylesheet", async () => {
    await expect(
      findingsOf(
        "head.closed-early",
        page(
          '<title>Blue widgets for home workshops</title><link rel="canonical" href="https://www.example.com/widgets/blue/"><noscript><link rel="stylesheet" href="/no-js.css"></noscript><script>var end = "</head>";</script>'
        )
      )
    ).resolves.toStrictEqual([]);

    await expect(
      findingsOf(
        "head.closed-early",
        page(
          '<title>Blue widgets for home workshops</title><link rel="canonical" href="https://www.example.com/widgets/blue/"><img src="/pixel.gif">'
        )
      )
    ).resolves.toStrictEqual([]);
  });

  it("head.metadata-in-body reports canonical and description, not robots, microdata or SVG titles", async () => {
    const [f] = await findingsOf(
      "head.metadata-in-body",
      page(
        "<title>Blue widgets for home workshops</title>",
        '<h1>Blue widgets</h1><link rel="canonical" href="https://www.example.com/widgets/blue/"><meta name="description" content="Late"><meta name="robots" content="noindex"><div itemscope itemtype="https://schema.org/Product"><meta itemprop="name" content="Widget"></div><svg><title>Close</title></svg>'
      )
    );

    expect(f?.evidence).toStrictEqual({
      elements: ['<link rel="canonical">', '<meta name="description">'],
    });
  });

  it("head.metadata-in-body is info for metadata React streams into a hidden part of <body>", async () => {
    const [f] = await findingsOf(
      "head.metadata-in-body",
      page(
        "<title>Loading</title>",
        '<h1>Blue widgets</h1><div hidden id="S:0"><title>Blue widgets for home workshops</title><meta name="description" content="Blue widgets."><link rel="canonical" href="https://www.example.com/widgets/blue/"></div><script>$RC("B:0","S:0")</script>'
      )
    );

    expect(f?.severity).toBe("info");
    expect(f?.evidence).toStrictEqual({
      elements: [
        "<title>",
        '<meta name="description">',
        '<link rel="canonical">',
      ],
      streamed: true,
    });
  });

  it("an inline SVG <title> is not a second page title", async () => {
    const result = await audit(
      page(
        "<title>Blue widgets for home workshops</title>",
        "<h1>Blue widgets</h1><svg><title>Close</title></svg>"
      )
    );

    expect(result.findings.map((f) => f.rule)).not.toContain("title.multiple");
    expect(result.summary.title).toBe("Blue widgets for home workshops");
  });

  it("meta-refresh.redirect: instant is info, delayed is a warning", async () => {
    const [instant] = await findingsOf(
      "meta-refresh.redirect",
      page(
        '<meta http-equiv="refresh" content="0; URL=\'/widgets/\'"><title>Moved</title>'
      )
    );

    expect(instant?.severity).toBe("info");
    expect(instant?.evidence).toStrictEqual({
      target: "https://www.example.com/widgets/",
      seconds: 0,
    });

    const [delayed] = await findingsOf(
      "meta-refresh.redirect",
      page('<meta http-equiv="Refresh" content="5;url=https://b.test/">')
    );

    expect(delayed?.severity).toBe("warning");

    await expect(
      findingsOf(
        "meta-refresh.redirect",
        page('<meta http-equiv="refresh" content="300">')
      )
    ).resolves.toStrictEqual([]);

    await expect(
      findingsOf(
        "meta-refresh.redirect",
        page(
          '<meta http-equiv="refresh" content="300; url=https://www.example.com/widgets/blue/">'
        )
      )
    ).resolves.toStrictEqual([]);
  });

  it("charset.late fires past 1024 bytes unless Content-Type declares the charset", async () => {
    const html = page(
      `<!-- ${"x".repeat(1100)} --><meta charset="utf-8"><title>Blue widgets for home workshops</title>`
    );

    const [f] = await findingsOf("charset.late", html, {
      "content-type": "text/html",
    });

    expect(f?.evidence).toMatchObject({ endsAtByte: expect.any(Number) });

    await expect(
      findingsOf("charset.late", html, {
        "content-type": "text/html; charset=utf-8",
      })
    ).resolves.toStrictEqual([]);
  });

  it("charset.missing accepts a charset in the Content-Type header", async () => {
    const html = page("<title>Blue widgets for home workshops</title>");

    await expect(findingsOf("charset.missing", html)).resolves.toHaveLength(1);
    await expect(
      findingsOf("charset.missing", html, {
        "content-type": "text/html; charset=utf-8",
      })
    ).resolves.toStrictEqual([]);
  });

  it("an X-Robots-Tag for one AI crawler does not make the page noindex", async () => {
    const result = await audit(
      page("<title>Blue widgets for home workshops</title>"),
      {
        "x-robots-tag": "GPTBot: noindex, nofollow",
      }
    );

    expect(result.findings.map((f) => f.rule)).not.toContain("robots.noindex");
    expect(result.summary.indexable).toBeTruthy();

    const bing = await audit(
      page("<title>Blue widgets for home workshops</title>"),
      {
        "x-robots-tag": "bingbot: noindex",
      }
    );

    expect(bing.findings.map((f) => f.rule)).toContain("robots.noindex");
  });

  it("robots.conflicting names both sides and what Google applies", async () => {
    const [f] = await findingsOf(
      "robots.conflicting",
      page('<meta name="robots" content="index, follow">'),
      { "x-robots-tag": "noindex" }
    );

    expect(f?.evidence).toStrictEqual({
      allow: ['index (<meta name="robots">)'],
      deny: ["noindex (X-Robots-Tag)"],
      applied: "noindex",
    });

    await expect(
      findingsOf(
        "robots.conflicting",
        page('<meta name="robots" content="index, follow">'),
        { "x-robots-tag": "bingbot: noindex" }
      )
    ).resolves.toStrictEqual([]);
  });

  it("robots.malformed-directive: misspelled is a warning, missing commas info", async () => {
    const [misspelled] = await findingsOf(
      "robots.malformed-directive",
      page('<meta name="robots" content="no-index, follow">')
    );

    expect(misspelled?.severity).toBe("warning");
    expect(misspelled?.evidence).toStrictEqual({
      directives: [
        {
          written: "no-index",
          source: '<meta name="robots">',
          meant: ["noindex"],
        },
      ],
    });

    const [joined] = await findingsOf(
      "robots.malformed-directive",
      page('<meta name="googlebot" content="noindex nofollow">')
    );

    expect(joined?.severity).toBe("info");

    await expect(
      findingsOf(
        "robots.malformed-directive",
        page(
          '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, noai">'
        )
      )
    ).resolves.toStrictEqual([]);
  });

  it("canonical.header-conflict compares the Link header with the HTML canonical", async () => {
    const html = page(
      '<link rel="canonical" href="https://www.example.com/widgets/blue/">'
    );

    const [f] = await findingsOf("canonical.header-conflict", html, {
      link: '<https://www.example.com/fonts.css>; rel=preload; as=style, <https://www.example.com/blue-widgets>; rel="canonical"',
    });

    expect(f?.severity).toBe("error");
    expect(f?.evidence).toStrictEqual({
      linkHeader: ["https://www.example.com/blue-widgets"],
      htmlCanonical: "https://www.example.com/widgets/blue/",
    });

    await expect(
      findingsOf("canonical.header-conflict", html, {
        link: '<https://www.example.com/widgets/blue/>; rel="canonical"',
      })
    ).resolves.toStrictEqual([]);
  });

  it("canonical.missing accepts a canonical in the Link header", async () => {
    const html = page("<title>Blue widgets for home workshops</title>");

    await expect(findingsOf("canonical.missing", html)).resolves.toHaveLength(
      1
    );
    await expect(
      findingsOf("canonical.missing", html, {
        link: "</widgets/blue/>; rel=canonical",
      })
    ).resolves.toStrictEqual([]);
  });

  it("extracts the head signals once", () => {
    const { head } = extractPage(
      page(
        '<meta charset="utf-8"><title>T</title><img src="/x.gif"><meta name="viewport" content="width=device-width">',
        '<link rel="alternate" hreflang="nl" href="/nl/">'
      ),
      { url: URL_ }
    );

    expect(head).toStrictEqual({
      closedBy: '<img src="/x.gif">',
      closedInNoscript: false,
      afterClose: ['<meta name="viewport">'],
      inBody: ['<link rel="alternate" hreflang="nl">'],
      streamedInBody: [],
      refresh: [],
      charsetEndByte: 59,
    });
  });
});
