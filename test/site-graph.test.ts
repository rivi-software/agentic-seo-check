import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditDirectory, auditSite } from "../src/core/audit.js";
import type { Finding } from "../src/core/types.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer, Route } from "./helpers/fixture-server.js";

const words = Array.from(
  { length: 30 },
  () => "Words about widgets and workshops fill this sentence."
).join(" ");

/** A page whose canonical (and hreflang links) the test sets, in a site served by the fixture server. */
const page = (
  title: string,
  canonical: string,
  body = "",
  head = ""
): Route => ({
  body: `<!DOCTYPE html><html lang="en"><head><title>${title} of the graph fixture site</title><link rel="canonical" href="__ORIGIN__${canonical}">${head}</head><body><h1>${title}</h1><p>${words}</p>${body}</body></html>`,
});

const routes = {
  "/": page(
    "Home",
    "/",
    '<a href="/a">A</a> <a href="/b">B</a> <a href="/c">C</a> <a href="/d">D</a> <a href="/e">E</a> <a href="/hidden">Hidden</a> <a href="/cart">Cart</a> <a href="/nl/">NL</a>',
    '<link rel="alternate" hreflang="en" href="__ORIGIN__/"><link rel="alternate" hreflang="nl" href="__ORIGIN__/nl-old"><link rel="alternate" hreflang="x-default" href="__ORIGIN__/choose-language">'
  ),
  // x-default may point at a page that sends each visitor to their language.
  "/choose-language": { status: 302, headers: { location: "/nl/" } },
  "/a": page("A", "/gone", '<a href="/">Home</a>'),
  "/b": page("B", "/old-b", '<a href="/">Home</a>'),
  "/old-b": { status: 301, headers: { location: "/b" } },
  "/c": page("C", "/hidden", '<a href="/">Home</a>'),
  "/d": page("D", "/e", '<a href="/">Home</a>'),
  "/e": page("E", "/f", '<a href="/">Home</a>'),
  "/f": page("F", "/f", '<a href="/">Home</a>'),
  "/hidden": page(
    "Hidden",
    "/hidden",
    '<a href="/">Home</a>',
    '<meta name="robots" content="noindex">'
  ),
  "/cart": page(
    "Cart",
    "/cart",
    '<a href="/">Home</a>',
    '<meta name="robots" content="noindex">'
  ),
  "/nl-old": { status: 301, headers: { location: "/nl/" } },
  "/nl/": page(
    "Nederlands",
    "/nl/",
    '<a href="/">Home</a>',
    '<link rel="alternate" hreflang="en" href="__ORIGIN__/"><link rel="alternate" hreflang="nl" href="__ORIGIN__/nl/">'
  ),
} satisfies Record<string, Route>;

const find = (findings: Finding[], rule: string) =>
  findings.find((f) => f.rule === rule);

describe("canonical and index graph of a crawled site", () => {
  let server: FixtureServer;
  let findings: Finding[];

  beforeAll(async () => {
    server = await startFixtureServer(routes);

    const site = await auditSite(server.origin, {
      maxPages: 20,
      maxDepth: 3,
      concurrency: 2,
    });

    findings = site.siteFindings;
  });

  afterAll(async () => {
    await server.close();
  });

  it("site.canonical-target-broken names the page and the 404", () => {
    expect(
      find(findings, "site.canonical-target-broken")?.evidence
    ).toStrictEqual({
      count: 1,
      examples: [
        {
          page: `${server.origin}/a`,
          canonical: `${server.origin}/gone`,
          problem: "HTTP 404",
        },
      ],
    });
  });

  it("site.canonical-target-redirects probes a canonical no link led to", () => {
    expect(
      find(findings, "site.canonical-target-redirects")?.evidence
    ).toMatchObject({
      examples: [
        {
          page: `${server.origin}/b`,
          problem: `redirects to ${server.origin}/b`,
        },
      ],
    });
  });

  it("site.canonical-target-noindex and site.canonical-chain", () => {
    expect(
      find(findings, "site.canonical-target-noindex")?.evidence
    ).toMatchObject({ examples: [{ page: `${server.origin}/c` }] });

    expect(find(findings, "site.canonical-chain")?.evidence).toMatchObject({
      count: 1,
      examples: [
        {
          page: `${server.origin}/d`,
          canonical: `${server.origin}/e`,
          problem: `names ${server.origin}/f as canonical`,
        },
      ],
    });
  });

  it("site.links-to-noindex counts the pages linking to a noindex page, cart aside", () => {
    expect(find(findings, "site.links-to-noindex")?.evidence).toStrictEqual({
      count: 1,
      pages: [{ url: `${server.origin}/hidden`, linkedFrom: 1 }],
    });
  });

  it("site.hreflang-target-invalid reports a redirecting alternate", () => {
    expect(
      find(findings, "site.hreflang-target-invalid")?.evidence
    ).toStrictEqual({
      count: 1,
      examples: [
        {
          page: `${server.origin}/`,
          hreflang: "nl",
          alternate: `${server.origin}/nl-old`,
          problem: `redirects to ${server.origin}/nl/`,
        },
      ],
    });
  });
});

