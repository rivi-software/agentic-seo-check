import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditDirectory, auditSite } from "../src/core/audit.js";
import {
  emptySitemapProblems,
  inspectSitemap,
  SITEMAP_MAX_URLS,
  sitemapText,
} from "../src/core/sitemap.js";
import type { Finding } from "../src/core/types.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer, Route, Routes } from "./helpers/fixture-server.js";

const page = (title: string, head = "", body = ""): Route => ({
  body: `<!DOCTYPE html><html lang="en"><head><title>${title} of the robots fixture</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`,
});

const urlset = (entries: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;

const find = (findings: Finding[], rule: string) =>
  findings.find((f) => f.rule === rule);

describe("robots.txt and sitemaps of a crawled site", () => {
  let server: FixtureServer;
  let findings: Finding[];
  let sitemapUrls: string[];

  beforeAll(async () => {
    const routes: Routes = {
      "/": page(
        "Home",
        '<script src="/assets/private/app.js"></script><link rel="stylesheet" href="/assets/site.css"><script src="https://cdn.example.org/lib.js"></script>',
        '<a href="/about">About</a> <a href="/checkout">Checkout</a>'
      ),
      "/about": page("About", "", '<a href="/">Home</a>'),
      // A noindex page needs no rendering by Google, so its blocked script is not reported.
      "/checkout": page(
        "Checkout",
        '<meta name="robots" content="noindex"><script src="/assets/private/checkout.js"></script>',
        '<a href="/">Home</a>'
      ),
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nDisallow: /assets/private/\nCrawl-delay: 10\nNoindex: /old/  # retired\nSitemap: __ORIGIN__/sitemap_index.xml\n",
      },
      "/sitemap_index.xml": {
        headers: { "content-type": "application/xml" },
        body: '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>__ORIGIN__/sitemap-pages.xml.gz</loc></sitemap><sitemap><loc>__ORIGIN__/nested-index.xml</loc></sitemap></sitemapindex>',
      },
      "/nested-index.xml": {
        headers: { "content-type": "application/xml" },
        body: '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>__ORIGIN__/sitemap-posts.xml</loc></sitemap></sitemapindex>',
      },
      "/sitemap-posts.xml": {
        headers: { "content-type": "application/xml" },
        body: urlset("<url><loc>__ORIGIN__/about</loc></url>"),
      },
    };

    server = await startFixtureServer(routes);

    // The gzip file holds the server's own origin, which is known only once it listens.
    routes["/sitemap-pages.xml.gz"] = {
      headers: { "content-type": "application/gzip" },
      body: gzipSync(
        urlset(
          `<url><loc>${server.origin}/</loc><lastmod>09/11/2026</lastmod></url><url><loc>${server.origin}/about</loc><lastmod>2999-01-01</lastmod></url><url><loc>https://other.example/x</loc><lastmod>2026-11-09T10:00:00+01:00</lastmod></url>`
        )
      ),
    };

    const site = await auditSite(server.origin, {
      maxPages: 10,
      maxDepth: 2,
      concurrency: 2,
    });

    findings = site.siteFindings;
    sitemapUrls = site.sitemaps.urls;
  });

  afterAll(async () => {
    await server.close();
  });

  it("reads a gzip sitemap from an index", () => {
    expect(sitemapUrls).toContain("https://other.example/x");
    expect(findings.map((f) => f.rule)).not.toContain("site.sitemap-error");
  });

  it("site.robots-txt-unsupported-rule lists noindex and crawl-delay lines", () => {
    const f = find(findings, "site.robots-txt-unsupported-rule");

    expect(f?.severity).toBe("warning");
    expect(f?.evidence).toMatchObject({
      retired: ["line 4: Noindex: /old/"],
      crawlDelay: ["line 3: Crawl-delay: 10"],
    });
  });

  it("site.robots-blocks-resources checks the site's own scripts and stylesheets for Googlebot", () => {
    expect(
      find(findings, "site.robots-blocks-resources")?.evidence
    ).toStrictEqual({
      count: 1,
      examples: [{ url: `${server.origin}/assets/private/app.js`, pages: 1 }],
    });
  });

  it("site.sitemap-index-nested names the index another index lists", () => {
    expect(find(findings, "site.sitemap-index-nested")?.evidence).toStrictEqual(
      {
        indexes: [`${server.origin}/nested-index.xml`],
      }
    );
  });

  it("checks lastmod format, future dates and hosts", () => {
    expect(
      find(findings, "site.sitemap-lastmod-invalid")?.evidence
    ).toStrictEqual({
      count: 1,
      examples: [`${server.origin}/ (09/11/2026)`],
    });

    expect(
      find(findings, "site.sitemap-lastmod-future")?.evidence
    ).toStrictEqual({
      count: 1,
      examples: [`${server.origin}/about (2999-01-01)`],
    });

    expect(find(findings, "site.sitemap-other-host")?.evidence).toMatchObject({
      count: 1,
    });
  });
});

