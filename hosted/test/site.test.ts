import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditAeoHtml, auditSiteBoth } from "../../src/core/aeo/audit.ts";
import type { SiteAudits } from "../../src/core/aeo/audit.ts";
import { crawlerAccess } from "../../src/core/aeo/bots.ts";
import { auditHtml } from "../../src/core/audit.ts";
import { ALL_RULES } from "../../src/core/rules/index.ts";
import { startFixtureServer } from "../../test/helpers/fixture-server.ts";
import type { FixtureServer } from "../../test/helpers/fixture-server.ts";
import { MCP_URL } from "../src/limits.ts";
import { crawlerPage, landingPage } from "../src/pages.ts";
import { isHomepage, readForm } from "../src/site/audit.ts";
import { LLMS_TXT, SITE_ROBOTS_TXT, SITEMAP_XML } from "../src/site/files.ts";
import { homePage, notFoundPage } from "../src/site/home.ts";
import { SITE_ORIGIN } from "../src/site/layout.ts";
import { renderReport } from "../src/site/report.ts";
import { rulesPage } from "../src/site/rules-page.ts";
import {
  progressClose,
  progressLine,
  renderSiteReport,
} from "../src/site/site-report.ts";
import { CLAUDE_DIRECTORY_URL } from "../src/ui/frame.ts";
import { OG_IMAGE, SERVER_CARD, SITE_CARD } from "../src/ui/og.ts";
import type { ShareCard } from "../src/ui/og.ts";
import { PRODUCT_HUNT_URL } from "../src/ui/product-hunt.ts";
import { FONT_PATHS, STYLE } from "../src/ui/style.ts";

/** The daily limits as wrangler.jsonc sets them. */
const DAILY = {
  DAILY_REQUESTS: 100_000,
  CALLER_SITES: 10,
  PLATFORM_SITES: 100,
};

const OPEN = {
  open: true,
  crawls: true,
  siteKey: "1x00000000000000000000BB",
};

/** The audit of a page as the Worker serves it, at `path`. */
const audit = (html: string, path: string) => {
  const url = `${SITE_ORIGIN}${path}`;

  return auditHtml(html, {
    url,
    source: "url",
    target: url,
    response: {
      status: 200,
      finalUrl: url,
      redirectChain: [],
      timeMs: 20,
      contentType: "text/html; charset=utf-8",
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "br",
        "cache-control": "no-cache",
      },
    },
  });
};

/** Findings above info: what the pages must not have. */
const problems = (findings: { rule: string; severity: string }[]) =>
  findings.flatMap((f) => (f.severity === "info" ? [] : [f.rule]));

/** A page whose title, heading and tags try to break out of the report that quotes them. */
const HOSTILE = `<!doctype html><html><head><title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title></head><body><h1>&lt;img src=x onerror=alert(2)&gt;</h1><img src="a.png" data-x="</script><script>alert(3)</script>"></body></html>`;

