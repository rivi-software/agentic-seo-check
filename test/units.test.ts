import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import {
  fleschReadingEase,
  isGenericAnchor,
  shingles,
  jaccard,
  wordCount,
} from "../src/core/html/text.js";
import { LIGHTHOUSE_PEERS } from "../src/core/lighthouse.js";
import { renderMarkdown } from "../src/core/report/markdown.js";
import { pageScore } from "../src/core/score.js";
import { parseSitemap } from "../src/core/sitemap.js";
import {
  isSameSite,
  looksLikeHtml,
  normalizePath,
  normalizeUrl,
  resolveUrl,
  trimTrailingSlashes,
} from "../src/core/url.js";
import { VERSION } from "../src/version.js";

describe("url helpers", () => {
  it("normalizes tracking params, fragments and ports", () => {
    expect(
      normalizeUrl("HTTPS://Example.com:443/a?utm_source=x&b=1#frag")
    ).toBe("https://example.com/a?b=1");
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
  });

  it("treats www and non-www as the same site", () => {
    expect(isSameSite("https://www.example.com/x", "example.com")).toBeTruthy();
    expect(isSameSite("https://blog.example.com/x", "example.com")).toBeFalsy();
    expect(
      isSameSite("https://blog.example.com/x", "example.com", true)
    ).toBeTruthy();
  });

  it("detects asset URLs", () => {
    expect(looksLikeHtml("https://a.test/x.pdf")).toBeFalsy();
    expect(looksLikeHtml("https://a.test/x")).toBeTruthy();
    expect(looksLikeHtml("https://a.test/x.html")).toBeTruthy();
  });

  it("normalizes paths for file comparisons", () => {
    expect(normalizePath("/about/index.html")).toBe("/about");
    expect(normalizePath("/about.html")).toBe("/about");
    expect(normalizePath("/")).toBe("/");
  });

  it("resolves relative links but not javascript:", () => {
    expect(resolveUrl("../x", "https://a.test/b/c/")).toBe(
      "https://a.test/b/x"
    );
    // oxlint-disable-next-line eslint/no-script-url -- the test is that a javascript: URL is refused
    expect(resolveUrl("javascript:void(0)", "https://a.test/")).toBeNull();
  });
});

describe("sitemap parsing", () => {
  it("parses urlsets, indexes and text sitemaps", () => {
    expect(
      parseSitemap(
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.test/</loc></url><url><loc>https://a.test/b</loc><lastmod>2026-03-14</lastmod></url></urlset>'
      )
    ).toStrictEqual({
      kind: "urlset",
      locs: ["https://a.test/", "https://a.test/b"],
      lastmods: [null, "2026-03-14"],
    });
    expect(
      parseSitemap(
        "<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>"
      )
    ).toStrictEqual({
      kind: "sitemapindex",
      locs: ["https://a.test/s1.xml"],
      lastmods: [null],
    });
    expect(
      parseSitemap("https://a.test/\nhttps://a.test/x\n", "text/plain")
    ).toStrictEqual({
      kind: "text",
      locs: ["https://a.test/", "https://a.test/x"],
      lastmods: [null, null],
    });
    expect(parseSitemap("<html><body>nope</body></html>").kind).toBe("unknown");
    expect(
      parseSitemap(
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
      )
    ).toStrictEqual({ kind: "urlset", locs: [], lastmods: [] });
  });
});

describe("text helpers", () => {
  it("counts words and scores readability", () => {
    expect(wordCount("Hello, world! It’s 2026.")).toBe(4);

    const easy = Array.from(
      { length: 30 },
      () => "The cat sat on the mat. It was a big cat."
    ).join(" ");

    expect(fleschReadingEase(easy)).toBeGreaterThan(80);
    expect(fleschReadingEase("too short")).toBeNull();
  });

  it("detects generic anchors and near-duplicates", () => {
    expect(isGenericAnchor("Click here!")).toBeTruthy();
    expect(isGenericAnchor("Pricing plans")).toBeFalsy();
    const a = shingles("one two three four five six seven eight nine ten");
    const b = shingles("one two three four five six seven eight nine eleven");
    expect(jaccard(a, b)).toBeGreaterThan(0.6);
  });
});

describe("scoring and reports", () => {
  it("scores deduct per severity", () => {
    expect(pageScore({ error: 0, warning: 0, info: 0 })).toBe(100);
    expect(pageScore({ error: 1, warning: 2, info: 3 })).toBe(72);
    expect(pageScore({ error: 10, warning: 0, info: 0 })).toBe(0);
  });

  it("renders markdown for a page audit", async () => {
    const audit = await auditHtml(
      "<!DOCTYPE html><html><head></head><body></body></html>",
      { url: "https://a.test/" }
    );

    const md = renderMarkdown(audit);
    expect(md).toContain("# SEO audit: https://a.test/");
    expect(md).toContain("`title.missing`");
    expect(md).toContain("Fix:");
    expect(md.trimEnd().split("\n").at(-1)).toBe(
      `_Audited with [Agentic SEO Check](https://github.com/rivi-software/agentic-seo-check) ${VERSION}, made by [RIVI Software](https://rivi.software)._`
    );
  });
});

describe("optional dependencies", () => {
  it("names the Lighthouse peers at the majors package.json allows", () => {
    // SAFETY: the repository's own manifest, which lists both peers.
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8")
    ) as { peerDependencies: Record<string, string> };

    const majors = Object.entries(manifest.peerDependencies).map(
      ([name, range]) => `${name}@${/\d+/u.exec(range)?.[0]}`
    );

    expect(LIGHTHOUSE_PEERS.toSorted()).toStrictEqual(majors.toSorted());
  });
});

describe(trimTrailingSlashes, () => {
  it("trims a long run of slashes in linear time", () => {
    const url = `/a${"/".repeat(50_000)}b${"/".repeat(50_000)}`;
    const started = performance.now();

    expect(trimTrailingSlashes(url)).toBe(`/a${"/".repeat(50_000)}b`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(trimTrailingSlashes("///")).toBe("");
  });
});
