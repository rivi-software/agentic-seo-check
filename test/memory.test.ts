/**
 * What a crawl keeps of its pages. The hosted Worker has 128 MB, and a crawl keeps every page's
 * extract to the end for the site rules, so it must keep neither a page's HTML nor a copy for each
 * page of the links every page repeats: a crawl of a large site ran the website's Worker out of
 * memory on both. Measured on the heap after a garbage collection, with wide margins.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { seoCrawlOptions } from "../src/core/audit.js";
import { crawlSite } from "../src/core/crawl.js";
import { extractPage } from "../src/core/html/extract.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import type { Routes } from "./helpers/fixture-server.js";

// Vitest runs each file in a worker of its own, so the flag reaches no other file's tests.
setFlagsFromString("--expose-gc");

// SAFETY: --expose-gc, set just above, gives every new context a global `gc`, V8's collector.
const collectGarbage = runInNewContext("gc") as () => void;

/** The bytes the heap holds once garbage is collected. */
const liveHeap = (): number => {
  collectGarbage();
  collectGarbage();

  return process.memoryUsage().heapUsed;
};

describe("what an extracted page keeps", () => {
  it("keeps none of the page's HTML in the tags it quotes", () => {
    const pages = 10;
    // A curly apostrophe makes V8 store the page in two bytes a character, as most real pages.
    const filler = `It’s ${"inline application data ".repeat(40_000)}`;

    const html = (i: number) =>
      `<!doctype html><html lang="en"><head><title>Page ${i} of a large site</title><meta name="description" content="The description of page ${i}, long enough to quote."><link rel="canonical" href="https://large.example/p/${i}"></head><body><h1>Heading of page ${i}</h1><p><a href="/p/${i + 1}" class="next-page">The next page</a></p><script type="application/json">${JSON.stringify({ filler, i })}</script></body></html>`;

    const extract = (i: number) =>
      extractPage(html(i), {
        url: `https://large.example/p/${i}`,
        siteHost: "large.example",
      });

    // The first extract also fills the parser's and the selectors' caches, which stay.
    extract(pages);
    const before = liveHeap();
    const kept = Array.from({ length: pages }, (_, i) => extract(i));

    const perPage = (liveHeap() - before) / pages;

    expect(kept.map((page) => page.title)).toContain("Page 3 of a large site");
    // Each page's HTML is 2 MB in memory; what is extracted from it, some kilobytes.
    expect(perPage).toBeLessThan(html(0).length / 10);
  });
});

describe("what a crawl keeps of its pages' links", () => {
  const pages = 20;
  const menuLinks = 1000;

  const pageLinks = Array.from(
    { length: pages },
    (_, j) => `<a href="/p/${j}">Page ${j}</a>`
  ).join("");

  /** A site whose every page has the same 1,000-link menu, written alike on each page or not. */
  const site = (alike: boolean): Routes => {
    const page = (i: number) => {
      // The same targets either way, so that only the links' own strings differ.
      const menu = Array.from(
        { length: menuLinks },
        (_, j) =>
          `<li><a href="/c/${j}" class="menu-item${alike ? "" : ` from-${i}`}">Category ${j} of the shop</a></li>`
      ).join("");

      return {
        body: `<!doctype html><html lang="en"><head><title>Page ${i}</title></head><body><main>${pageLinks}</main><nav><ul>${menu}</ul></nav></body></html>`,
      };
    };

    return Object.fromEntries([
      ["/", page(0)],
      ...Array.from({ length: pages }, (_, i) => [`/p/${i}`, page(i)]),
    ]);
  };

  /** The heap a crawl of the site keeps, with the crawl's result still held. */
  const keptByCrawl = async (alike: boolean): Promise<number> => {
    const server = await startFixtureServer(site(alike));

    try {
      const before = liveHeap();

      const result = await crawlSite(`${server.origin}/`, {
        ...seoCrawlOptions({
          maxPages: pages + 1,
          maxDepth: 2,
          respectRobots: false,
          maxLinkChecks: 0,
        }),
        siteChecks: false,
      });

      const kept = liveHeap() - before;

      expect(result.records).toHaveLength(pages + 1);
      expect(result.records[1]?.page.links).toHaveLength(pages + menuLinks);

      return kept;
    } finally {
      await server.close();
    }
  };

  it("keeps the strings of a link every page repeats once", async () => {
    // The first crawl also fills the caches that stay, so neither measured crawl pays for them.
    await keptByCrawl(true);
    const differing = await keptByCrawl(false);
    const repeated = await keptByCrawl(true);

    // A link's strings are most of what the crawl keeps of it: once shared, the repeated menu
    // costs the crawl its link objects alone.
    expect(repeated).toBeLessThan(differing * 0.6);
  });
});
