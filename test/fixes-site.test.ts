import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditDirectory, auditSite } from "../src/core/audit.js";
import { extractPage } from "../src/core/html/extract.js";
import {
  blockingRule,
  nestedIndexFix,
  otherHostFix,
  robotsUnsupportedFix,
  splitSitemapFix,
  toW3cDatetime,
} from "../src/core/site-fixes.js";
import { runSiteRules } from "../src/core/site-rules.js";
import type { SiteContext } from "../src/core/site-rules.js";
import { emptySitemapProblems } from "../src/core/sitemap.js";
import type { SitemapLayout } from "../src/core/sitemap.js";
import { DEFAULT_THRESHOLDS } from "../src/core/types.js";
import type { Finding, SiteAudit } from "../src/core/types.js";
import { incompleteEdits, withoutFix } from "./helpers/fixes.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer, Routes } from "./helpers/fixture-server.js";

const ORIGIN = "https://www.example.com";

const words = (topic: string): string =>
  Array.from(
    { length: 30 },
    () => `Plain sentences about ${topic} fill this page with readable text.`
  ).join(" ");

const html = (
  title: string,
  body: string,
  head = "",
  canonical: string | null = null
): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A description of ${title} that is long enough for the rules to accept."><meta name="viewport" content="width=device-width, initial-scale=1">${canonical ? `<link rel="canonical" href="${canonical}">` : ""}${head}</head><body><h1>${title}</h1>${body}</body></html>`;

const fixOf = (findings: Finding[], rule: string) =>
  findings.find((f) => f.rule === rule)?.fix;

/** Every site finding has a fix, and every edit of it is complete. */
const expectFixes = (audit: SiteAudit, noFix: string[] = []): void => {
  expect(
    withoutFix(audit.siteFindings).filter((r) => !noFix.includes(r))
  ).toStrictEqual([]);
  expect(incompleteEdits(audit.siteFindings)).toStrictEqual([]);
};

const writeSite = async (
  dir: string,
  files: Record<string, string>
): Promise<void> => {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of fixture files, written in order
    await mkdir(path.dirname(file), { recursive: true });
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above
    await writeFile(file, content);
  }
};

/** An edit that links `file` from the home page of the build directory. */
const link = (file: string) =>
  expect.objectContaining({
    in: "html",
    action: "add",
    url: "index.html",
    at: "nav, footer",
    code: `<a href="/${file}">{{link text}}</a>`,
  });