describe("the website's pages", () => {
  it("pass the tool's own SEO audit", async () => {
    const home = await audit(homePage(OPEN), "/");
    const rules = await audit(rulesPage(), "/rules");

    expect(problems(home.findings)).toStrictEqual([]);
    // It names "lorem ipsum" in content.placeholder-text's description, a mention and no filler.
    expect(problems(rules.findings)).toStrictEqual([]);
  });

  it("pass the tool's own AEO audit", async () => {
    const home = await auditAeoHtml(homePage(OPEN), {
      url: `${SITE_ORIGIN}/`,
    });

    const rules = await auditAeoHtml(rulesPage(), {
      url: `${SITE_ORIGIN}/rules`,
    });

    expect(problems(home.findings)).toStrictEqual([]);
    expect(problems(rules.findings)).toStrictEqual([]);
  });

  it("list every rule the audits report, each under its id, closed on what to change", () => {
    const html = rulesPage();

    for (const rule of ALL_RULES) {
      expect(html).toContain(
        `<details class="rule sev-${rule.severity}" id="${rule.id}">`
      );
    }

    // The filter needs the script, which shows it.
    expect(html).toContain('<div class="rules-filter" hidden>');
  });

  it("show the form only when the audit is on", () => {
    expect(homePage(OPEN)).toContain('action="/audit"');
    expect(homePage(OPEN)).toContain('data-sitekey="1x00000000000000000000BB"');

    const off = homePage({ open: false, crawls: false, siteKey: "" });

    expect(off).not.toContain("<form");
    expect(off).not.toContain("challenges.cloudflare.com");
    expect(off).toContain("switched off");
  });

  it("escape the address and the refusal they are given", () => {
    const html = homePage({
      ...OPEN,
      url: '"><script>alert(1)</script>',
      error: "<b>no</b>",
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;b&gt;no&lt;/b&gt;");
  });

  it("share one frame and one hostname with the hosted server's pages (issue #168)", () => {
    const site = [homePage(OPEN), rulesPage(), notFoundPage()];
    const server = [landingPage(DAILY), crawlerPage()];

    for (const html of [...site, ...server]) {
      expect(html).toContain('<script src="/site.js" defer></script>');

      // The headings' font and the copy's: every page opens with both.
      for (const font of [FONT_PATHS.display, FONT_PATHS.sans]) {
        expect(html).toContain(
          `<link rel="preload" href="${font}" as="font" type="font/woff2" crossorigin>`
        );
      }
    }

    // Every page links the others in its header and footer, as paths on the one hostname.
    for (const html of [...site, ...server]) {
      expect(html).toContain('href="/mcp"');
      expect(html).toContain('href="/crawler"');
      expect(html).toContain('href="/rules"');
      expect(html).not.toContain('href="https://mcp.');
    }
  });

  it("give every page its share image, the website's or the server's, which the audit then finds complete", async () => {
    const pages: [html: string, path: string, card: ShareCard][] = [
      [homePage(OPEN), "/", SITE_CARD],
      [rulesPage(), "/rules", SITE_CARD],
      [landingPage(DAILY), "/mcp", SERVER_CARD],
      [crawlerPage(), "/crawler", SERVER_CARD],
    ];

    const audits = await Promise.all(
      pages.map(([html, path]) =>
        auditHtml(html, { url: `${SITE_ORIGIN}${path}`, source: "url" })
      )
    );

    for (const [index, [html, , card]] of pages.entries()) {
      expect(html).toContain(
        `<meta property="og:image" content="${SITE_ORIGIN}${card.path}">`
      );
      expect(html).toContain(
        '<meta name="twitter:card" content="summary_large_image">'
      );
      expect(audits[index]?.findings.map((f) => f.rule)).not.toContain(
        "og.incomplete"
      );
    }
  });

  it("let Google-Extended in past the section Cloudflare puts before robots.txt, and only there", () => {
    // What Bot Preference Sync prepends for a zone such as rivi.software, cut to two of its groups.
    const managed =
      "# BEGIN Cloudflare Managed content\n\nUser-agent: *\nContent-Signal: search=yes,ai-train=no,use=reference\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\n# END Cloudflare Managed Content\n\n";

    const url = `${SITE_ORIGIN}/robots.txt`;
    const text = managed + SITE_ROBOTS_TXT;

    const access = (pages: string[]) =>
      crawlerAccess(
        {
          url,
          status: 200,
          found: true,
          sitemaps: [],
          text,
          bytes: text.length,
        },
        text,
        pages[0] ?? `${SITE_ORIGIN}/`,
        pages
      ).bots;

    const allowed = (pages: string[], name: string) =>
      access(pages).find((b) => b.name === name)?.allowed;

    expect(allowed([`${SITE_ORIGIN}/`], "Google-Extended")).toBeTruthy();
    expect(allowed([`${SITE_ORIGIN}/audit`], "Google-Extended")).toBeFalsy();
    expect(allowed([`${SITE_ORIGIN}/`], "GPTBot")).toBeFalsy();
  });

  it("quote the example finding as text, not markup", () => {
    expect(homePage(OPEN)).toContain("&lt;link rel=\\&quot;canonical\\&quot;");
  });

  it("name the site's pages in the sitemap, robots.txt and llms.txt", () => {
    expect(SITEMAP_XML).toContain(`<loc>${SITE_ORIGIN}/rules</loc>`);
    expect(SITE_ROBOTS_TXT).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    expect(SITE_ROBOTS_TXT).toContain("Disallow: /audit");
    expect(LLMS_TXT.startsWith("# Agentic SEO Check\n\n> ")).toBeTruthy();
    expect(notFoundPage()).toContain("Not found");
  });

  it("list the server's pages in the website's sitemap, since they share its hostname (issue #168)", () => {
    expect(SITEMAP_XML).toContain(`<loc>${MCP_URL}</loc>`);
    expect(SITEMAP_XML).toContain(`<loc>${SITE_ORIGIN}/crawler</loc>`);
  });

  it("link the hosted server's listing in the Claude Directory, as a badge where it is offered", () => {
    const link = `href="${CLAUDE_DIRECTORY_URL}"`;

    for (const html of [rulesPage(), crawlerPage(), notFoundPage()]) {
      expect(html).toContain(link);
    }

    for (const html of [homePage(OPEN), landingPage(DAILY)]) {
      expect(html).toContain(`<a class="badge" ${link}>`);
    }

    expect(LLMS_TXT).toContain(`](${CLAUDE_DIRECTORY_URL})`);
  });

  it("show Product Hunt's badge beside the Claude Directory's, with the upvotes the Worker read", () => {
    const link = `<a class="badge" href="${PRODUCT_HUNT_URL.replaceAll("&", "&amp;")}" target="_blank" rel="noopener noreferrer"><span class="badge-key">Product Hunt</span>`;

    const shown = [
      homePage(OPEN),
      landingPage(DAILY),
      rulesPage(),
      crawlerPage(),
      notFoundPage(),
    ].map((html) => html.includes(link));

    expect(shown).toStrictEqual([true, true, false, false, false]);
    expect(homePage(OPEN)).toMatch(
      /<div class="badges"><a class="badge" href="https:\/\/claude\.ai[^>]+>.*?<\/a><a class="badge" href="https:\/\/www\.producthunt\.com/u
    );

    // Nothing on the page is loaded from Product Hunt.
    for (const html of [homePage(OPEN), landingPage(DAILY)]) {
      expect(html).not.toContain("api.producthunt.com");
    }
  });
});

/** The anchors the report's tab strip links to, in its order. */
const tabsOf = (report: string): string[] => {
  const start = report.indexOf('<nav class="report-tabs"');

  return [
    ...report
      .slice(start, report.indexOf("</nav>", start))
      .matchAll(/href="#(?<id>[a-z-]+)"/gu),
  ].map((match) => match.groups?.id ?? "");
};

/** The anchors among `ids` that the report has no panel for. */
const missingPanels = (report: string, ids: string[]): string[] =>
  ids.filter((id) => !report.includes(`class="report-panel" id="${id}"`));

/** The overview's "Fix first" card, up to the end of its list. */
const fixFirstCard = (report: string): string => {
  const card = report.slice(report.indexOf('id="fix-first"'));

  return card.slice(0, card.indexOf("</ol>"));
};

/** The rows of the "Fix first" card: the severity of each, and the anchor it links to. */
const fixFirstLinks = (report: string) =>
  [
    ...fixFirstCard(report).matchAll(
      /class="fix-row sev-(?<severity>[a-z]+)" href="#(?<id>[a-z0-9-]+)"/gu
    ),
  ].map((match) => match.groups ?? {});

/** The "Fix first" rows that name no finding of the report under their own severity. */
const deadFixLinks = (report: string) =>
  fixFirstLinks(report).filter(
    (link) =>
      !report.includes(
        `<details class="finding sev-${link.severity}" id="${link.id}"`
      )
  );

describe("the report of a page audit", () => {
  it("shows both audits' scores and findings with their fixes", async () => {
    const url = "https://shop.example.com/";

    const html =
      "<html><head><title>React App</title></head><body></body></html>";

    const report = renderReport(
      await auditHtml(html, { url, source: "url", target: url }),
      await auditAeoHtml(html, { url })
    );

    expect(report).toContain("SEO: search engines");
    expect(report).toContain("AEO: AI answer engines");
    expect(report).toContain("<code>title.generic</code>");
    expect(report).toContain('class="edits"');
    expect(report).toContain('id="report-data"');
  });

  it("shows real visits from the Chrome UX Report only when the audit has field data (issue #130)", async () => {
    const url = "https://shop.example.com/";

    const html =
      "<html><head><title>React App</title></head><body></body></html>";

    const seo = await auditHtml(html, { url, source: "url", target: url });
    const aeo = await auditAeoHtml(html, { url });
    const metric = { p75: 4400, good: 0.5, needsImprovement: 0.2, poor: 0.3 };

    const reports = [
      seo,
      {
        ...seo,
        fieldData: {
          source: null,
          reason: "no-data" as const,
          message: "The Chrome UX Report has no record for this URL.",
        },
      },
      {
        ...seo,
        fieldData: {
          source: "url" as const,
          formFactor: "PHONE" as const,
          period: { firstDate: "2026-10-13", lastDate: "2026-11-09" },
          lcpMs: metric,
          inpMs: null,
          cls: null,
          fcpMs: null,
          ttfbMs: null,
        },
      },
    ].map((withField) => renderReport(withField, aeo));

    expect(
      reports.map((report) => report.includes("Real visits on phones"))
    ).toStrictEqual([false, true, true]);
    expect(reports[1]).toContain("has no record for this URL");
    expect(reports[2]).toContain("4,400 ms");
  });

  it("is in sections, with a tab for each, the SEO findings by category and an index of them", async () => {
    const url = "https://shop.example.com/";

    const html =
      "<html><head><title>React App</title></head><body></body></html>";

    const report = renderReport(
      await auditHtml(html, { url, source: "url", target: url }),
      await auditAeoHtml(html, { url })
    );

    const tabs = tabsOf(report);
    const titles = report.slice(report.indexOf('id="seo-title"'));

    expect(tabs.slice(0, 3)).toStrictEqual(["overview", "seo", "aeo"]);
    expect(missingPanels(report, tabs)).toStrictEqual([]);
    expect(titles).toContain("<h4>Titles</h4>");
    expect(
      titles.slice(0, titles.indexOf('class="finding-group"', 1))
    ).toContain("<code>title.generic</code>");
    // The overview's index has a tile for the category, which links to its card.
    expect(report).toMatch(
      /<a class="index-tile is-[a-z]+" href="#seo-title">/u
    );
  });

  it("lists the errors and warnings to fix first, each a link to its finding, and names each score's band", async () => {
    const url = "https://shop.example.com/";

    const html = readFileSync(
      new URL("../../test/fixtures/bad-page.html", import.meta.url),
      "utf-8"
    );

    const report = renderReport(
      await auditHtml(html, { url, source: "url", target: url }),
      await auditAeoHtml(html, { url })
    );

    const links = fixFirstLinks(report);

    expect(links).toHaveLength(5);
    expect(links[0]?.severity).toBe("error");
    expect(links.map((link) => link.severity)).not.toContain("info");
    // Every link names a finding the report has, under the same severity.
    expect(deadFixLinks(report)).toStrictEqual([]);
    expect(report).toContain('<span class="verdict">Poor</span>');
  });

  it("says so when a page has nothing to fix first", async () => {
    const url = "https://shop.example.com/";

    const report = renderReport(
      { ...(await auditHtml("<html></html>", { url })), findings: [] },
      { ...(await auditAeoHtml("<html></html>", { url })), findings: [] }
    );

    expect(report).toContain("No errors and no warnings");
    expect(report).not.toContain('class="fix-row');
  });

  it("downloads as a PDF, and says on paper when the audit ran", async () => {
    const url = "https://shop.example.com/";

    const html =
      "<html><head><title>React App</title></head><body></body></html>";

    const report = renderReport(
      {
        ...(await auditHtml(html, { url, source: "url", target: url })),
        auditedAt: "2026-11-11T14:05:09.000Z",
      },
      await auditAeoHtml(html, { url })
    );

    expect(report).toContain('data-report="pdf"');
    expect(report).toContain(
      '<p class="report-print">Audited on 11 November 2026 at 14:05 UTC with Agentic SEO Check by RIVI Software, <a href="https://agentic-seo.org/">agentic-seo.org</a></p>'
    );
  });

  it("never lets the audited page's text become markup", async () => {
    const url = "https://shop.example.com/";

    const report = renderReport(
      await auditHtml(HOSTILE, { url, source: "url", target: url }),
      await auditAeoHtml(HOSTILE, { url })
    );

    // The only elements a report opens are its own; the page's are quoted as text.
    expect(report).not.toContain("<script>alert");
    expect(report).not.toContain("<img");
    expect(report.match(/<script/gu)).toHaveLength(1);
    expect(report.match(/<\/script/gu)).toHaveLength(1);
  });
});

describe("the report of a site audit", () => {
  let server: FixtureServer;
  let audits: SiteAudits;
  let report: string;

  beforeAll(async () => {
    // A homepage whose title, heading, tags and a link try to break out of the report.
    server = await startFixtureServer({
      "/": {
        body: HOSTILE.replace(
          "</body>",
          '<a href="/about">About</a><a href="/x&quot;&gt;&lt;script&gt;alert(4)&lt;/script&gt;">Broken</a></body>'
        ),
      },
      "/about": {
        body: '<!doctype html><html lang="en"><head><title>About the fixture</title></head><body><h1>About</h1><a href="/">Home</a></body></html>',
      },
    });
    audits = await auditSiteBoth(server.origin, {
      maxPages: 5,
      pageDetail: "summary",
    });
    report = renderSiteReport(audits);
  });

  afterAll(async () => {
    await server.close();
  });

  it("shows both scores, the crawl, the findings across the site and on the pages, and the pages", () => {
    const parts = [
      "Site audit report",
      "SEO: search engines",
      "AEO: AI answer engines",
      'id="crawl"',
      "<code>site.broken-internal-links</code>",
      'id="pages"',
      'id="report-data"',
    ];

    expect(parts.filter((part) => !report.includes(part))).toStrictEqual([]);
  });

  it("is in sections, with the findings on the pages by category under those across the site", () => {
    const tabs = tabsOf(report);

    const seo = report.slice(
      report.indexOf('id="seo"'),
      report.indexOf('id="aeo"')
    );

    expect(tabs.slice(0, 5)).toStrictEqual([
      "overview",
      "seo",
      "aeo",
      "home",
      "pages",
    ]);
    expect(missingPanels(report, tabs)).toStrictEqual([]);
    expect(seo.indexOf('id="seo-site"')).toBeLessThan(
      seo.indexOf("On the pages, by rule")
    );
    expect(seo).toContain('<div class="finding-group" id="seo-pages-');
    // The AEO rules share one category, so its findings on the pages are one group.
    expect(report).not.toContain('id="aeo-pages-aeo"');
  });

  it("lists what to fix first across the site and on its pages, each a link to its finding", () => {
    const links = fixFirstLinks(report);
    const ids = links.map((link) => link.id ?? "");

    expect(links.map((link) => link.severity)).not.toContain("info");
    // A finding across the site, and a rule on the pages with how many pages have it.
    expect(
      [/^seo-site-/u, /^(?:seo|aeo)-pages-/u].filter(
        (group) => !ids.some((id) => group.test(id))
      )
    ).toStrictEqual([]);
    expect(fixFirstCard(report)).toMatch(
      /<span class="chip">\d+ pages?<\/span>/u
    );
    expect(deadFixLinks(report)).toStrictEqual([]);
  });

  it("links each page to the form with its address, and runs nothing", () => {
    const about = encodeURIComponent(`${server.origin}/about`);

    expect(report).toContain(`href="/?url=${about}#audit"`);
    expect(report).not.toContain('action="');
  });

  it("shows the homepage's own findings with their edits", () => {
    const home = report.slice(
      report.indexOf('id="home"'),
      report.indexOf('id="pages"')
    );

    expect(audits.start?.seo.findings.length).toBeGreaterThan(0);
    expect(home).toContain("<code>img.alt-missing</code>");
    expect(home).toContain('class="edits"');
  });

  it("puts the homepage's worst group first, whichever audit it is from", () => {
    const { start } = audits;
    const info = start?.seo.findings.filter((f) => f.severity === "info") ?? [];
    const [base] = info;

    expect(base).toBeDefined();

    if (!start || !base) {
      return;
    }

    // SEO findings that are only info, and an AEO error on the page, which comes after them.
    const html = renderSiteReport({
      ...audits,
      start: {
        seo: { ...start.seo, findings: info },
        aeo: {
          ...start.aeo,
          findings: [
            {
              ...base,
              rule: "aeo.page-error",
              severity: "error",
              category: "aeo",
            },
          ],
        },
      },
    });

    const home = html.slice(
      html.indexOf('id="home"'),
      html.indexOf('id="pages"')
    );

    expect(
      home
        .slice(home.indexOf('class="finding-group"'))
        .startsWith('class="finding-group" id="home-aeo"')
    ).toBeTruthy();
  });

  it("downloads as a PDF, and says on paper when the crawl ran", () => {
    expect(report).toContain('data-report="pdf"');
    expect(report).toMatch(
      /<p class="report-print">Audited on \d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2} UTC with /u
    );
  });

  it("never lets the site's text become markup", () => {
    expect(report).not.toContain("<script>alert");
    expect(report).not.toContain("<img");
    expect(report.match(/<script/gu)).toHaveLength(1);
    expect(report.match(/<\/script/gu)).toHaveLength(1);
  });

  it("escapes the crawl's progress and its failure", () => {
    const lines = [
      progressLine({
        phase: "crawl",
        message: "200 https://shop.example.com/<script>alert(1)</script>",
        crawled: 1,
      }),
      progressLine({ phase: "links", message: "<b>Checking</b>" }),
      progressClose("<img src=x>"),
    ].join("");

    expect(lines).not.toContain("<script>");
    expect(lines).not.toContain("<b>");
    expect(lines).not.toContain("<img");
  });
});

describe("the address the form is given", () => {
  it("is a homepage, which starts a crawl, with no path and no query", () => {
    const homepages = [
      "https://shop.example.com",
      "https://shop.example.com/",
      "https://shop.example.com/#top",
    ];

    const pages = [
      "https://shop.example.com/pricing",
      "https://shop.example.com/?lang=en",
      "https://shop.example.com/index.html",
    ];

    expect(homepages.map((url) => isHomepage(new URL(url)))).toStrictEqual(
      homepages.map(() => true)
    );
    expect(pages.map((url) => isHomepage(new URL(url)))).toStrictEqual(
      pages.map(() => false)
    );
  });

  it("makes the form say so, and the page report point to the crawl", async () => {
    const url = "https://shop.example.com/pricing";

    const html =
      "<html><head><title>Pricing</title></head><body></body></html>";

    const page = renderReport(
      await auditHtml(html, { url, source: "url", target: url }),
      await auditAeoHtml(html, { url })
    );

    expect(homePage(OPEN)).toContain('data-crawls="on"');
    expect(homePage({ ...OPEN, crawls: false })).not.toContain("data-crawls");
    expect(page).toContain(
      "enter its homepage: <code>https://shop.example.com/</code>"
    );
  });

  it("keeps the form busy while a crawl's answer streams in", () => {
    const busy = homePage({ ...OPEN, crawling: true });

    expect(busy).toContain(
      'class="btn btn-primary btn-lg is-busy" type="submit" disabled'
    );
    expect(busy).toContain('data-idle="Run the audit">Crawling the site…');
  });
});

/** The form as a POST with the Content-Length `length`, or without one. */
const post = (length: string | null) =>
  new Request("https://agentic-seo.org/audit", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(length === null ? null : { "content-length": length }),
    },
    body: "url=https%3A%2F%2Fshop.example.com%2F",
  });

