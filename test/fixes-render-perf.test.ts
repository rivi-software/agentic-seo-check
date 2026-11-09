import { describe, expect, it } from "vitest";

import { extractPage } from "../src/core/html/extract.js";
import { summarize } from "../src/core/lighthouse.js";
import { clsEdits } from "../src/core/performance-fixes.js";
import { performanceFindings } from "../src/core/performance-rules.js";
import { assignIds } from "../src/core/recheck.js";
import { compareRender } from "../src/core/render-rules.js";
import type {
  Finding,
  PerformanceResult,
  ResponseInfo,
} from "../src/core/types.js";
import { incompleteEdits, withoutFix } from "./helpers/fixes.js";

const URL_PAGE = "https://www.example.com/widgets/";

const fixOf = (findings: Finding[], rule: string) =>
  findings.find((f) => f.rule === rule)?.fix;

/** Every finding has a complete fix, and ids stay apart when a rule reports several. */
const expectSoundFixes = (findings: Finding[]): void => {
  expect(withoutFix(findings)).toStrictEqual([]);
  expect(incompleteEdits(findings)).toStrictEqual([]);
  assignIds(findings);
  expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
};

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

const links = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `<a href="/widgets/${i}/" class="card">Widget ${i}</a>`
  ).join("");

const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title></title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;

const RENDERED = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Blue widgets | Acme</title><meta name="description" content="Blue widgets for every workshop."><link rel="canonical" href="https://www.example.com/widgets/"><meta name="robots" content="noindex"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Blue widget"}</script></head><body><div id="root"><h1 class="hero">Blue widgets</h1><p>${words(150)}</p><nav>${links(12)}</nav></div></body></html>`;

const compare = (
  raw: string,
  rendered: string,
  errors: string[] = [],
  response?: ResponseInfo
) =>
  compareRender(
    extractPage(raw, { url: URL_PAGE }),
    extractPage(rendered, { url: URL_PAGE }),
    URL_PAGE,
    errors,
    response
  ).findings;

describe("fixes for what only JavaScript adds", () => {
  const findings = compare(SHELL, RENDERED, [
    "TypeError: cart is undefined at https://www.example.com/app.js:1:200",
  ]);

  it("gives every rendering finding a complete fix", () => {
    expect(findings.map((f) => f.rule).toSorted()).toStrictEqual([
      "rendering.canonical-client-only",
      "rendering.console-errors",
      "rendering.content-client-only",
      "rendering.description-client-only",
      "rendering.h1-client-only",
      "rendering.links-client-only",
      "rendering.noindex-client-only",
      "rendering.structured-data-client-only",
      "rendering.title-client-only",
    ]);
    expectSoundFixes(findings);
  });

  it("puts the rendered head tags into the server HTML, in place of an empty one", () => {
    expect(fixOf(findings, "rendering.title-client-only")).toMatchObject([
      {
        in: "html",
        action: "replace",
        current: "<title></title>",
        code: "<title>Blue widgets | Acme</title>",
      },
    ]);
    expect(fixOf(findings, "rendering.description-client-only")).toMatchObject([
      {
        action: "add",
        at: "head",
        code: '<meta name="description" content="Blue widgets for every workshop.">',
      },
    ]);
    expect(fixOf(findings, "rendering.canonical-client-only")).toMatchObject([
      {
        action: "add",
        at: "head",
        code: '<link rel="canonical" href="https://www.example.com/widgets/">',
      },
    ]);
    expect(
      fixOf(findings, "rendering.structured-data-client-only")
    ).toMatchObject([
      {
        action: "add",
        at: "head",
        code: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Blue widget"}</script>',
      },
    ]);
  });

  it("removes the noindex JavaScript adds", () => {
    expect(fixOf(findings, "rendering.noindex-client-only")).toMatchObject([
      {
        in: "html",
        action: "remove",
        current: '<meta name="robots" content="noindex">',
      },
    ]);
  });

  it("quotes the rendered heading and links into the empty app root", () => {
    expect(fixOf(findings, "rendering.h1-client-only")).toMatchObject([
      {
        action: "add",
        at: "#root",
        code: '<h1 class="hero">Blue widgets</h1>',
      },
    ]);

    const [linkEdit] = fixOf(findings, "rendering.links-client-only") ?? [];
    const lines = linkEdit?.code?.split("\n") ?? [];

    expect(linkEdit).toMatchObject({ action: "add", at: "#root" });
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('<a href="/widgets/0/" class="card">Widget 0</a>');
    expect(fixOf(findings, "rendering.content-client-only")).toMatchObject([
      {
        action: "add",
        at: "#root",
        code: "{{the page's main content, as HTML}}",
      },
    ]);
  });

  it("names the script that throws", () => {
    // The message is what the browser logged, not text in the script: it goes into `write`.
    expect(fixOf(findings, "rendering.console-errors")).toStrictEqual([
      {
        in: "asset",
        action: "replace",
        url: "https://www.example.com/app.js",
        at: "whole file",
        code: "{{code that does not throw}}",
        write: expect.stringContaining(
          "TypeError: cart is undefined at https://www.example.com/app.js:1:200"
        ),
      },
    ]);
  });
});