describe("fixes for site findings of a build directory", () => {
  let dir: string;
  let audit: SiteAudit;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fixes-site-"));

    await writeSite(dir, {
      "index.html": html(
        "Acme widgets for every workshop",
        `<p>${words("widgets")}</p><nav><a href="/about.html">About</a> <a href="/team.html">Team</a> <a href="/missing.html">Missing</a> <a href="/deep1.html">Deep</a> <a href="/noindex.html">Hidden</a> <a href="/private/page.html">Private</a> <a href="/canon-broken.html">A</a> <a href="/canon-noindex.html">B</a> <a href="/chain-a.html">C</a> <a href="/chain-b.html">D</a> <a href="/en.html">EN</a> <a href="/nl.html">NL</a></nav><img src="/img/missing.png" alt="Missing">`,
        '<script src="/assets/app.js" defer></script>',
        `${ORIGIN}/`
      ),
      "about.html": html(
        "About Acme",
        `<p>${words("the company")}</p>`,
        "",
        `${ORIGIN}/about.html`
      ),
      "team.html": html(
        "About Acme",
        `<p>${words("the company")}</p>`,
        "",
        `${ORIGIN}/team.html`
      ),
      "deep1.html": html("Deep one page", '<a href="/deep2.html">Next</a>'),
      "deep2.html": html("Deep two page", '<a href="/deep3.html">Next</a>'),
      "deep3.html": html("Deep three page", '<a href="/deep4.html">Next</a>'),
      "deep4.html": html("Deep four page", '<a href="/deep5.html">Next</a>'),
      "deep5.html": html("Deep five page", "<p>The end.</p>"),
      "noindex.html": html(
        "Hidden page",
        "<p>Hidden.</p>",
        '<meta name="robots" content="noindex, follow">'
      ),
      "private/page.html": html("Private page", "<p>Private.</p>"),
      "canon-broken.html": html(
        "Canonical to a missing page",
        "<p>x</p>",
        "",
        `${ORIGIN}/nowhere.html`
      ),
      "canon-noindex.html": html(
        "Canonical to a noindex page",
        "<p>x</p>",
        "",
        `${ORIGIN}/noindex.html`
      ),
      "chain-a.html": html("Chain A", "<p>a</p>", "", `${ORIGIN}/chain-b.html`),
      "chain-b.html": html("Chain B", "<p>b</p>", "", `${ORIGIN}/chain-c.html`),
      "chain-c.html": html("Chain C", "<p>c</p>", "", `${ORIGIN}/chain-c.html`),
      "en.html": html(
        "English page",
        "<p>en</p>",
        `<link rel="alternate" hreflang="en" href="${ORIGIN}/en.html"><link rel="alternate" hreflang="nl" href="${ORIGIN}/nl.html"><link rel="alternate" hreflang="de" href="${ORIGIN}/de.html">`
      ),
      "nl.html": html("Nederlandse pagina", "<p>nl</p>"),
      "orphan.html": html("Orphan page", "<p>Nobody links here.</p>"),
      "robots.txt":
        "User-agent: *\nDisallow: /private/\nDisallow: /assets/\nNoindex: /old/\nCrawl-delay: 5\n\nSitemap: https://www.example.com/sitemap.xml\n",
      "sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${ORIGIN}/</loc><lastmod>2026-11-09 10:00:00</lastmod></url>
<url><loc>${ORIGIN}/about.html</loc><lastmod>2099-01-01</lastmod></url>
<url><loc>${ORIGIN}/noindex.html</loc></url>
<url><loc>${ORIGIN}/gone.html</loc></url>
<url><loc>${ORIGIN}/chain-a.html</loc></url>
<url><loc>${ORIGIN}/orphan.html</loc></url>
<url><loc>${ORIGIN}/private/page.html</loc></url>
</urlset>`,
    });

    audit = await auditDirectory(dir, { baseUrl: ORIGIN });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives every site finding a complete fix", () => {
    expect(withoutFix(audit.siteFindings)).toStrictEqual([]);
    expect(incompleteEdits(audit.siteFindings)).toStrictEqual([]);
  });

  /** What each rule's fix must hold; toMatchObject leaves out the `write` text. */
  const expected: [string, object[]][] = [
    [
      "site.sitemap-broken-url",
      [
        {
          in: "sitemap",
          action: "remove",
          url: `${ORIGIN}/sitemap.xml`,
          current: `<loc>${ORIGIN}/gone.html</loc>`,
        },
      ],
    ],
    [
      "site.sitemap-noindex-page",
      [
        {
          in: "sitemap",
          action: "remove",
          current: `<loc>${ORIGIN}/noindex.html</loc>`,
        },
      ],
    ],
    [
      "site.sitemap-non-canonical",
      [
        {
          in: "sitemap",
          action: "replace",
          current: `<loc>${ORIGIN}/chain-a.html</loc>`,
          code: `<loc>${ORIGIN}/chain-b.html</loc>`,
        },
      ],
    ],
    [
      "site.sitemap-lastmod-invalid",
      [
        {
          in: "sitemap",
          action: "replace",
          url: `${ORIGIN}/sitemap.xml`,
          at: `<loc>${ORIGIN}/</loc>`,
          current: "<lastmod>2026-11-09 10:00:00</lastmod>",
          code: "<lastmod>2026-11-09T10:00:00</lastmod>",
        },
      ],
    ],
    [
      "site.sitemap-lastmod-future",
      [
        {
          current: "<lastmod>2099-01-01</lastmod>",
          code: "<lastmod>{{date the page last changed}}</lastmod>",
        },
      ],
    ],
    [
      "site.not-in-sitemap",
      [
        {
          in: "sitemap",
          action: "add",
          url: `${ORIGIN}/sitemap.xml`,
          at: "before </urlset>",
        },
      ],
    ],
    // The blocked page is in the sitemap, so it leaves the sitemap; robots.txt stays as it is.
    [
      "site.robots-blocked-pages",
      [
        {
          in: "sitemap",
          action: "remove",
          current: `<loc>${ORIGIN}/private/page.html</loc>`,
        },
      ],
    ],
    [
      "site.robots-blocks-resources",
      [
        {
          in: "robots.txt",
          action: "add",
          url: `${ORIGIN}/robots.txt`,
          at: "User-agent: *",
          code: "Allow: /assets/*.js",
        },
      ],
    ],
    [
      "site.robots-txt-unsupported-rule",
      [
        { in: "robots.txt", action: "remove", current: "Noindex: /old/" },
        {
          in: "http",
          action: "add",
          url: `${ORIGIN}/old/`,
          code: "X-Robots-Tag: noindex",
        },
        { in: "robots.txt", action: "remove", current: "Crawl-delay: 5" },
      ],
    ],
    [
      "site.broken-internal-links",
      [
        {
          in: "html",
          action: "replace",
          url: "index.html",
          current: '<a href="/missing.html">',
          code: '<a href="{{URL of the live page this link meant}}">',
        },
      ],
    ],
    [
      "site.duplicate-titles",
      [
        {
          url: "team.html",
          current: "<title>About Acme</title>",
          code: "<title>{{a title for this page}}</title>",
        },
      ],
    ],
    [
      "site.duplicate-content",
      [
        {
          in: "html",
          action: "replace",
          url: "team.html",
          current: `<link rel="canonical" href="${ORIGIN}/team.html">`,
          code: `<link rel="canonical" href="${ORIGIN}/about.html">`,
        },
      ],
    ],
    [
      "site.canonical-target-broken",
      [
        {
          url: "canon-broken.html",
          code: `<link rel="canonical" href="${ORIGIN}/canon-broken.html">`,
        },
      ],
    ],
    [
      "site.canonical-target-noindex",
      [{ code: `<link rel="canonical" href="${ORIGIN}/canon-noindex.html">` }],
    ],
    [
      "site.canonical-chain",
      [
        {
          url: "chain-a.html",
          code: `<link rel="canonical" href="${ORIGIN}/chain-c.html">`,
        },
      ],
    ],
    [
      "site.links-to-noindex",
      [
        {
          in: "html",
          action: "replace",
          current: '<meta name="robots" content="noindex, follow">',
          code: '<meta name="robots" content="follow">',
        },
      ],
    ],
    [
      "site.broken-images",
      [
        {
          current: '<img src="/img/missing.png" alt="Missing">',
          code: '<img src="{{working URL of the image}}" alt="Missing">',
        },
      ],
    ],
    [
      "site.hreflang-no-return-link",
      [
        {
          in: "html",
          action: "add",
          url: "nl.html",
          at: "head",
          code: `<link rel="alternate" hreflang="en" href="${ORIGIN}/en.html">`,
        },
      ],
    ],
    [
      "site.hreflang-target-invalid",
      [
        {
          in: "html",
          action: "remove",
          url: "en.html",
          current: `<link rel="alternate" hreflang="de" href="${ORIGIN}/de.html">`,
        },
      ],
    ],
  ];

  it.each(expected)("%s", (rule, edits) => {
    expect(fixOf(audit.siteFindings, rule)).toMatchObject(edits);
  });

  it("names the robots.txt rule it leaves in place, and lists the missing pages in the sitemap", () => {
    expect(
      fixOf(audit.siteFindings, "site.robots-blocked-pages")?.[0]?.write
    ).toContain('"Disallow: /private/"');
    expect(
      fixOf(audit.siteFindings, "site.not-in-sitemap")?.[0]?.code
    ).toContain(`<url><loc>${ORIGIN}/team.html</loc></url>`);
  });

  it("links deep, orphan and unlinked pages from the home page", () => {
    expect(fixOf(audit.siteFindings, "site.deep-pages")).toContainEqual(
      link("deep5.html")
    );
    expect(fixOf(audit.siteFindings, "site.orphan-pages")).toContainEqual(
      link("orphan.html")
    );
    expect(fixOf(audit.siteFindings, "site.unlinked-pages")).toContainEqual(
      link("orphan.html")
    );
  });
});

describe("fixes for the robots.txt and sitemap of a build directory", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fixes-robots-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes robots.txt and a sitemap when the build has neither", async () => {
    const site = path.join(dir, "bare");
    await writeSite(site, {
      "index.html": html("Home page of a bare site", '<a href="/a.html">A</a>'),
      "a.html": html("Page A of a bare site", "<p>a</p>"),
    });

    const audit = await auditDirectory(site, { baseUrl: ORIGIN });
    expectFixes(audit);

    expect(fixOf(audit.siteFindings, "site.robots-txt-missing")).toStrictEqual([
      {
        in: "robots.txt",
        action: "add",
        url: `${ORIGIN}/robots.txt`,
        at: "new file",
        code: `User-agent: *\nDisallow:\n\nSitemap: ${ORIGIN}/sitemap.xml`,
        write:
          "Serve it as a plain-text file at the site root (public/robots.txt, or app/robots.ts in Next.js).",
      },
    ]);

    const [sitemap] = fixOf(audit.siteFindings, "site.sitemap-missing") ?? [];
    expect(sitemap).toMatchObject({
      in: "sitemap",
      action: "add",
      url: `${ORIGIN}/sitemap.xml`,
      at: "new file",
    });
    expect(sitemap?.code).toContain(`<url><loc>${ORIGIN}/a.html</loc></url>`);
  });

  it("replaces the rule that blocks the whole site, and lists a nested index's sitemaps in its parent", async () => {
    const site = path.join(dir, "blocked");
    await writeSite(site, {
      "index.html": html("Home page of a blocked site", "<p>x</p>"),
      "robots.txt": "User-agent: *\nDisallow: /\n",
      "sitemap.xml": `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${ORIGIN}/nested.xml</loc></sitemap></sitemapindex>`,
      "nested.xml": `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${ORIGIN}/pages.xml</loc></sitemap></sitemapindex>`,
      "pages.xml": `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/</loc></url></urlset>`,
    });

    const audit = await auditDirectory(site, { baseUrl: ORIGIN });
    expectFixes(audit);

    expect(
      fixOf(audit.siteFindings, "site.robots-txt-blocks-all")
    ).toMatchObject([
      {
        in: "robots.txt",
        action: "replace",
        at: "User-agent: *",
        current: "Disallow: /",
        code: "Disallow:",
      },
    ]);
    expect(
      fixOf(audit.siteFindings, "site.sitemap-index-nested")
    ).toMatchObject([
      {
        in: "sitemap",
        action: "replace",
        url: `${ORIGIN}/sitemap.xml`,
        current: `<loc>${ORIGIN}/nested.xml</loc>`,
        code: `<sitemap><loc>${ORIGIN}/pages.xml</loc></sitemap>`,
      },
    ]);
  });

  it("rewrites robots.txt lines and sitemap entries search engines drop, on the production host", async () => {
    const site = path.join(dir, "dropped");
    const stamp = "2026-11-09T14:03:12+01:00";

    const entries = Array.from(
      { length: 10 },
      (_, i) =>
        `<url><loc>${ORIGIN}/post-${i}.html</loc><lastmod>${stamp}</lastmod></url>`
    ).join("\n");

    await writeSite(site, {
      "index.html": html("Home page of a build with slips", "<p>x</p>"),
      "robots.txt": `User-agent: *\nDisallow: private/\nDisallow: ${ORIGIN}/drafts/?preview=1\nSitemap: /sitemap.xml\n`,
      "sitemap.xml": `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n<url><loc>/about.html</loc><lastmod>${stamp}</lastmod></url>\n</urlset>`,
    });

    const audit = await auditDirectory(site, { baseUrl: ORIGIN });
    expectFixes(audit);

    expect(
      fixOf(audit.siteFindings, "site.robots-txt-invalid-rule")?.map((e) => [
        e.current,
        e.code,
      ])
    ).toStrictEqual([
      ["Disallow: private/", "Disallow: /private/"],
      [`Disallow: ${ORIGIN}/drafts/?preview=1`, "Disallow: /drafts/?preview=1"],
      ["Sitemap: /sitemap.xml", `Sitemap: ${ORIGIN}/sitemap.xml`],
    ]);
    expect(fixOf(audit.siteFindings, "site.sitemap-invalid-url")).toMatchObject(
      [
        {
          in: "sitemap",
          action: "replace",
          url: `${ORIGIN}/sitemap.xml`,
          current: "<loc>/about.html</loc>",
          code: `<loc>${ORIGIN}/about.html</loc>`,
        },
      ]
    );
    // Eleven entries, one of them dropped, all with the build's time: still the build's time.
    expect(
      fixOf(audit.siteFindings, "site.sitemap-lastmod-uniform")
    ).toHaveLength(3);
  });

  it("rewrites a sitemap that does not parse", async () => {
    const site = path.join(dir, "garbage");
    await writeSite(site, {
      "index.html": html("Home page with a broken sitemap", "<p>x</p>"),
      "robots.txt": "User-agent: *\nDisallow:\n",
      "sitemap.xml": "<<< not a sitemap",
    });

    const audit = await auditDirectory(site, { baseUrl: ORIGIN });
    expectFixes(audit);
    expect(fixOf(audit.siteFindings, "site.sitemap-error")).toMatchObject([
      {
        in: "sitemap",
        action: "add",
        url: `${ORIGIN}/sitemap.xml`,
        at: "whole file",
      },
    ]);
  });
});

describe("fixes for site findings of a crawl", () => {
  let server: FixtureServer;
  let audit: SiteAudit;

  beforeAll(async () => {
    server = await startFixtureServer(siteRoutes());
    audit = await auditSite(`${server.origin}/`, {
      checkExternalLinks: true,
      maxPages: 20,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("gives every site finding of the crawl a complete fix", () => {
    expect(withoutFix(audit.siteFindings)).toStrictEqual([]);
    expect(incompleteEdits(audit.siteFindings)).toStrictEqual([]);
  });

  it("relinks redirects and shortens chains", () => {
    expect(
      fixOf(audit.siteFindings, "site.redirected-internal-links")
    ).toMatchObject([
      {
        in: "html",
        url: `${server.origin}/`,
        current: '<a href="/redirect">',
        code: '<a href="/about/">',
      },
    ]);
    expect(fixOf(audit.siteFindings, "site.redirect-chains")).toStrictEqual([
      {
        in: "http",
        action: "replace",
        url: `${server.origin}/chain`,
        current: `HTTP/1.1 302 Found\nLocation: ${server.origin}/chain2`,
        code: `HTTP/1.1 301 Moved Permanently\nLocation: ${server.origin}/about/`,
      },
    ]);
  });

  it("keeps blocked pages blocked, slots dead external links and drops broken orphans", () => {
    expect(
      fixOf(audit.siteFindings, "site.robots-blocked-pages")
    ).toMatchObject([
      {
        in: "html",
        url: `${server.origin}/about/`,
        current: '<a href="/private/secret">',
        code: '<a href="/private/secret" rel="nofollow">',
      },
    ]);
    expect(
      fixOf(audit.siteFindings, "site.broken-external-links")
    ).toMatchObject([
      {
        current: '<a href="https://external.invalid/dead">',
        code: '<a href="{{current URL of the linked page}}">',
      },
    ]);
    // /gone is a broken orphan: it leaves the sitemap instead of getting a link.
    expect(fixOf(audit.siteFindings, "site.orphan-pages")).toContainEqual(
      expect.objectContaining({
        in: "sitemap",
        action: "remove",
        current: `<loc>${server.origin}/gone</loc>`,
      })
    );
  });
});

describe("fixes for site findings of other crawls", () => {
  it("answers robots.txt and sitemap errors with the response to serve", async () => {
    const routes: Routes = {
      "/": { body: html("Home page of a failing site", "<p>x</p>") },
      "/robots.txt": { status: 500, body: "oops" },
      "/sitemap.xml": { status: 500, body: "oops" },
    };

    const server = await startFixtureServer(routes);

    try {
      const audit = await auditSite(`${server.origin}/`, { maxPages: 5 });
      expectFixes(audit);

      expect(fixOf(audit.siteFindings, "site.robots-txt-error")).toMatchObject([
        {
          in: "http",
          action: "replace",
          url: `${server.origin}/robots.txt`,
          current: "HTTP/1.1 500 Internal Server Error",
          code: "HTTP/1.1 200 OK\nContent-Type: text/plain",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("gives parameter and spelling duplicates a canonical, and lists other-host URLs in their robots.txt", async () => {
    const body = `<p>${words("parameters")}</p>`;

    const routes: Routes = {
      "/": {
        body: html(
          "Home page that links to variants",
          '<a href="/list">List</a> <a href="/list?sort=asc">Sorted</a> <a href="/case">case</a> <a href="/CASE">CASE</a>'
        ),
      },
      "/list": { body: html("A list of widgets", body) },
      "/case": {
        body: html("A page in two spellings", `<p>${words("case")}</p>`),
      },
      "/CASE": {
        body: html("A page in two spellings", `<p>${words("case")}</p>`),
      },
      "/robots.txt": {
        body: "User-agent: *\nDisallow:\nSitemap: __ORIGIN__/sitemap.xml\n",
      },
      "/sitemap.xml": {
        headers: { "content-type": "application/xml" },
        body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>__ORIGIN__/</loc></url><url><loc>https://cdn.example.net/a</loc></url></urlset>',
      },
    };

    const server = await startFixtureServer(routes);
    routes["/list"] = { body: html("A list of widgets", body) };

    try {
      const audit = await auditSite(`${server.origin}/`, { maxPages: 10 });
      expectFixes(audit);
      const f = audit.siteFindings;

      expect(fixOf(f, "site.parameter-duplicates")).toMatchObject([
        {
          in: "html",
          action: "add",
          url: `${server.origin}/list?sort=asc`,
          at: "head",
          code: `<link rel="canonical" href="${server.origin}/list">`,
        },
      ]);
      expect(fixOf(f, "site.url-variant-duplicate")?.[0]).toMatchObject({
        in: "http",
        action: "replace",
        current: "HTTP/1.1 200 OK",
      });
      expect(fixOf(f, "site.sitemap-other-host")).toMatchObject([
        {
          in: "robots.txt",
          action: "add",
          url: "https://cdn.example.net/robots.txt",
          code: `Sitemap: ${server.origin}/sitemap.xml`,
        },
      ]);
    } finally {
      await server.close();
    }
  });
});

/** A crawled page record of a live site, for a hand-built site context. */
const record = (url: string) => ({
  url,
  requestedUrl: url,
  page: extractPage(html("Home page of a live site", "<p>x</p>"), { url }),
  response: {
    status: 200,
    finalUrl: url,
    redirectChain: [],
    timeMs: 10,
    contentType: "text/html",
    headers: {},
  },
  depth: 0,
});

/** A site context for one live page, with `overrides`. */
const context = (overrides: Partial<SiteContext>): SiteContext => ({
  startUrl: `${ORIGIN}/`,
  source: "crawl",
  pages: [record(`${ORIGIN}/`)],
  linkChecks: new Map(),
  linkSources: new Map(),
  robots: null,
  robotsAllows: null,
  blockedByRobots: [],
  sitemaps: {
    sources: [`${ORIGIN}/sitemap.xml`],
    urls: [],
    urlCount: 0,
    errors: [],
    problems: emptySitemapProblems(),
  },
  probes: {},
  crawl: {
    pagesCrawled: 1,
    pagesDiscovered: 1,
    linksChecked: 0,
    maxPages: 1,
    maxDepth: 3,
    hitPageLimit: false,
    durationMs: 1,
    respectedRobots: true,
  },
  thresholds: DEFAULT_THRESHOLDS,
  pathOnly: false,
  ...overrides,
});

describe("fixes for findings a local crawl cannot reach", () => {
  it("redirects http, the other host and spelling variants, and answers 404 for unknown URLs", () => {
    const findings = runSiteRules(
      context({
        probes: {
          soft404: { url: `${ORIGIN}/no-such-page-123`, status: 200 },
          httpRedirect: {
            url: "http://www.example.com/",
            status: 200,
            finalUrl: "http://www.example.com/",
            redirectsToHttps: false,
          },
          hostVariant: {
            url: "https://example.com/",
            status: 200,
            finalUrl: "https://example.com/",
            redirectsToMain: false,
          },
          urlVariants: [
            {
              kind: "trailing-slash",
              url: `${ORIGIN}/a`,
              variant: `${ORIGIN}/a/`,
              status: 200,
              canonical: null,
              duplicate: true,
            },
          ],
        },
      })
    );

    expect(withoutFix(findings)).toStrictEqual([]);
    expect(fixOf(findings, "site.soft-404")).toMatchObject([
      {
        in: "http",
        url: `${ORIGIN}/no-such-page-123`,
        current: "HTTP/1.1 200 OK",
        code: "HTTP/1.1 404 Not Found",
      },
    ]);
    expect(fixOf(findings, "site.http-not-redirected")).toMatchObject([
      {
        url: "http://www.example.com/",
        code: "HTTP/1.1 301 Moved Permanently\nLocation: https://www.example.com/",
      },
    ]);
    expect(fixOf(findings, "site.host-variant-not-redirected")).toMatchObject([
      {
        url: "https://example.com/",
        code: `HTTP/1.1 301 Moved Permanently\nLocation: ${ORIGIN}/`,
      },
    ]);
    expect(fixOf(findings, "site.url-variant-duplicate")).toMatchObject([
      {
        url: `${ORIGIN}/a/`,
        code: `HTTP/1.1 301 Moved Permanently\nLocation: ${ORIGIN}/a`,
      },
    ]);
  });

  it("cuts robots.txt at the last line Google reads, and splits a sitemap over the limits", () => {
    const text = `User-agent: *\n${Array.from({ length: 30_000 }, (_, i) => `Disallow: /page-${i}/`).join("\n")}`;
    const problems = emptySitemapProblems();
    problems.oversized.push({
      sitemap: `${ORIGIN}/sitemap.xml`,
      urls: 60_000,
      bytes: 9_000_000,
      overLimit: true,
    });

    const findings = runSiteRules(
      context({
        robots: {
          url: `${ORIGIN}/robots.txt`,
          status: 200,
          found: true,
          sitemaps: [],
          text: text.slice(0, 20_000),
          bytes: 600_000,
        },
        robotsText: text.slice(0, 512_000),
        robotsAllows: () => true,
        sitemaps: {
          sources: [],
          urls: [],
          urlCount: 0,
          errors: [],
          problems,
        },
      })
    );

    const [cut] = fixOf(findings, "site.robots-txt-too-large") ?? [];
    expect(cut).toMatchObject({
      in: "robots.txt",
      action: "remove",
      url: `${ORIGIN}/robots.txt`,
    });
    expect(text).toContain(cut?.current ?? "missing");

    expect(fixOf(findings, "site.sitemap-too-large")?.[0]?.code).toContain(
      `<sitemap><loc>${ORIGIN}/sitemap-2.xml</loc></sitemap>`
    );
  });

  it("has no site edit when the crawl reached its page limit", () => {
    const findings = runSiteRules(
      context({
        crawl: {
          pagesCrawled: 1,
          pagesDiscovered: 9,
          linksChecked: 0,
          maxPages: 1,
          maxDepth: 3,
          hitPageLimit: true,
          durationMs: 1,
          respectedRobots: true,
        },
      })
    );

    expect(fixOf(findings, "site.crawl-limit-reached")).toBeUndefined();
  });
});

describe(toW3cDatetime, () => {
  it("writes values that name one moment in W3C Datetime, and leaves ambiguous ones", () => {
    expect(
      [
        "2026-11-09 10:00:00",
        "2026-11-09T10:00:00+0100",
        "Mon, 09 Nov 2026 10:00:00 GMT",
        "14/03/2026",
        "03/04/2026",
        "yesterday",
      ].map(toW3cDatetime)
    ).toStrictEqual([
      "2026-11-09T10:00:00",
      "2026-11-09T10:00:00+01:00",
      "2026-11-09T10:00:00Z",
      "2026-03-14",
      null,
      null,
    ]);
  });

  it.each(["Pacific/Kiritimati", "Europe/Amsterdam", "America/Los_Angeles"])(
    "writes the same date and time in any time zone the audit runs in (%s)",
    (zone) => {
      const before = process.env["TZ"];
      process.env["TZ"] = zone;

      try {
        expect({
          date: toW3cDatetime("14 March 2026"),
          monthFirst: toW3cDatetime("Mar 14, 2026"),
          zoned: toW3cDatetime("Sat, 14 Mar 2026 09:30:00 GMT"),
          // Without a zone, which moment it means depends on the site's time zone: ask.
          unzoned: toW3cDatetime("14 March 2026 09:30"),
        }).toStrictEqual({
          date: "2026-03-14",
          monthFirst: "2026-03-14",
          zoned: "2026-03-14T09:30:00Z",
          unzoned: null,
        });
      } finally {
        if (before === undefined) {
          delete process.env["TZ"];
        } else {
          process.env["TZ"] = before;
        }
      }
    }
  );
});

describe(otherHostFix, () => {
  it("keeps a path that starts with // a path on the site's host", () => {
    const layout = {
      sitemapOf: new Map(),
      children: new Map(),
      parentOf: new Map(),
      urlsets: [],
    };

    expect(
      otherHostFix(
        layout,
        [
          "https://www.example.com//blog/post (in https://example.com/sitemap.xml)",
        ],
        "https://example.com"
      )
    ).toMatchObject([
      {
        in: "sitemap",
        current: "<loc>https://www.example.com//blog/post</loc>",
        code: "<loc>https://example.com//blog/post</loc>",
      },
    ]);
  });
});

/** An hreflang link to `file` on the site. */
const alt = (lang: string, file: string) =>
  `<link rel="alternate" hreflang="${lang}" href="${ORIGIN}/${file}">`;

describe("site.hreflang-no-return-link", () => {
  let dir: string;

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves out pages whose canonical names another page, and counts a pair once", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hreflang-return-"));

    await writeSite(dir, {
      "index.html": html(
        "Home",
        `${words("home")}<a href="/variant.html">V</a><a href="/c.html">C</a><a href="/d.html">D</a>`,
        "",
        `${ORIGIN}/index.html`
      ),
      // A variant folded into the home page: its hreflang does not count.
      "variant.html": html(
        "Variant",
        words("variant"),
        alt("en", "index.html"),
        `${ORIGIN}/index.html`
      ),
      // en and x-default both name d.html, which does not link back: one missing return link.
      "c.html": html(
        "Page C",
        words("c"),
        `${alt("en", "c.html")}${alt("nl", "d.html")}${alt("x-default", "d.html")}`,
        `${ORIGIN}/c.html`
      ),
      "d.html": html(
        "Pagina D",
        words("d"),
        alt("nl", "d.html"),
        `${ORIGIN}/d.html`
      ),
    });

    const audit = await auditDirectory(dir, { baseUrl: ORIGIN });

    const finding = audit.siteFindings.find(
      (f) => f.rule === "site.hreflang-no-return-link"
    );

    expect(finding?.evidence).toStrictEqual({
      count: 1,
      examples: [{ page: `${ORIGIN}/c.html`, alternate: `${ORIGIN}/d.html` }],
    });
    expect(finding?.fix).toMatchObject([
      {
        in: "html",
        action: "add",
        url: "d.html",
        at: "head",
        code: `<link rel="alternate" hreflang="en" href="${ORIGIN}/c.html">`,
      },
    ]);
  });

  it("gives the return link the page's language, not x-default listed first", async () => {
    const site = await mkdtemp(path.join(tmpdir(), "hreflang-x-default-"));

    try {
      await writeSite(site, {
        "index.html": html(
          "Home",
          `${words("home")}<a href="/nl.html">NL</a>`,
          `${alt("x-default", "index.html")}${alt("en", "index.html")}${alt("nl", "nl.html")}`,
          `${ORIGIN}/index.html`
        ),
        "nl.html": html(
          "Thuis",
          words("thuis"),
          alt("nl", "nl.html"),
          `${ORIGIN}/nl.html`
        ),
      });

      const audit = await auditDirectory(site, { baseUrl: ORIGIN });

      expect(
        fixOf(audit.siteFindings, "site.hreflang-no-return-link")
      ).toMatchObject([
        {
          url: "nl.html",
          code: `<link rel="alternate" hreflang="en" href="${ORIGIN}/">`,
        },
      ]);
    } finally {
      await rm(site, { recursive: true, force: true });
    }
  });
});

/** A site whose home page links /Shop, then /shop, which serve the same text; `slow` answers late. */
const crawlWith = async (slow: string) => {
  const routes: Routes = {
    "/": {
      body: html(
        "Home",
        `${words("home")}<a href="/Shop">Shop</a> <a href="/shop">shop</a>`
      ),
    },
    "/Shop": { body: html("Shop", words("the shop")) },
    "/shop": { body: html("Shop", words("the shop")) },
  };

  const late = routes[slow];

  if (late) {
    late.delaysMs = [300];
  }

  const server = await startFixtureServer(routes);

  try {
    const audit = await auditSite(`${server.origin}/`, { concurrency: 4 });

    const finding = audit.siteFindings.find(
      (f) => f.rule === "site.url-variant-duplicate"
    );

    return {
      examples: JSON.stringify(finding?.evidence?.["examples"]).replaceAll(
        server.origin,
        ""
      ),
      fix: JSON.stringify(finding?.fix).replaceAll(server.origin, ""),
    };
  } finally {
    await server.close();
  }
};

/**
 * A home page linking /a, then /b. /a links /Shop; /b links /shop, then /Shop, which serve the same
 * text. `slow` (/a or /b) answers late, so the other parent's links reach the queue first.
 */
const crawlTwoParents = async (slow: string) => {
  const routes: Routes = {
    "/": {
      body: html(
        "Home",
        `${words("home")}<a href="/a">A</a> <a href="/b">B</a>`
      ),
    },
    "/a": {
      body: html("Page A", `${words("page a")}<a href="/Shop">Shop</a>`),
    },
    "/b": {
      body: html(
        "Page B",
        `${words("page b")}<a href="/shop">shop</a> <a href="/Shop">Shop</a>`
      ),
    },
    "/Shop": { body: html("Shop", words("the shop")) },
    "/shop": { body: html("Shop", words("the shop")) },
  };

  const late = routes[slow];

  if (late) {
    late.delaysMs = [300];
  }

  const server = await startFixtureServer(routes);

  try {
    const audit = await auditSite(`${server.origin}/`, { concurrency: 4 });

    return JSON.stringify(
      audit.siteFindings.find((f) => f.rule === "site.url-variant-duplicate")
        ?.evidence?.["examples"]
    ).replaceAll(server.origin, "");
  } finally {
    await server.close();
  }
};

describe("site.url-variant-duplicate on a crawl", () => {
  it("reads the order from the links, not from which parent page finished first", async () => {
    const aLate = await crawlTwoParents("/a");
    const bLate = await crawlTwoParents("/b");

    // A one-at-a-time crawl reaches /Shop through /a before /shop through /b.
    expect(aLate).toContain('"url":"/Shop","variant":"/shop"');
    expect(bLate).toBe(aLate);
  });

  it("calls the same spelling the page whichever request finishes first", async () => {
    const shopLate = await crawlWith("/shop");
    const ShopLate = await crawlWith("/Shop");

    // The home page links /Shop first, so /Shop is the page and /shop the variant, both times.
    expect(shopLate.examples).toContain('"url":"/Shop","variant":"/shop"');
    expect(ShopLate).toStrictEqual(shopLate);
  });
});

describe("robots.txt fixes on a hostile robots.txt", () => {
  const ROBOTS = `${ORIGIN}/robots.txt`;

  it("reads a long robots.txt in one pass", () => {
    // 49,000 lines under one User-agent line: looking back for each line's group was quadratic
    // (14.6 s). One pass takes milliseconds; the limit leaves room for a busy machine.
    const text = `User-agent: *\n${"Disallow: /x\n".repeat(49_000)}Crawl-delay: 10\n`;
    const started = performance.now();
    const edits = robotsUnsupportedFix(ROBOTS, text);

    expect(performance.now() - started).toBeLessThan(5000);
    expect(edits).toStrictEqual([
      expect.objectContaining({
        in: "robots.txt",
        action: "remove",
        at: "User-agent: *",
        current: "Crawl-delay: 10",
      }),
    ]);
  });

  it("stops at 10 edits on a robots.txt of nothing but noindex lines", () => {
    // Each noindex: line takes two edits (remove it, send X-Robots-Tag instead): 100,000 in all.
    const text = `User-agent: *\n${"noindex: /\n".repeat(50_000)}`;

    expect(robotsUnsupportedFix(ROBOTS, text)).toHaveLength(10);
  });

  it("quotes a rule without its comment, and long lines cut short", () => {
    const padded = `User-agent: *\nDisallow: /private/ # ${"x".repeat(100_000)}\nCrawl-delay: ${"9".repeat(2000)}\n`;

    expect(blockingRule(ROBOTS, padded, `${ORIGIN}/private/a`)).toBe(
      "Disallow: /private/"
    );

    const [edit] = robotsUnsupportedFix(ROBOTS, padded);
    expect(edit?.current).toHaveLength(500);
    expect(edit?.current?.endsWith("…")).toBeTruthy();
  });
});

