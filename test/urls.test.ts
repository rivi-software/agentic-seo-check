import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import { srcsetUrls } from "../src/core/html/resources.js";
import type { PageSource } from "../src/core/types.js";

const good = readFileSync(
  new URL("fixtures/good-page.html", import.meta.url),
  "utf-8"
);

const page = (body: string, head = "") =>
  `<!DOCTYPE html><html lang="en"><head><title>Blue widgets for home workshops</title>${head}</head><body><h1>Blue widgets</h1>${body}</body></html>`;

const findingsOf = async (
  rule: string,
  html: string,
  url = "https://www.example.com/widgets/blue/",
  source: PageSource = "url"
) => {
  const result = await auditHtml(html, { url, source });

  return result.findings.filter((f) => f.rule === rule);
};

/** Findings of `rule` across several page URLs, which should be none. */
const quietOn = async (rule: string, html: string, urls: string[]) => {
  const results = await Promise.all(
    urls.map((url) => findingsOf(rule, html, url))
  );

  return results.flat();
};

const NEW_RULES = new Set([
  "url.uppercase",
  "url.underscores",
  "url.session-id",
  "links.tracking-parameters",
  "links.local-host",
  "links.missing-fragment",
  "https.mixed-content",
]);

describe("URL and link hygiene", () => {
  it("stays quiet on the good page", async () => {
    const result = await auditHtml(good, {
      url: "https://www.example.com/widgets/blue/",
      source: "url",
    });

    expect(
      result.findings.map((f) => f.rule).filter((r) => NEW_RULES.has(r))
    ).toStrictEqual([]);
  });

  it("url.uppercase skips locale segments and percent-escapes", async () => {
    const html = page("<p>x</p>");

    await expect(
      findingsOf("url.uppercase", html, "https://a.example/Widgets/Blue")
    ).resolves.toHaveLength(1);

    await expect(
      findingsOf("url.uppercase", html, "https://a.example/Our-Team/")
    ).resolves.toHaveLength(1);

    await expect(
      quietOn("url.uppercase", html, [
        "https://a.example/en-US/widgets/",
        "https://a.example/zh-Hans/widgets/",
        "https://a.example/zh-Hant-TW/widgets/",
        "https://a.example/es-419/widgets/",
        "https://a.example/en-us/widgets/",
        "https://a.example/caf%C3%A9/",
        "https://a.example/widgets/?Color=Blue",
      ])
    ).resolves.toStrictEqual([]);

    await expect(
      findingsOf("url.uppercase", html, "https://a.example/Blue", "html")
    ).resolves.toStrictEqual([]);
  });

  it("url.underscores flags words joined by underscores only", async () => {
    const html = page("<p>x</p>");

    await expect(
      findingsOf("url.underscores", html, "https://a.example/blue_widgets/")
    ).resolves.toHaveLength(1);

    await expect(
      findingsOf("url.underscores", html, "https://a.example/how_to_cook/")
    ).resolves.toHaveLength(1);

    await expect(
      quietOn("url.underscores", html, [
        "https://a.example/_next/widgets/",
        "https://a.example/pt_BR/widgets/",
        "https://a.example/blue-widgets/",
      ])
    ).resolves.toStrictEqual([]);
  });

  it("url.session-id finds session ids in the page URL and internal links", async () => {
    const [own] = await findingsOf(
      "url.session-id",
      page("<p>x</p>"),
      "https://a.example/shop;jsessionid=0A1B2C3D4E5F"
    );

    expect(own?.evidence).toMatchObject({ parameter: "jsessionid" });

    const [links] = await findingsOf(
      "url.session-id",
      page(
        '<a href="/cart?PHPSESSID=9f8e7d6c5b4a">Cart</a><a href="/store?sid=12">Store 12</a>'
      ),
      "https://a.example/"
    );

    expect(links?.evidence).toMatchObject({
      parameter: "PHPSESSID",
      links: 1,
      examples: ["https://a.example/cart?PHPSESSID=9f8e7d6c5b4a"],
    });

    await expect(
      findingsOf(
        "url.session-id",
        page('<a href="/store?sid=12">Store 12</a>'),
        "https://a.example/"
      )
    ).resolves.toStrictEqual([]);
  });

  it("links.tracking-parameters flags internal links only", async () => {
    const [f] = await findingsOf(
      "links.tracking-parameters",
      page(
        '<a href="/pricing?utm_source=home&utm_medium=banner">Pricing</a><a href="https://partner.example.org/?utm_source=us">Partner</a><a href="/docs?ref=nav">Docs</a>'
      ),
      "https://a.example/"
    );

    expect(f?.evidence).toStrictEqual({
      count: 1,
      examples: ["https://a.example/pricing?utm_source=home&utm_medium=banner"],
    });
  });

  it("links.local-host: an error for metadata and resources, info for anchors only", async () => {
    const [metadata] = await findingsOf(
      "links.local-host",
      page(
        '<img src="http://localhost:3000/hero.png" alt="Hero">',
        '<link rel="canonical" href="http://localhost:3000/widgets/blue/">'
      )
    );

    expect(metadata?.severity).toBe("error");
    expect(metadata?.evidence).toMatchObject({ count: 2 });

    const [anchors] = await findingsOf(
      "links.local-host",
      page('<a href="http://192.168.1.20:8080/">Open your router</a>')
    );

    expect(anchors?.severity).toBe("info");

    await expect(
      findingsOf(
        "links.local-host",
        page('<a href="http://localhost:3000/">Home</a>'),
        "http://localhost:3000/widgets/"
      )
    ).resolves.toStrictEqual([]);
  });

  it("links.missing-fragment skips #top, routes and present ids", async () => {
    const [f] = await findingsOf(
      "links.missing-fragment",
      page(
        '<a href="#elementor-action%3Aaction%3Dpopup%3Aopen%26settings%3D1">Popup</a><a href="#sizes">Sizes</a><a href="#top">Top</a><a href="#!/cart">Cart</a><a href="#prices">Prices</a><h2 id="sizes">Sizes</h2><a href="#legacy">Legacy</a><a name="legacy"></a>'
      )
    );

    expect(f?.evidence).toStrictEqual({ fragments: ["#prices"] });
  });

  it("https.mixed-content splits blocked from upgraded resources", async () => {
    const html = page(
      '<img src="http://cdn.example/a.png" alt="A"><img src="/b.png" srcset="http://cdn.example/b@2x.png 2x" alt="B"><script src="http://cdn.example/app.js"></script>',
      '<link rel="stylesheet" href="http://cdn.example/site.css">'
    );

    const findings = await findingsOf("https.mixed-content", html);

    expect(
      findings.map((f) => [f.severity, f.evidence?.["count"]])
    ).toStrictEqual([
      ["warning", 3],
      ["info", 1],
    ]);

    const upgradedHtml = html.replace(
      "<title>",
      '<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"><title>'
    );

    const withCsp = await findingsOf("https.mixed-content", upgradedHtml);

    expect(
      withCsp.map((f) => [f.severity, f.evidence?.["count"]])
    ).toStrictEqual([["info", 4]]);

    await expect(
      findingsOf(
        "https.mixed-content",
        html,
        "http://www.example.com/widgets/blue/"
      )
    ).resolves.toStrictEqual([]);
  });

  it("reads srcset URLs the way browsers do, data: URLs whole", () => {
    expect(
      srcsetUrls(
        "data:image/avif;base64,AAAA,BBBB 1x, /img/b.webp 2x,\n/img/c.jpg 960w"
      )
    ).toStrictEqual([
      "data:image/avif;base64,AAAA,BBBB",
      "/img/b.webp",
      "/img/c.jpg",
    ]);
  });

  it("https.mixed-content reads upgrade-insecure-requests from joined CSP headers, and blocks subtitles", async () => {
    const url = "https://www.example.com/widgets/blue/";

    const html = page(
      '<script src="http://cdn.example/app.js"></script><video src="https://cdn.example/v.mp4"><track src="http://cdn.example/subs.vtt"></video>'
    );

    const plain = await auditHtml(html, { url, source: "url" });

    expect(
      plain.findings
        .filter((f) => f.rule === "https.mixed-content")
        .map((f) => [f.severity, f.evidence?.["examples"]])
    ).toStrictEqual([
      [
        "warning",
        [
          "script: http://cdn.example/app.js",
          "track: http://cdn.example/subs.vtt",
        ],
      ],
    ]);

    const joined = await auditHtml(html, {
      url,
      source: "url",
      response: {
        status: 200,
        finalUrl: url,
        redirectChain: [],
        timeMs: 10,
        contentType: "text/html",
        headers: {
          "content-security-policy":
            "frame-ancestors 'self', upgrade-insecure-requests",
        },
      },
    });

    expect(
      joined.findings
        .filter((f) => f.rule === "https.mixed-content")
        .map((f) => f.severity)
    ).toStrictEqual(["info"]);
  });
});