describe("robots.txt over 500 KiB", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer({
      "/": page("Home"),
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: `User-agent: *\nAllow: /\n${"# padding line for a large robots file\n".repeat(14_000)}`,
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("site.robots-txt-too-large reports the size", async () => {
    const site = await auditSite(server.origin, { maxPages: 2 });

    expect(
      find(site.siteFindings, "site.robots-txt-too-large")?.evidence
    ).toMatchObject({ bytes: expect.any(Number) });
  });
});

describe("sitemap protocol limits", () => {
  it("flags a sitemap over 50,000 URLs", () => {
    const problems = emptySitemapProblems();

    const locs = Array.from(
      { length: SITEMAP_MAX_URLS + 1 },
      (_, i) => `https://www.example.com/p/${i}`
    );

    inspectSitemap(
      problems,
      "https://www.example.com/sitemap.xml",
      { kind: "urlset", locs, lastmods: locs.map(() => null) },
      1000,
      { fromIndex: false, siteHost: "www.example.com", now: Date.now() }
    );

    expect(problems.oversized).toStrictEqual([
      {
        sitemap: "https://www.example.com/sitemap.xml",
        urls: SITEMAP_MAX_URLS + 1,
        bytes: 1000,
        overLimit: true,
      },
    ]);
  });

  it("stops inflating a gzip sitemap at the 15 MB read budget", async () => {
    const bomb = gzipSync(Buffer.alloc(16_000_000, 0x20));

    await expect(sitemapText(bomb)).resolves.toMatchObject({ tooLarge: true });
    await expect(
      sitemapText(Buffer.from("not gzip, plain text"))
    ).resolves.toStrictEqual({
      text: "not gzip, plain text",
      bytes: 20,
    });
  });
});

describe("a sitemap too large to read in build output", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-bigmap-"));
    await writeFile(
      path.join(dir, "index.html"),
      '<!DOCTYPE html><html lang="en"><head><title>Home of the build output</title></head><body><h1>Home</h1></body></html>'
    );
    await writeFile(
      path.join(dir, "sitemap.xml"),
      Buffer.alloc(16_000_000, 0x20)
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is reported as too large to read, not as missing", async () => {
    const site = await auditDirectory(dir);
    const rules = site.siteFindings.map((f) => [f.rule, f.severity]);

    expect(rules).toContainEqual(["site.sitemap-too-large", "info"]);
    expect(rules.map(([rule]) => rule)).not.toContain("site.sitemap-missing");
  });
});

describe("gzip sitemaps in build output", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-sitemap-"));
    await writeFile(
      path.join(dir, "index.html"),
      '<!DOCTYPE html><html lang="en"><head><title>Home of the build output</title></head><body><h1>Home</h1></body></html>'
    );
    await writeFile(
      path.join(dir, "robots.txt"),
      "User-agent: *\nAllow: /\nSitemap: https://www.example.com/sitemap.xml.gz\n"
    );
    await writeFile(
      path.join(dir, "sitemap.xml.gz"),
      gzipSync(
        urlset(
          "<url><loc>https://www.example.com/</loc><lastmod>2026-11-01</lastmod></url>"
        )
      )
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not read a sitemap outside the output directory", async () => {
    const outside = `${dir}-secret.txt`;
    await writeFile(outside, "https://www.example.com/leaked\n");
    await writeFile(
      path.join(dir, "robots.txt"),
      `User-agent: *\nAllow: /\nSitemap: http://localhost/..%2f${path.basename(outside)}\n`
    );

    const site = await auditDirectory(dir);

    expect(site.sitemaps.urls).not.toContain("https://www.example.com/leaked");
    expect(site.sitemaps.errors.join(" ")).toContain(
      "points outside the output directory"
    );

    await writeFile(
      path.join(dir, "robots.txt"),
      "User-agent: *\nAllow: /\nSitemap: https://www.example.com/sitemap.xml.gz\n"
    );
    await rm(outside);
  });

  it("reads the gzip file and skips the host check on the placeholder host", async () => {
    const site = await auditDirectory(dir);

    expect(site.sitemaps.urls).toStrictEqual(["https://www.example.com/"]);
    expect(site.sitemaps.problems.otherHost.count).toBe(0);
    expect(site.siteFindings.map((f) => f.rule)).not.toContain(
      "site.sitemap-error"
    );
  });
});