describe("sitemap fixes on a hostile sitemap", () => {
  it("lists the first 50 parts of a sitemap that declares a huge Content-Length", () => {
    // A truncated sitemap's size comes from its Content-Length: here about 22 million parts.
    const edit = splitSitemapFix(
      `${ORIGIN}/sitemap.xml`,
      22_222_223,
      "Serve this index."
    );

    expect(edit.code?.match(/<sitemap><loc>/gu)).toHaveLength(50);
    expect(edit.code).toContain(
      `<sitemap><loc>${ORIGIN}/sitemap-50.xml</loc></sitemap>\n  {{a <sitemap> for each of the other 22222173 parts}}`
    );
    expect(edit.write).toBe(
      "Serve this index. The slot stands for the other 22222173 parts, named the same way."
    );
  });

  it("gives a slot for a nested index with more sitemaps than a fix writes out", () => {
    const nested = `${ORIGIN}/nested.xml`;

    const layout = (children: string[]): SitemapLayout => ({
      sitemapOf: new Map(),
      children: new Map([[nested, children]]),
      parentOf: new Map([[nested, `${ORIGIN}/sitemap.xml`]]),
      urlsets: [],
    });

    const many = Array.from(
      { length: 100_000 },
      (_, i) => `${ORIGIN}/sitemap-${i}.xml`
    );

    expect(nestedIndexFix(layout(many), nested).code).toBe(
      "<sitemap><loc>{{URL of each sitemap the nested index lists}}</loc></sitemap>"
    );
    expect(
      nestedIndexFix(layout([`${ORIGIN}/${"a".repeat(5000)}.xml`]), nested).code
    ).toContain("{{URL of each sitemap the nested index lists}}");
    expect(nestedIndexFix(layout(many.slice(0, 2)), nested).code).toBe(
      `<sitemap><loc>${ORIGIN}/sitemap-0.xml</loc></sitemap>\n<sitemap><loc>${ORIGIN}/sitemap-1.xml</loc></sitemap>`
    );
  });
});