describe("canonical targets in build output", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-graph-"));
    await writeFile(
      path.join(dir, "index.html"),
      `<!DOCTYPE html><html lang="en"><head><title>Home of the build</title><link rel="canonical" href="https://www.example.com/"></head><body><h1>Home</h1><a href="/about.html">About</a></body></html>`
    );
    await writeFile(
      path.join(dir, "about.html"),
      `<!DOCTYPE html><html lang="en"><head><title>About the build</title><link rel="canonical" href="https://www.example.com/about-us/"></head><body><h1>About</h1><a href="/">Home</a></body></html>`
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("checks canonical targets against the files when the base URL is the production host", async () => {
    const production = await auditDirectory(dir, {
      baseUrl: "https://www.example.com",
    });

    expect(
      find(production.siteFindings, "site.canonical-target-broken")?.evidence
    ).toMatchObject({
      examples: [{ canonical: "https://www.example.com/about-us/" }],
    });

    const local = await auditDirectory(dir);

    expect(
      find(local.siteFindings, "site.canonical-target-broken")
    ).toBeUndefined();
  });
});

/** Words on one topic, so pages on different topics share few shingles. */
const topic = (name: string): string =>
  Array.from(
    { length: 12 },
    (_, i) =>
      `Section ${i} on ${name} explains ${name} in plain words for readers.`
  ).join(" ");

/** A page of its own text whose canonical a shared layout wrote: the home page's. */
const layoutPage = (title: string, canonical = "/"): Route => ({
  body: `<!DOCTYPE html><html lang="en"><head><title>${title} at the layout fixture site</title><link rel="canonical" href="__ORIGIN__${canonical}"></head><body><h1>${title}</h1><p>${topic(title)}</p><a href="/">Home</a></body></html>`,
});

describe("site.canonical-to-one-page on a crawled site", () => {
  let server: FixtureServer;

  afterAll(async () => {
    await server.close();
  });

  it("names the pages whose layout points their canonical at the home page", async () => {
    server = await startFixtureServer({
      "/": {
        body: `<!DOCTYPE html><html lang="en"><head><title>Home of the layout fixture site</title><link rel="canonical" href="__ORIGIN__/"></head><body><h1>Home</h1><p>${topic("home")}</p><a href="/pricing">Pricing</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a> <a href="/?sort=new">New</a></body></html>`,
      },
      "/pricing": layoutPage("Pricing"),
      "/docs": layoutPage("Docs"),
      "/blog": layoutPage("Blog"),
    });

    const site = await auditSite(server.origin, {
      maxPages: 10,
      maxDepth: 2,
      concurrency: 2,
    });

    const found = find(site.siteFindings, "site.canonical-to-one-page");

    expect(found?.evidence).toStrictEqual({
      canonical: `${server.origin}/`,
      count: 3,
      pages: [
        `${server.origin}/pricing`,
        `${server.origin}/docs`,
        `${server.origin}/blog`,
      ],
    });
    expect(found?.fix).toMatchObject([
      {
        url: `${server.origin}/pricing`,
        code: `<link rel="canonical" href="${server.origin}/pricing">`,
      },
      { url: `${server.origin}/docs` },
      { url: `${server.origin}/blog` },
    ]);
  });
});

describe("site.canonical-to-one-page stays quiet", () => {
  let server: FixtureServer;

  afterAll(async () => {
    await server.close();
  });

  it("on copies of the canonical and on fewer than three pages", async () => {
    // Colour variants repeat the product's text; two articles on their own topics are too few.
    server = await startFixtureServer({
      "/": {
        body: `<!DOCTYPE html><html lang="en"><head><title>Home of the variant fixture site</title><link rel="canonical" href="__ORIGIN__/"></head><body><h1>Home</h1><p>${topic("home")}</p><a href="/shirt">Shirt</a> <a href="/shirt-red">Red</a> <a href="/shirt-blue">Blue</a> <a href="/shirt-green">Green</a> <a href="/one">One</a> <a href="/two">Two</a></body></html>`,
      },
      "/shirt": layoutPage("Shirt", "/shirt"),
      "/shirt-red": layoutPage("Shirt", "/shirt"),
      "/shirt-blue": layoutPage("Shirt", "/shirt"),
      "/shirt-green": layoutPage("Shirt", "/shirt"),
      "/one": layoutPage("Gardening"),
      "/two": layoutPage("Cooking"),
    });

    const site = await auditSite(server.origin, {
      maxPages: 10,
      maxDepth: 2,
      concurrency: 2,
    });

    expect(
      find(site.siteFindings, "site.canonical-to-one-page")
    ).toBeUndefined();
  });
});
