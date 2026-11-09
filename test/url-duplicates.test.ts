import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditDirectory, auditSite } from "../src/core/audit.js";
import { extractPage } from "../src/core/html/extract.js";
import { probeUrlVariants } from "../src/core/site-probes.js";
import type { ProbeOptions } from "../src/core/site-probes.js";
import type { PageRecord } from "../src/core/site-rules.js";
import type { Finding } from "../src/core/types.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer, Route } from "./helpers/fixture-server.js";

const words = Array.from(
  { length: 30 },
  () => "Shoes and bags for every season are listed on this page."
).join(" ");

const page = (title: string, canonical: string | null, body = ""): Route => ({
  body: `<!DOCTYPE html><html lang="en"><head><title>${title} in the duplicates fixture</title>${canonical === null ? "" : `<link rel="canonical" href="__ORIGIN__${canonical}">`}</head><body><h1>${title}</h1><p>${words}</p>${body}</body></html>`,
});

const find = (findings: Finding[], rule: string) =>
  findings.find((f) => f.rule === rule);

const THIN_PAGE =
  '<!DOCTYPE html><html lang="en"><head><title>Shop</title></head><body><div id="root">Loading</div></body></html>';

const probeOptions = (startUrl: string): ProbeOptions => ({
  fetch: {},
  concurrency: 2,
  delayMs: 0,
  allows: () => true,
  startUrl,
  includeSubdomains: false,
  checkExternal: false,
});

describe("URL variants", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer({
      "/shoes": page("Shoes", "/shoes"),
      "/shoes/": page("Shoes", "/shoes/"),
      "/SHOES": page("Shoes", "/shoes"),
      "/bags": page("Bags", "/bags"),
      "/bags/": { status: 301, headers: { location: "/bags" } },
      "/hats": page("Hats", "/hats"),
      // A page with almost no text in its HTML, on a host that answers every path with it.
      "/thin": { body: THIN_PAGE },
      "/thin/": { body: THIN_PAGE },
      // A host that answers every unknown path with its app shell (an SPA fallback).
      "/hats/": {
        body: '<!DOCTYPE html><html lang="en"><head><title>Shop</title></head><body><div id="root"></div></body></html>',
      },
    } satisfies Record<string, Route>);
  });

  afterAll(async () => {
    await server.close();
  });

  const record = (
    pathname: string,
    canonical: string,
    title: string
  ): PageRecord => {
    const url = `${server.origin}${pathname}`;

    return {
      url,
      requestedUrl: url,
      page: extractPage(
        String(page(title, canonical).body).replaceAll(
          "__ORIGIN__",
          server.origin
        ),
        { url }
      ),
      response: {
        status: 200,
        finalUrl: url,
        redirectChain: [],
        timeMs: 1,
        contentType: "text/html",
        headers: {},
      },
      depth: 1,
    };
  };

  const thinRecord = (pathname: string): PageRecord => {
    const url = `${server.origin}${pathname}`;

    return {
      ...record(pathname, pathname, "Thin"),
      page: extractPage(THIN_PAGE, { url }),
    };
  };

  it("reports a variant that answers 200 with the same page, not one that redirects, 404s, names the page as canonical or is an app shell", async () => {
    const probes = await probeUrlVariants(
      [
        record("/shoes", "/shoes", "Shoes"),
        record("/bags", "/bags", "Bags"),
        record("/hats", "/hats", "Hats"),
        thinRecord("/thin"),
      ],
      "https://www.example.com/",
      probeOptions("https://www.example.com/")
    );

    const byVariant = Object.fromEntries(
      probes.map((p) => [p.variant.slice(server.origin.length), p.duplicate])
    );

    expect(byVariant).toStrictEqual({
      "/shoes/": true,
      "/SHOES": false,
      "/bags/": false,
      "/BAGS": false,
      "/hats/": false,
      "/HATS": false,
    });
  });

  it("skips local dev servers, which often answer both forms", async () => {
    await expect(
      probeUrlVariants(
        [record("/shoes", "/shoes", "Shoes")],
        server.origin,
        probeOptions(server.origin)
      )
    ).resolves.toStrictEqual([]);
  });
});