/** Letters only, one word per number: 0 → "q", 27 → "br". */
const token = (i: number): string =>
  i.toString(26).replaceAll(/\d/gu, (d) => "qrstuvwxyz"[Number(d)] ?? "");

/** A live page whose text is the words for `from` up to `to`. */
const textPage = (url: string, from: number, to: number) => {
  const text = Array.from({ length: to - from }, (_, i) => token(from + i));

  return {
    ...record(url),
    page: extractPage(html("Product page", `<p>${text.join(" ")}</p>`), {
      url,
    }),
  };
};

describe("site.duplicate-content", () => {
  it("gives each near-duplicate one canonical, to a page that keeps its own", () => {
    // red~blue and blue~green are near-duplicates (0.92), red~green is not (0.85).
    const red = `${ORIGIN}/p/red`;
    const blue = `${ORIGIN}/p/blue`;
    const green = `${ORIGIN}/p/green`;

    const findings = runSiteRules(
      context({
        pages: [
          textPage(red, 0, 1000),
          textPage(blue, 40, 1040),
          textPage(green, 80, 1080),
        ],
      })
    );

    const found = findings.find((f) => f.rule === "site.duplicate-content");

    expect(found?.evidence?.["groups"]).toStrictEqual([
      { pages: [red, blue], similarity: 0.92 },
      { pages: [blue, green], similarity: 0.92 },
    ]);
    // Before, green named blue, which names red: a canonical chain.
    expect(found?.fix).toMatchObject([
      { url: blue, code: `<link rel="canonical" href="${red}">` },
      { url: green, code: `<link rel="canonical" href="${red}">` },
    ]);
  });
});

