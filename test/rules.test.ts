import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import { ALL_RULES } from "../src/core/rules/index.js";

const good = readFileSync(
  new URL("fixtures/good-page.html", import.meta.url),
  "utf8"
);

const bad = readFileSync(
  new URL("fixtures/bad-page.html", import.meta.url),
  "utf8"
);

const rulesOf = (findings: { rule: string }[]) => findings.map((f) => f.rule);

describe("page rules", () => {
  it("a well-formed page has no errors or warnings", async () => {
    const audit = await auditHtml(good, {
      url: "https://www.example.com/widgets/blue/",
      source: "url",
    });

    const serious = audit.findings.filter((f) => f.severity !== "info");
    expect(serious, JSON.stringify(serious, null, 2)).toHaveLength(0);
    expect(audit.score).toBeGreaterThanOrEqual(95);
    expect(audit.summary.indexable).toBe(true);
    expect(audit.summary.structuredDataTypes).toEqual(["Product"]);
  });

  it("flags the classic mistakes on a bad page", async () => {
    const audit = await auditHtml(bad, {
      url: "https://www.example.com/x",
      source: "url",
    });

    const rules = rulesOf(audit.findings);

    for (const expected of [
      "title.generic",
      "title.multiple",
      "title.too-short",
      "meta-description.missing",
      "canonical.multiple",
      "robots.noindex",
      "robots.nofollow",
      "html.lang-missing",
      "viewport.missing",
      "charset.missing",
      "doctype.missing",
      "og.incomplete",
      "og.image-not-absolute",
      "twitter.card-invalid",
      "hreflang.invalid-code",
      "hreflang.relative-url",
      "hreflang.missing-self",
      "structured-data.invalid-json",
      "structured-data.missing-required",
      "structured-data.invalid-date",
      "h1.missing",
      "headings.skipped-level",
      "headings.empty",
      "content.placeholder-text",
      "content.thin",
      "img.alt-missing",
      "img.alt-filename",
      "img.dimensions-missing",
      "links.no-internal",
      "links.generic-anchor-text",
      "links.uncrawlable-href",
      "links.empty-anchor",
    ]) {
      expect(rules, `expected ${expected} in ${rules.join(", ")}`).toContain(
        expected
      );
    }

    const canonical = audit.findings.find(
      (f) => f.rule === "canonical.multiple"
    )!;

    expect(canonical.severity).toBe("error");
    const alt = audit.findings.find((f) => f.rule === "img.alt-missing")!;
    expect(alt.evidence).toMatchObject({ count: 2, total: 3 });

    const required = audit.findings.find(
      (f) => f.rule === "structured-data.missing-required"
    )!;

    expect(required.evidence).toMatchObject({
      type: "Product",
      missing: ["name", "one of: offers | review | aggregateRating"],
    });
    expect(audit.findings[0]!.severity).toBe("error");
    expect(audit.score).toBeLessThan(30);
  });

  it("title.missing is an error and sets selector", async () => {
    const audit = await auditHtml(
      '<!DOCTYPE html><html lang="en"><head></head><body><h1>x</h1></body></html>',
      { url: "https://a.test/" }
    );

    const f = audit.findings.find((x) => x.rule === "title.missing")!;
    expect(f.severity).toBe("error");
    expect(f.selector).toBe("head > title");
    expect(f.url).toBe("https://a.test/");
  });

  it("reads X-Robots-Tag from the response", async () => {
    const audit = await auditHtml(
      "<!DOCTYPE html><html><head><title>Some descriptive title here</title></head><body></body></html>",
      {
        url: "https://a.test/",
        source: "url",
        response: {
          status: 200,
          finalUrl: "https://a.test/",
          redirectChain: [],
          timeMs: 10,
          contentType: "text/html",
          headers: { "x-robots-tag": "noindex" },
        },
      }
    );

    const f = audit.findings.find((x) => x.rule === "robots.noindex")!;
    expect(f.evidence).toMatchObject({ sources: ["header"] });
    expect(audit.summary.indexable).toBe(false);
  });

  it("keyword rules run only with a keyword", async () => {
    const html =
      '<!DOCTYPE html><html lang="en"><head><title>Pricing plans for teams and enterprises</title><meta name="description" content="See our pricing plans."></head><body><h1>Pricing</h1><p>Our plans are simple and fair for every team size.</p><a href="/">home</a></body></html>';

    const without = await auditHtml(html, { url: "https://a.test/pricing" });
    expect(
      rulesOf(without.findings).some((r) => r.startsWith("keyword."))
    ).toBe(false);

    const withKw = await auditHtml(
      html,
      { url: "https://a.test/pricing", source: "url" },
      { keyword: "blue widgets" }
    );

    expect(rulesOf(withKw.findings)).toEqual(
      expect.arrayContaining([
        "keyword.not-in-title",
        "keyword.not-in-h1",
        "keyword.not-in-body",
        "keyword.not-in-url",
      ])
    );

    const match = await auditHtml(
      html,
      { url: "https://a.test/pricing" },
      { keyword: "pricing" }
    );

    expect(rulesOf(match.findings).some((r) => r.startsWith("keyword."))).toBe(
      false
    );
  });

  it("canonical.other-page compares by path on localhost", async () => {
    const html =
      '<!DOCTYPE html><html lang="en"><head><title>Descriptive title of the page</title><link rel="canonical" href="https://www.example.com/about/"></head><body><a href="/">x</a></body></html>';

    const local = await auditHtml(html, {
      url: "http://localhost:3000/about/",
      source: "url",
    });

    expect(rulesOf(local.findings)).not.toContain("canonical.other-page");

    const prod = await auditHtml(html, {
      url: "https://www.example.com/contact/",
      source: "url",
    });

    expect(rulesOf(prod.findings)).toContain("canonical.other-page");
  });

  it("response rules use status and redirects", async () => {
    const audit = await auditHtml("<html></html>", {
      url: "https://a.test/final",
      source: "url",
      response: {
        status: 404,
        finalUrl: "https://a.test/final",
        redirectChain: [
          { url: "https://a.test/a", status: 301 },
          { url: "https://a.test/b", status: 302 },
        ],
        timeMs: 2500,
        contentType: "text/html",
        headers: {},
      },
    });

    const rules = rulesOf(audit.findings);
    expect(rules).toEqual(
      expect.arrayContaining([
        "response.error-status",
        "response.redirect-chain",
        "response.slow",
      ])
    );
  });

  it("includeInfo=false and disableRules filter findings", async () => {
    const audit = await auditHtml(
      bad,
      { url: "https://www.example.com/x" },
      { includeInfo: false, disableRules: ["title.generic"] }
    );

    expect(audit.findings.every((f) => f.severity !== "info")).toBe(true);
    expect(rulesOf(audit.findings)).not.toContain("title.generic");
  });

  it("rule ids are unique and documented", () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const r of ALL_RULES) {
      expect(r.description.length).toBeGreaterThan(10);
      expect(r.recommendation.length).toBeGreaterThan(10);
    }

    expect(ids.length).toBeGreaterThan(80);
  });
});