describe("parameter duplicates and broken images in a crawl", () => {
  let server: FixtureServer;
  let findings: Finding[];

  beforeAll(async () => {
    server = await startFixtureServer({
      "/": page(
        "Home",
        "/",
        '<a href="/list">List</a> <a href="/list?view=grid">Grid</a> <a href="/list?view=table">Table</a> <a href="/page?n=2">Page two</a> <img src="/img/missing.png" alt="Missing"> <img src="/img/ok.png" alt="OK"> <a href="/Shop">Shop</a> <a href="/shop">shop</a> <a href="/print">Print</a> <a href="/deep/page">Deep</a> <a href="/app?id=1">App 1</a> <a href="/app?id=2">App 2</a> <a href="/Bag">Bag</a> <a href="/bag">bag</a> <a href="/kit?x=1">Kit</a> <a href="/kit/?x=1">Kit again</a>'
      ),
      // Two spellings of a page with no text in its HTML: nothing to compare, so not reported.
      "/Bag": { body: THIN_PAGE },
      "/bag": { body: THIN_PAGE },
      // The trailing slash differs and the query is the same: a trailing-slash variant.
      "/kit": page("Kit", null, "<p>Every kit has a lamp.</p>"),
      "/kit/": page("Kit", null, "<p>Every kit has a lamp.</p>"),
      // <base href="/"> makes "img/ok.png" /img/ok.png, not /deep/img/ok.png.
      "/deep/page": {
        body: '<!DOCTYPE html><html lang="en"><head><base href="/"><title>Deep page in the duplicates fixture</title></head><body><h1>Deep</h1><img src="img/ok.png" alt="OK"></body></html>',
      },
      // Rendered in the browser: the HTML holds no text to compare.
      "/app": {
        body: '<!DOCTYPE html><html lang="en"><head><title>App</title></head><body><div id="root"></div></body></html>',
      },
      "/Shop": page("Shop", null, "<p>The shop sells lamps.</p>"),
      "/shop": page("Shop", null, "<p>The shop sells lamps.</p>"),
      "/print": {
        body: `<!DOCTYPE html><html lang="en"><head><title>Home in the duplicates fixture</title><link rel="canonical" href="__ORIGIN__/"></head><body><h1>Home</h1><p>${words}</p></body></html>`,
      },
      "/list": page("List", null, '<a href="/">Home</a>'),
      "/page": {
        body: `<!DOCTYPE html><html lang="en"><head><title>Paged list</title></head><body><h1>Page</h1><p>Every page of this list shows other items: lamps, chairs, tables and rugs in many colours.</p></body></html>`,
      },
      "/img/ok.png": {
        headers: { "content-type": "image/png" },
        body: "png",
      },
    } satisfies Record<string, Route>);

    const site = await auditSite(server.origin, {
      maxPages: 30,
      maxDepth: 2,
      concurrency: 2,
    });

    findings = site.siteFindings;
  });

  afterAll(async () => {
    await server.close();
  });

  it("site.parameter-duplicates groups query strings with the same text", () => {
    expect(find(findings, "site.parameter-duplicates")?.evidence).toStrictEqual(
      {
        count: 1,
        groups: [
          {
            path: `${server.origin}/list`,
            urls: [
              `${server.origin}/list`,
              `${server.origin}/list?view=grid`,
              `${server.origin}/list?view=table`,
            ],
            similarity: 1,
          },
        ],
      }
    );
  });

  it("site.url-variant-duplicate reports two spellings the crawl reached", () => {
    const evidence = find(findings, "site.url-variant-duplicate")?.evidence;

    // SAFETY: urlVariantFindings writes examples as { kind, url, variant, canonical } objects.
    const examples = (evidence?.["examples"] ?? []) as {
      kind: string;
      variant: string;
    }[];

    expect(evidence?.["count"]).toBe(2);
    expect(
      examples
        .map((e) => [e.kind, e.variant.slice(server.origin.length)])
        .toSorted()
    ).toStrictEqual([
      ["case", "/shop"],
      ["trailing-slash", "/kit/?x=1"],
    ]);
  });

  it("leaves pages that name another canonical out of the duplicate checks", () => {
    const groups = JSON.stringify(
      find(findings, "site.duplicate-content")?.evidence ?? {}
    );

    expect(groups).not.toContain(`${server.origin}/print`);
    expect(groups).toContain(`${server.origin}/shop`);
  });

  it("site.broken-images names the image and the page showing it", () => {
    expect(find(findings, "site.broken-images")?.evidence).toStrictEqual({
      count: 1,
      examples: [
        {
          url: `${server.origin}/img/missing.png`,
          status: 404,
          shownOn: [`${server.origin}/`],
        },
      ],
    });
  });
});