/** A live page that names itself as canonical, with `title` as its title, H1 and description. */
const titled = (url: string, title: string, head = "", body = "<p>x</p>") => ({
  ...record(url),
  page: extractPage(html(title, body, head, url), { url }),
});

describe("duplicate titles, descriptions and H1s of language versions", () => {
  const contact = `${ORIGIN}/contact`;
  const nlContact = `${ORIGIN}/nl/contact`;
  const contactUs = `${ORIGIN}/contact-us`;
  const contactLinks = `${alt("en", "contact")}${alt("nl", "nl/contact")}${alt("x-default", "contact")}`;
  const openSource = `${ORIGIN}/open-source`;
  const nlOpenSource = `${ORIGIN}/nl/open-source`;
  const help = `${ORIGIN}/help`;
  const support = `${ORIGIN}/support`;

  const findings = runSiteRules(
    context({
      pages: [
        // Not a version of the contact page, and reached before it: it shares the title with both.
        titled(contactUs, "Contact"),
        // Translations whose title is the same word in both languages, and whose text is not.
        titled(contact, "Contact", contactLinks, `<p>${words("contact")}</p>`),
        titled(
          nlContact,
          "Contact",
          contactLinks,
          `<p>${words("contact")}</p>`
        ),
        // en and de do not name each other, but both are versions of the nl page.
        titled(
          `${ORIGIN}/authors/ada`,
          "Ada Lovelace",
          `${alt("en", "authors/ada")}${alt("nl", "nl/authors/ada")}`
        ),
        titled(
          `${ORIGIN}/nl/authors/ada`,
          "Ada Lovelace",
          `${alt("en", "authors/ada")}${alt("nl", "nl/authors/ada")}${alt("de", "de/authors/ada")}`
        ),
        titled(
          `${ORIGIN}/de/authors/ada`,
          "Ada Lovelace",
          `${alt("nl", "nl/authors/ada")}${alt("de", "de/authors/ada")}`
        ),
        // The nl page does not link back, so Google ignores the pair.
        titled(
          openSource,
          "Open source",
          `${alt("en", "open-source")}${alt("nl", "nl/open-source")}`
        ),
        titled(nlOpenSource, "Open source", alt("nl", "nl/open-source")),
        // Both call each other en: one language twice, not two versions.
        titled(help, "Help", `${alt("en", "help")}${alt("en", "support")}`),
        titled(support, "Help", `${alt("en", "help")}${alt("en", "support")}`),
      ],
    })
  );

  const groupsOf = (rule: string) =>
    findings.find((f) => f.rule === rule)?.evidence?.["groups"];

  it("does not group a page with its language versions", () => {
    const groups = [
      { pages: [contactUs, contact, nlContact], count: 3 },
      { pages: [openSource, nlOpenSource], count: 2 },
      { pages: [help, support], count: 2 },
    ];

    expect(
      findings.find((f) => f.rule === "site.duplicate-titles")?.message
    ).toBe("3 title(s) are shared by 7 pages.");
    expect(groupsOf("site.duplicate-titles")).toStrictEqual([
      { value: "Contact", ...groups[0] },
      { value: "Open source", ...groups[1] },
      { value: "Help", ...groups[2] },
    ]);
    expect(groupsOf("site.duplicate-h1")).toMatchObject(groups);
    expect(groupsOf("site.duplicate-descriptions")).toMatchObject(groups);
  });

  // In the open source and help pairs each page is a version of its own: the first keeps the title.
  it("retitles the page that shares a title with translations, not the translations", () => {
    expect(fixOf(findings, "site.duplicate-titles")).toMatchObject([
      { url: contactUs, current: "<title>Contact</title>" },
      { url: nlOpenSource, current: "<title>Open source</title>" },
      { url: support, current: "<title>Help</title>" },
    ]);
  });

  it("still reports language versions whose text is left untranslated", () => {
    expect(
      findings.find((f) => f.rule === "site.duplicate-content")?.evidence?.[
        "groups"
      ]
    ).toStrictEqual([{ pages: [contact, nlContact], similarity: 1 }]);
  });
});

describe("robots.txt line endings", () => {
  it("numbers lines as robots-parser does when a lone CR ends them", () => {
    const text = "User-agent: *\rAllow: /public/\rDisallow: /\r";

    expect(blockingRule(`${ORIGIN}/robots.txt`, text, `${ORIGIN}/a`)).toBe(
      "Disallow: /"
    );
  });
});