describe("fixes for what JavaScript changes", () => {
  const raw = `<!doctype html><html><head><title>Acme</title><link rel="canonical" href="https://www.example.com/"><meta name="robots" content="noindex, follow"></head><body><h1>Widgets</h1></body></html>`;
  const rendered = `<html><head><title>Blue widgets | Acme</title><link rel="canonical" href="https://www.example.com/widgets/"></head><body><h1>Widgets</h1></body></html>`;
  const findings = compare(raw, rendered);

  it("rewrites the server's title and canonical to what JavaScript ends with", () => {
    expectSoundFixes(findings);
    expect(fixOf(findings, "rendering.title-changed")).toMatchObject([
      {
        action: "replace",
        current: "<title>Acme</title>",
        code: "<title>Blue widgets | Acme</title>",
      },
    ]);
    expect(fixOf(findings, "rendering.canonical-changed")).toMatchObject([
      {
        action: "replace",
        current: '<link rel="canonical" href="https://www.example.com/">',
        code: '<link rel="canonical" href="https://www.example.com/widgets/">',
      },
    ]);
  });

  it("removes the server's noindex that JavaScript takes away, from the tag or the header", () => {
    expect(fixOf(findings, "rendering.noindex-removed-by-js")).toMatchObject([
      {
        in: "html",
        action: "remove",
        current: '<meta name="robots" content="noindex, follow">',
      },
    ]);

    const fromHeader = compare(
      "<html><head><title>T</title></head><body></body></html>",
      "<html><head><title>T</title></head><body></body></html>",
      [],
      {
        status: 200,
        finalUrl: URL_PAGE,
        redirectChain: [],
        timeMs: 10,
        contentType: "text/html",
        headers: { "x-robots-tag": "noindex" },
      }
    );

    expect(fixOf(fromHeader, "rendering.noindex-removed-by-js")).toMatchObject([
      { in: "http", action: "remove", current: "X-Robots-Tag: noindex" },
    ]);
  });
});

const lighthouseResult = (
  overrides: Partial<PerformanceResult> = {}
): PerformanceResult => ({
  tool: "lighthouse",
  lighthouseVersion: "13.6.0",
  formFactor: "mobile",
  requestedUrl: URL_PAGE,
  finalUrl: URL_PAGE,
  metrics: {
    performanceScore: 31,
    seoScore: 90,
    agenticBrowsingScore: 50,
    lcpMs: 5200,
    cls: 0.31,
    tbtMs: 750,
    fcpMs: 3400,
    speedIndexMs: 4000,
    ttfbMs: 1200,
    inpMs: null,
  },
  opportunities: [],
  failedSeoAudits: [],
  agenticBrowsingAudits: [],
  ...overrides,
});

const NODE = {
  selector: "main > img.hero",
  snippet: '<img class="hero" src="/img/hero.jpg" loading="lazy">',
  label: "Hero",
  name: "img",
  width: 400,
  height: 300,
};

