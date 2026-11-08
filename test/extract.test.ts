import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractPage } from "../src/core/html/extract.js";

const good = readFileSync(
  new URL("fixtures/good-page.html", import.meta.url),
  "utf8"
);

const bad = readFileSync(
  new URL("fixtures/bad-page.html", import.meta.url),
  "utf8"
);

describe(extractPage, () => {
  it("extracts head metadata and resolves URLs", () => {
    const page = extractPage(good, {
      url: "https://www.example.com/widgets/blue/",
    });

    expect(page.title).toBe("Blue Widgets for Home Workshops | Widget Co");
    expect(page.metaDescription).toMatch(/^Compare blue widgets/);
    expect(page.canonical).toBe("https://www.example.com/widgets/blue/");
    expect(page.lang).toBe("en");
    expect(page.viewport).toContain("width=device-width");
    expect(page.charset).toBe("utf-8");
    expect(page.hasDoctype).toBe(true);
    expect(page.og["image"]).toBe(
      "https://www.example.com/img/blue-widgets.jpg"
    );
    expect(page.twitter["card"]).toBe("summary_large_image");
    expect(page.hreflang).toHaveLength(3);
    expect(page.hreflang[1]).toMatchObject({
      lang: "nl",
      url: "https://www.example.com/nl/widgets/blauw/",
    });
  });

  it("classifies links and counts words", () => {
    const page = extractPage(good, {
      url: "https://www.example.com/widgets/blue/",
    });

    const internal = page.links.filter((l) => l.internal);
    const external = page.links.filter((l) => !l.internal);
    expect(internal.map((l) => l.url)).toContain(
      "https://www.example.com/widgets/red/"
    );
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      nofollow: true,
      hasAccessibleName: true,
    });
    expect(page.wordCount).toBeGreaterThan(250);
    expect(page.headings.map((h) => h.level)).toEqual([1, 2, 2, 2, 2, 2, 2, 3]);
    expect(page.images[0]).toMatchObject({
      alt: "Three blue widgets on a workbench",
      width: "800",
    });
  });

  it("parses JSON-LD and reports invalid blocks", () => {
    const page = extractPage(bad, { url: "https://www.example.com/x" });
    expect(page.structuredDataErrors).toHaveLength(1);
    expect(page.structuredData).toHaveLength(1);
    expect(page.structuredData[0]!.types).toEqual(["Product"]);
    expect(page.titles).toHaveLength(2);
    expect(page.canonicals).toHaveLength(2);
    expect(page.metaRobots).toEqual(["noindex, nofollow"]);
  });

  it("flattens @graph and arrays", () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"A"},{"@type":["WebSite","Thing"],"name":"B","url":"https://a.test/"}]}</script></head><body></body></html>`;
    const page = extractPage(html, { url: "https://a.test/" });
    expect(page.structuredData.map((i) => i.types)).toEqual([
      ["Organization"],
      ["WebSite", "Thing"],
    ]);
    expect(page.structuredData[0]!.context).toBe("https://schema.org");
  });

  it("extracts microdata", () => {
    const html = `<html><body><div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Ada</span><a itemprop="url" href="/ada">x</a><div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress"><span itemprop="addressLocality">London</span></div></div></body></html>`;
    const page = extractPage(html, { url: "https://a.test/" });
    expect(page.structuredData).toHaveLength(1);
    const item = page.structuredData[0]!;
    expect(item.source).toBe("microdata");
    expect(item.types).toEqual(["Person"]);
    expect(item.data["name"]).toBe("Ada");
    expect(item.data["url"]).toBe("/ada");
    expect(
      (item.data["address"] as Record<string, unknown>)["addressLocality"]
    ).toBe("London");
  });

  it("respects <base href> for relative links", () => {
    const html = `<html><head><base href="https://cdn.example.com/app/"></head><body><a href="page">p</a></body></html>`;
    const page = extractPage(html, { url: "https://www.example.com/" });
    expect(page.links[0]!.url).toBe("https://cdn.example.com/app/page");
    expect(page.links[0]!.internal).toBe(false);
  });
});