describe("broken images in build output", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-images-"));
    await mkdir(path.join(dir, "img"));
    await writeFile(path.join(dir, "img", "a.png"), "png");
    await writeFile(
      path.join(dir, "index.html"),
      '<!DOCTYPE html><html lang="en"><head><title>Home of the build output</title></head><body><h1>Home</h1><img src="/img/a.png" alt="A"><img src="img/b.png" alt="B"><img src="https://cdn.example.org/c.png" alt="C"><img src="/_next/image?url=%2Fimg%2Fa.png&amp;w=640&amp;q=75" alt="Optimized"><img src="/cdn-cgi/image/width=300/img/a.png" alt="Resized"></body></html>'
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("looks images on the site's host up as files", async () => {
    const site = await auditDirectory(dir);

    expect(
      find(site.siteFindings, "site.broken-images")?.evidence
    ).toMatchObject({
      count: 1,
      examples: [{ url: "http://localhost/img/b.png", status: 404 }],
    });
  });
});

describe("a page reached by a link and a redirect at once", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer({
      "/": page("Home", "/", '<a href="/a">A</a> <a href="/old-a">Old A</a>'),
      // The direct request to /a answers last, after the redirect's request to it.
      "/a": { ...page("A", "/a"), delaysMs: [300, 0] },
      "/old-a": { status: 301, headers: { location: "/a" } },
    } satisfies Record<string, Route>);
  });

  afterAll(async () => {
    await server.close();
  });

  it("is recorded once", async () => {
    const site = await auditSite(server.origin, {
      maxPages: 10,
      maxDepth: 2,
      concurrency: 3,
    });

    expect(
      site.pages.filter((p) => p.url === `${server.origin}/a`)
    ).toHaveLength(1);
  });
});

describe("image checks and other hosts", () => {
  let site: FixtureServer;
  let other: FixtureServer;

  beforeAll(async () => {
    other = await startFixtureServer({
      "/pixel.png": { headers: { "content-type": "image/png" }, body: "png" },
    });

    // 127.0.0.1 is another host than the site's localhost, as a CDN or a tracker would be.
    const elsewhere = other.origin.replace("localhost", "127.0.0.1");

    site = await startFixtureServer({
      "/": page(
        "Home",
        "/",
        `<img src="/img/ok.png" alt="OK"> <img src="${elsewhere}/pixel.png" alt="">`
      ),
      "/img/ok.png": { headers: { "content-type": "image/png" }, body: "png" },
    } satisfies Record<string, Route>);
  });

  afterAll(async () => {
    await site.close();
    await other.close();
  });

  it("requests only the site's own images, and sends the user's headers to its origin only", async () => {
    const fetch = { headers: { authorization: "Basic c2VjcmV0" } };

    await auditSite(site.origin, { maxPages: 2, fetch });

    expect(other.requests).toStrictEqual([]);

    const own = site.requests.indexOf("/img/ok.png");
    expect(site.requestHeaders[own]?.authorization).toBe("Basic c2VjcmV0");

    await auditSite(site.origin, {
      maxPages: 2,
      fetch,
      checkExternalLinks: true,
    });

    expect(other.requests).toStrictEqual(["/pixel.png"]);
    expect(other.requestHeaders[0]?.authorization).toBeUndefined();
  });
});