describe("fixes for what Lighthouse measures", () => {
  const result = lighthouseResult({
    lcpElement: {
      node: NODE,
      imageUrl: "https://www.example.com/img/hero.jpg",
      hasSrcset: false,
      fetchpriorityHigh: false,
      discoverable: false,
      notLazy: false,
      phases: { timeToFirstByte: 1200, resourceLoadDuration: 300 },
    },
    unsizedImages: [
      {
        url: "https://www.example.com/img/a.png",
        node: { ...NODE, selector: "article > img.a", width: 640, height: 480 },
      },
    ],
    layoutShifts: [
      {
        url: "https://fonts.gstatic.com/s/inter.woff2",
        node: { ...NODE, selector: "h1", name: "h1" },
        text: "Web font",
      },
      {
        node: { ...NODE, selector: "#banner", name: "div", height: 120 },
      },
    ],
    renderBlocking: [
      { url: "https://www.example.com/js/vendor.js", wastedMs: 300 },
      { url: "https://www.example.com/css/site.css", totalBytes: 4096 },
    ],
    scripts: [
      { url: "https://www.example.com/js/app.js", wastedMs: 900 },
      { url: "https://ads.example.net/tag.js", wastedMs: 400 },
      { url: "https://www.example.com/js/tiny.js", wastedMs: 20 },
    ],
    opportunities: [
      {
        id: "unused-javascript",
        title: "Reduce unused JavaScript",
        description: "Reduce unused JavaScript.",
        score: 0,
        savingsMs: 600,
        savingsBytes: 200_000,
        items: [
          {
            url: "https://www.example.com/js/app.js",
            totalBytes: 409_600,
            wastedBytes: 204_800,
          },
          {
            url: "https://ads.example.net/tag.js",
            totalBytes: 102_400,
            wastedBytes: 51_200,
          },
        ],
      },
      {
        id: "cache-insight",
        title: "Use efficient cache lifetimes",
        description: "A long cache lifetime can speed up repeat visits.",
        score: 0.5,
        savingsMs: null,
        savingsBytes: 50_000,
        items: [
          { url: "https://www.example.com/js/app.js", totalBytes: 409_600 },
          { url: "https://ads.example.net/tag.js", totalBytes: 20_000 },
        ],
      },
      {
        id: "dom-size-insight",
        title: "Optimize DOM size",
        description:
          "A large DOM can increase the duration of style calculations.",
        score: 0,
        savingsMs: 10,
        savingsBytes: null,
        items: [],
      },
    ],
    failedSeoAudits: [
      {
        id: "robots-txt",
        title: "robots.txt is not valid",
        description: "If your robots.txt file is malformed …",
        score: 0,
        displayValue: "1 error found",
        items: [
          { line: "Disalow: /cart", lineNumber: 4, text: "Unknown directive" },
        ],
      },
      {
        id: "crawlable-anchors",
        title: "Links are not crawlable",
        description: "Search engines may use href attributes …",
        score: 0,
        displayValue: null,
        items: [
          {
            node: {
              ...NODE,
              selector: "nav > a.menu",
              snippet: '<a class="menu" onclick="go()">',
              name: "a",
            },
          },
        ],
      },
    ],
    agenticBrowsingAudits: [
      {
        id: "agent-accessibility-tree",
        title: "Accessibility tree is not well-formed",
        description: "A well-formed accessibility tree …",
        score: 0,
        displayValue: null,
        items: [
          {
            text: "ARIA role should be appropriate for the element",
            node: {
              ...NODE,
              selector: "aside.banner",
              snippet: '<aside class="banner" role="dialog">',
              name: "aside",
            },
          },
        ],
      },
      {
        id: "llms-txt",
        title: "llms.txt does not follow recommendations",
        description: "If your llms.txt file …",
        score: 0,
        displayValue: null,
      },
    ],
  });

  const findings = performanceFindings(result);

  const opportunity = (id: string) =>
    findings.find(
      (f) => f.rule === "perf.opportunity" && f.evidence?.["auditId"] === id
    )?.fix;

  const failed = (id: string) =>
    findings.find((f) => f.evidence?.["auditId"] === id)?.fix;

  it("gives every performance finding a complete fix", () => {
    expect(new Set(findings.map((f) => f.rule))).toStrictEqual(
      new Set([
        "perf.lcp-slow",
        "perf.cls-high",
        "perf.tbt-high",
        "perf.fcp-slow",
        "perf.ttfb-slow",
        "perf.score-low",
        "perf.opportunity",
        "lighthouse.seo-audit-failed",
        "lighthouse.agentic-audit-failed",
      ])
    );
    expectSoundFixes(findings);
  });

  it("loads the LCP image at once, early and first, and caches slow HTML", () => {
    expect(fixOf(findings, "perf.lcp-slow")).toMatchObject([
      {
        in: "html",
        action: "remove",
        at: "main > img.hero",
        current: 'loading="lazy"',
      },
      { action: "add", at: "main > img.hero", code: 'fetchpriority="high"' },
      {
        action: "add",
        at: "head",
        code: '<link rel="preload" as="image" href="https://www.example.com/img/hero.jpg" fetchpriority="high">',
      },
      { in: "http", action: "add", at: "Cache-Control" },
    ]);
    expect(fixOf(findings, "perf.ttfb-slow")).toMatchObject([
      {
        in: "http",
        code: "Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
      },
    ]);
  });

  it("quotes nothing from an asset it measured: sizes and times go into write", () => {
    const quoted = findings
      .flatMap((f) => f.fix ?? [])
      .filter((e) => e.in === "asset" && e.current !== undefined);

    expect(quoted).toStrictEqual([]);
  });

  it.each([
    ["a React useId id", "div#:r1:"],
    ["an id that starts with a digit", "div#1-ad"],
    ["a selector Lighthouse cut short", "div.ad-slot…"],
    ["an id that would end the <style>", "div#x</style><script>"],
  ])(
    "asks for a selector when Lighthouse's is not valid CSS: %s",
    (_, selector) => {
      const [edit] = clsEdits(
        lighthouseResult({
          layoutShifts: [
            { node: { ...NODE, selector, name: "div", height: 120 } },
          ],
        })
      );

      expect(edit).toMatchObject({
        at: "head",
        code: "<style>{{a CSS selector for this element}} { min-height: 120px; }</style>",
        write: expect.stringContaining(selector),
      });
    }
  );

  it("sizes images, keeps fallback fonts and reserves space against layout shifts", () => {
    expect(fixOf(findings, "perf.cls-high")).toMatchObject([
      { at: "article > img.a", code: 'width="640" height="480"' },
      {
        in: "asset",
        url: "https://fonts.gstatic.com/s/inter.woff2",
        code: "font-display: optional;",
      },
      { at: "head", code: "<style>#banner { min-height: 120px; }</style>" },
    ]);
  });

  it("defers blocking scripts and inlines small blocking CSS", () => {
    expect(fixOf(findings, "perf.fcp-slow")).toMatchObject([
      { action: "add", at: 'script[src*="/js/vendor.js"]', code: "defer" },
      {
        action: "add",
        at: "head",
        code: "<style>{{the CSS of the stylesheets listed below}}</style>",
      },
      { in: "http", at: "Cache-Control" },
    ]);
  });

  it("names the scripts with the most main-thread time", () => {
    expect(fixOf(findings, "perf.tbt-high")).toMatchObject([
      { in: "asset", url: "https://www.example.com/js/app.js" },
      { in: "asset", url: "https://ads.example.net/tag.js" },
    ]);
  });

  it("turns each opportunity into edits of the files it names", () => {
    expect(opportunity("unused-javascript")).toMatchObject([
      {
        in: "asset",
        action: "replace",
        url: "https://www.example.com/js/app.js",
        at: "whole file",
        code: "{{the file, rebuilt as write says}}",
        write: expect.stringMatching(
          /^400 KiB, 200 KiB of it not needed; aim for 200 KiB or less\. Remove the code this page does not run/u
        ),
      },
      {
        url: "https://ads.example.net/tag.js",
        write: expect.stringContaining(
          "not needed; aim for 50 KiB or less. Another site's file"
        ),
      },
    ]);
    // Another site's cache lifetime is not the site's to set.
    expect(opportunity("cache-insight")).toMatchObject([
      {
        in: "http",
        url: "https://www.example.com/js/app.js",
        code: "Cache-Control: public, max-age=31536000, immutable",
      },
    ]);
    expect(opportunity("dom-size-insight")).toMatchObject([
      {
        in: "html",
        action: "add",
        code: "{{the change Lighthouse describes}}",
      },
    ]);
  });

  it("fixes failed SEO and agentic-browsing audits where they point", () => {
    expect(failed("robots-txt")).toMatchObject([
      {
        in: "robots.txt",
        action: "replace",
        at: "line 4",
        current: "Disalow: /cart",
      },
    ]);
    expect(failed("crawlable-anchors")).toMatchObject([
      { at: "nav > a.menu", code: 'href="{{URL the link goes to}}"' },
    ]);
    expect(failed("agent-accessibility-tree")).toMatchObject([
      {
        action: "replace",
        at: "aside.banner",
        current: "<aside",
        code: "<div",
      },
    ]);
    expect(failed("llms-txt")).toMatchObject([
      { in: "llms.txt", action: "add", at: "/llms.txt" },
    ]);
  });

  it("still gives a fix when Lighthouse names nothing", () => {
    const bare = performanceFindings(lighthouseResult());
    expectSoundFixes(bare);
    expect(fixOf(bare, "perf.cls-high")?.[0]).toMatchObject({
      at: "img:not([width])",
    });
  });
});