describe("the audit form's body", () => {
  it("is read when it comes with its length", async () => {
    const form = await readForm(post("37"));

    expect(form?.get("url")).toBe("https://shop.example.com/");
  });

  it("is not read without a length, as a chunked body has none", async () => {
    const request = post(null);

    await expect(readForm(request)).resolves.toBeNull();
    expect(request.bodyUsed).toBeFalsy();
  });

  it("is not read with a length that is no number, or one over the cap", async () => {
    const answers = await Promise.all(
      ["many", "1e3", "-1", "16385", ""].map(async (length) => {
        const request = post(length);

        return [await readForm(request), request.bodyUsed];
      })
    );

    expect(answers).toStrictEqual(answers.map(() => [null, false]));
  });
});

/** A PNG's signature and the size its IHDR chunk gives. */
const pngHeader = (file: string) => {
  const bytes = readFileSync(new URL(`../assets/${file}`, import.meta.url));

  return {
    signature: bytes.subarray(0, 8).toString("hex"),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
};

describe("the share images", () => {
  it("are PNGs of the size the pages state", () => {
    for (const card of [SITE_CARD, SERVER_CARD]) {
      expect(pngHeader(card.file)).toStrictEqual({
        signature: "89504e470d0a1a0a",
        width: OG_IMAGE.width,
        height: OG_IMAGE.height,
      });
    }
  });
});

describe("the stylesheet on paper", () => {
  const print = STYLE.slice(STYLE.indexOf("@media print{"));

  it("prints a report alone, on white, with every section and without the evidence", () => {
    const rules = [
      "--bg:#fff",
      "print-color-adjust:exact",
      "main:has(>.report)>:not(.report){display:none}",
      ".report-panel[hidden]{display:block;content-visibility:visible}",
      ".report-print{display:block",
    ];

    expect(STYLE).toContain("@media print{");
    expect(rules.filter((rule) => !print.includes(rule))).toStrictEqual([]);
    expect(print).toMatch(/[,{]\.evidence[,{]/u);
    expect(print).toMatch(/[,{]\.report-tabs[,{]/u);
  });
});
