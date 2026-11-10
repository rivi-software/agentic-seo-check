import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditDirectory, auditSite } from "../src/core/audit.js";
import { DEFAULT_USER_AGENT } from "../src/core/fetch.js";
import { buildRobots } from "../src/core/robots.js";
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

const SITE_RULES_HERE = new Set([
  "site.robots-txt-too-large",
  "site.robots-txt-unsupported-rule",
  "site.robots-blocks-resources",
  "site.sitemap-too-large",
  "site.sitemap-index-nested",
  "site.sitemap-lastmod-invalid",
  "site.sitemap-lastmod-future",
  "site.sitemap-other-host",
  "site.sitemap-error",
  "site.sitemap-missing",
]);

/** A urlset with every lastmod form that passes: a date, a time with a zone, a time without one. */
const validUrlset = (origin: string) =>
  urlset(
    `<url><loc>${origin}/</loc><lastmod>2026-11-01</lastmod></url><url><loc>${origin}/about</loc><lastmod>2026-11-02T09:30:00+01:00</lastmod></url><url><loc>${origin}/team</loc><lastmod>2026-11-03T09:30:00</lastmod></url>`
  );

const QUIET_ROBOTS = "User-agent: *\nDisallow: /private/\nAllow: /\n";

describe("a valid site gives none of the robots.txt and sitemap findings", () => {
  let server: FixtureServer;
  let dir: string;

  beforeAll(async () => {
    const routes: Routes = {
      "/": page(
        "Home",
        '<script src="/assets/app.js" defer></script><link rel="stylesheet" href="/assets/site.css">',
        '<a href="/about">About</a> <a href="/team">Team</a>'
      ),
      "/about": page("About", "", '<a href="/">Home</a>'),
      "/team": page("Team", "", '<a href="/">Home</a>'),
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: `${QUIET_ROBOTS}Sitemap: __ORIGIN__/sitemap_index.xml\n`,
      },
      "/sitemap_index.xml": {
        headers: { "content-type": "application/xml" },
        body: '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>__ORIGIN__/pages.xml.gz</loc><lastmod>2026-11-03</lastmod></sitemap></sitemapindex>',
      },
    };

    server = await startFixtureServer(routes);
    routes["/pages.xml.gz"] = {
      headers: { "content-type": "application/gzip" },
      body: gzipSync(validUrlset(server.origin)),
    };

    // The same site as build output, with the URLs on the www. host of the production base URL.
    dir = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-quiet-"));
    await writeFile(
      path.join(dir, "index.html"),
      '<!DOCTYPE html><html lang="en"><head><title>Home of the quiet build</title><script src="/assets/app.js" defer></script></head><body><h1>Home</h1></body></html>'
    );
    await writeFile(
      path.join(dir, "robots.txt"),
      `${QUIET_ROBOTS}Sitemap: https://example.com/sitemap_index.xml\n`
    );
    await writeFile(
      path.join(dir, "sitemap_index.xml"),
      '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/pages.xml.gz</loc></sitemap></sitemapindex>'
    );
    await writeFile(
      path.join(dir, "pages.xml.gz"),
      gzipSync(validUrlset("https://www.example.com"))
    );
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("in a crawl", async () => {
    const site = await auditSite(server.origin, { maxPages: 10 });

    expect(site.sitemaps.urlCount).toBe(3);
    expect(
      site.siteFindings.filter((f) => SITE_RULES_HERE.has(f.rule))
    ).toStrictEqual([]);
  });

  it("in a directory audit with the production base URL", async () => {
    const site = await auditDirectory(dir, {
      baseUrl: "https://example.com",
    });

    expect(site.sitemaps.urlCount).toBe(3);
    expect(
      site.siteFindings.filter((f) => SITE_RULES_HERE.has(f.rule))
    ).toStrictEqual([]);
  });
});

describe("a compressed sitemap larger than the read limit", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    const big = urlset(
      "<url><loc>https://www.example.com/</loc></url>".repeat(350_000)
    );

    server = await startFixtureServer({
      "/": page("Home"),
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nAllow: /\nSitemap: __ORIGIN__/big.xml\n",
      },
      "/big.xml": {
        headers: {
          "content-type": "application/xml",
          "content-encoding": "gzip",
        },
        body: gzipSync(big),
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("does not report the compressed Content-Length as the sitemap's size", async () => {
    const site = await auditSite(server.origin, { maxPages: 2 });
    const f = find(site.siteFindings, "site.sitemap-too-large");

    expect(f?.severity).toBe("info");
    expect(f?.evidence).toStrictEqual({
      sitemaps: [
        {
          sitemap: `${server.origin}/big.xml`,
          urls: null,
          bytes: null,
          overLimit: false,
        },
      ],
    });
    expect(site.siteFindings.map((x) => x.rule)).not.toContain(
      "site.sitemap-missing"
    );
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

  it("names the read budget it stopped at", async () => {
    const bomb = gzipSync(Buffer.alloc(6_000_000, 0x20));

    await expect(sitemapText(bomb, 5_000_000)).resolves.toStrictEqual({
      error: "inflates to more than the 5 MB this audit reads",
      tooLarge: true,
    });
  });
});

describe("the crawler's own robots.txt group", () => {
  const robots = buildRobots(
    "https://www.example.com/robots.txt",
    200,
    undefined,
    "User-agent: *\nDisallow: /cart\n\nUser-agent: agentic-seo-check-local\nDisallow: /reports/\n\nUser-agent: agentic-seo-check\nDisallow: /\nCrawl-delay: 5\n",
    DEFAULT_USER_AGENT
  );

  it("keeps the crawl out of what the agentic-seo-check-local group disallows", () => {
    expect(
      robots.crawlerAllows("https://www.example.com/reports/q3")
    ).toBeFalsy();
    expect(robots.crawlerAllows("https://www.example.com/")).toBeTruthy();
    // The group replaces `*` for the crawler (RFC 9309), so `*`'s rules do not add to it.
    expect(robots.crawlerAllows("https://www.example.com/cart")).toBeTruthy();
  });

  it("leaves the hosted server's group, agentic-seo-check, to the hosted server", () => {
    const hosted = buildRobots(
      "https://www.example.com/robots.txt",
      200,
      undefined,
      "User-agent: *\nDisallow: /cart\n\nUser-agent: agentic-seo-check\nDisallow: /\nCrawl-delay: 5\n",
      "Mozilla/5.0 (compatible; agentic-seo-check/1.0.0; +https://mcp.agentic-seo.rivi.software/crawler)"
    );

    expect(DEFAULT_USER_AGENT).toContain("agentic-seo-check-local/");
    expect(robots.crawlerAllows("https://www.example.com/about")).toBeTruthy();
    expect(robots.crawlDelay).toBeNull();
    expect(hosted.crawlerAllows("https://www.example.com/about")).toBeFalsy();
    expect(hosted.crawlDelay).toBe(5);
  });

  it("leaves the rules the site rules judge by as they were", () => {
    expect(robots.allows("https://www.example.com/reports/q3")).toBeTruthy();
    expect(robots.allows("https://www.example.com/cart")).toBeFalsy();
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