/** A Lighthouse node value, as the result JSON writes it. */
const node = (selector: string, snippet: string, lhId: string) => ({
  type: "node",
  lhId,
  selector,
  snippet,
  nodeLabel: "label",
  boundingRect: { width: 392.4, height: 314 },
});

describe("what summarize keeps for fixes", () => {
  const lhr = {
    lighthouseVersion: "13.6.0",
    finalDisplayedUrl: URL_PAGE,
    categories: {
      performance: {
        score: 0.4,
        auditRefs: [
          { id: "largest-contentful-paint", weight: 25, group: "metrics" },
          { id: "unused-javascript", weight: 0, group: "diagnostics" },
        ],
      },
      seo: { score: 0.9, auditRefs: [{ id: "robots-txt", weight: 1 }] },
    },
    audits: {
      "largest-contentful-paint": {
        id: "largest-contentful-paint",
        title: "LCP",
        description: "",
        score: 0.2,
        scoreDisplayMode: "numeric",
        numericValue: 5200,
      },
      "lcp-discovery-insight": {
        id: "lcp-discovery-insight",
        title: "LCP request discovery",
        description: "",
        score: 0,
        scoreDisplayMode: "numeric",
        details: {
          type: "list",
          items: [
            {
              type: "checklist",
              items: {
                priorityHinted: { label: "fetchpriority", value: false },
                requestDiscoverable: { label: "discoverable", value: true },
                eagerlyLoaded: { label: "not lazy", value: true },
              },
            },
            node(
              "main > img.hero",
              '<img class="hero" src="https://www.example.com/img/her…">',
              "page-0-IMG"
            ),
          ],
        },
      },
      "lcp-breakdown-insight": {
        id: "lcp-breakdown-insight",
        title: "LCP breakdown",
        description: "",
        score: 1,
        scoreDisplayMode: "informative",
        details: {
          type: "list",
          items: [
            {
              type: "table",
              headings: [],
              items: [
                { subpart: "timeToFirstByte", duration: 102.4 },
                { subpart: "resourceLoadDuration", duration: 310.3 },
              ],
            },
          ],
        },
      },
      "network-requests": {
        id: "network-requests",
        title: "Network requests",
        description: "",
        score: 1,
        scoreDisplayMode: "informative",
        details: {
          type: "table",
          items: [
            {
              url: "https://www.example.com/img/hero.jpg?w=750",
              resourceType: "Image",
            },
            { url: "https://www.example.com/app.js", resourceType: "Script" },
          ],
        },
      },
      "unused-javascript": {
        id: "unused-javascript",
        title: "Reduce unused JavaScript",
        description: "Reduce unused JavaScript.",
        score: 0,
        scoreDisplayMode: "metricSavings",
        metricSavings: { LCP: 500 },
        details: {
          type: "opportunity",
          overallSavingsMs: 500,
          overallSavingsBytes: 200_000,
          items: [
            {
              url: "https://www.example.com/app.js",
              totalBytes: 409_600.4,
              wastedBytes: 204_800,
            },
          ],
        },
      },
      "cls-culprits-insight": {
        id: "cls-culprits-insight",
        title: "Layout shift culprits",
        description: "",
        score: 0,
        scoreDisplayMode: "numeric",
        details: {
          type: "list",
          items: [
            {
              type: "table",
              items: [
                { node: { type: "text", value: "Total" }, score: 0.3 },
                {
                  node: node("h1", "<h1>", "page-1-H1"),
                  score: 0.2,
                  subItems: {
                    type: "subitems",
                    items: [
                      {
                        cause: "Web font",
                        extra: {
                          type: "url",
                          value: "https://fonts.example.com/inter.woff2",
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      "bootup-time": {
        id: "bootup-time",
        title: "JavaScript execution time",
        description: "",
        score: 0.5,
        scoreDisplayMode: "numeric",
        details: {
          type: "table",
          items: [
            {
              url: "https://www.example.com/app.js",
              total: 900,
              scripting: 700.2,
            },
            { url: "Unattributable", total: 300, scripting: 100 },
          ],
        },
      },
      "robots-txt": {
        id: "robots-txt",
        title: "robots.txt is not valid",
        description: "Malformed robots.txt.",
        score: 0,
        scoreDisplayMode: "binary",
        details: {
          type: "table",
          items: [
            {
              index: "4",
              line: "Disalow: /cart",
              message: "Unknown directive",
            },
          ],
        },
      },
    },
  };

  const result = summarize(lhr, URL_PAGE, "mobile");

  it("keeps the LCP element, its checks and phases, and finds its image request", () => {
    expect(result.lcpElement).toStrictEqual({
      node: {
        selector: "main > img.hero",
        snippet: '<img class="hero" src="https://www.example.com/img/her…">',
        label: "label",
        name: "img",
        width: 392,
        height: 314,
      },
      imageUrl: "https://www.example.com/img/hero.jpg?w=750",
      hasSrcset: false,
      fetchpriorityHigh: false,
      discoverable: true,
      notLazy: true,
      phases: { timeToFirstByte: 102, resourceLoadDuration: 310 },
    });
  });

  /** The LCP image request summarize finds for an <img> written as `snippet`, with these images in the log. */
  const lcpImage = (snippet: string, images: string[]) => {
    const copy = structuredClone(lhr);
    copy.audits["lcp-discovery-insight"].details.items[1] = node(
      "main > img.hero",
      snippet,
      "page-0-IMG"
    );
    copy.audits["network-requests"].details.items = images.map((url) => ({
      url,
      resourceType: "Image",
    }));

    return summarize(copy, URL_PAGE, "mobile").lcpElement?.imageUrl;
  };

  it("reads the LCP image's src as the browser does, & for &amp;", () => {
    const url = "https://cdn.example.com/hero.jpg?w=1200&q=75";

    expect(
      lcpImage(
        '<img class="hero" src="https://cdn.example.com/hero.jpg?w=1200&amp;q=75">',
        [url]
      )
    ).toBe(url);
    // Not in the log at all: the src as the browser reads it, not with &amp; in it.
    expect(
      lcpImage(
        '<img class="hero" src="https://cdn.example.com/hero.jpg?w=1200&amp;q=75">',
        []
      )
    ).toBe(url);
  });

  it("names no LCP image when the browser fetched another candidate than the src", () => {
    // An <img> in a <picture>: the browser fetched the AVIF <source>, not the JPEG fallback.
    expect(
      lcpImage('<img class="hero" src="https://cdn.example.com/hero.jpg">', [
        "https://cdn.example.com/hero.avif",
      ])
    ).toBeNull();
  });

  it("keeps the rows of opportunities, layout shifts, scripts and failed audits", () => {
    expect(result.opportunities[0]?.items).toStrictEqual([
      {
        url: "https://www.example.com/app.js",
        totalBytes: 409_600,
        wastedBytes: 204_800,
      },
    ]);
    expect(result.layoutShifts).toMatchObject([
      {
        url: "https://fonts.example.com/inter.woff2",
        node: { selector: "h1", name: "h1" },
        text: "Web font",
      },
    ]);
    expect(result.scripts).toStrictEqual([
      { url: "https://www.example.com/app.js", wastedMs: 700 },
    ]);
    expect(result.failedSeoAudits[0]?.items).toStrictEqual([
      { line: "Disalow: /cart", lineNumber: 4, text: "Unknown directive" },
    ]);
  });

  it("drops values of the wrong shape instead of failing", () => {
    const odd = summarize(
      {
        ...lhr,
        audits: {
          ...lhr.audits,
          "bootup-time": {
            ...lhr.audits["bootup-time"],
            details: { type: "table", items: [{ url: 5, scripting: "slow" }] },
          },
        },
      },
      URL_PAGE,
      "mobile"
    );

    expect(odd.scripts).toBeUndefined();
    expect(odd.lcpElement?.node.selector).toBe("main > img.hero");
  });
});

describe("perf.opportunity for render-blocking resources", () => {
  it("falls back to the blocking resources the report lists when the audit has no items", () => {
    const findings = performanceFindings(
      lighthouseResult({
        renderBlocking: [
          { url: "https://www.example.com/js/vendor.js", wastedMs: 300 },
        ],
        opportunities: [
          {
            id: "render-blocking-resources",
            title: "Eliminate render-blocking resources",
            description: "Resources are blocking the first paint of your page.",
            score: 0,
            savingsMs: 300,
            savingsBytes: null,
            items: [],
          },
        ],
      })
    );

    const fix = findings.find(
      (f) =>
        f.rule === "perf.opportunity" &&
        f.evidence?.["auditId"] === "render-blocking-resources"
    )?.fix;

    expect(JSON.stringify(fix)).toContain("/js/vendor.js");
  });

  it("defers a blocking script whose URL has no .js extension", () => {
    const maps = "https://maps.googleapis.com/maps/api/js?key=abc";

    const findings = performanceFindings(
      lighthouseResult({
        opportunities: [
          {
            id: "render-blocking-resources",
            title: "Eliminate render-blocking resources",
            description: "Resources are blocking the first paint of your page.",
            score: 0,
            savingsMs: 300,
            savingsBytes: null,
            items: [{ url: maps, wastedMs: 300 }],
          },
        ],
      })
    );

    const fix = findings.find(
      (f) =>
        f.rule === "perf.opportunity" &&
        f.evidence?.["auditId"] === "render-blocking-resources"
    )?.fix;

    expect(fix).toMatchObject([
      {
        action: "add",
        at: 'script[src*="maps.googleapis.com/maps/api/js"]',
        code: "defer",
      },
    ]);
  });
});

/** The edit for an agent-accessibility-tree problem `text` on the element `snippet`. */
const roleFix = (text: string, snippet: string, name: string) =>
  performanceFindings(
    lighthouseResult({
      agenticBrowsingAudits: [
        {
          id: "agent-accessibility-tree",
          title: "Accessibility tree is not well-formed",
          description: "A well-formed accessibility tree …",
          score: 0,
          displayValue: null,
          items: [{ text, node: { ...NODE, selector: name, snippet, name } }],
        },
      ],
    })
  ).find((f) => f.evidence?.["auditId"] === "agent-accessibility-tree")?.fix;

describe("fixes for a role the accessibility tree reports", () => {
  it.each([
    [
      "ARIA roles used must conform to valid values",
      '<button role="buton">',
      "button",
    ],
    [
      "Certain ARIA roles must contain particular children",
      '<ul role="listbox">',
      "ul",
    ],
    [
      "Certain ARIA roles must be contained by particular parents",
      '<div role="tab">',
      "div",
    ],
  ])("leaves the element and its role alone for %j", (text, snippet, name) => {
    expect(roleFix(text, snippet, name)).toMatchObject([
      { action: "add", at: name, code: "{{the change the problem asks for}}" },
    ]);
  });

  it("removes a role an element with no closing tag does not allow, rather than make it a <div", () => {
    expect(
      roleFix(
        "ARIA role should be appropriate for the element",
        '<img src="/a.png" role="dialog">',
        "img"
      )
    ).toMatchObject([{ action: "remove", current: 'role="dialog"' }]);
  });
});
