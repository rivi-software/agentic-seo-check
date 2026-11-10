import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditAeoHtml } from "../../src/core/aeo/audit.ts";
import { auditHtml } from "../../src/core/audit.ts";
import { ALL_RULES } from "../../src/core/rules/index.ts";
import { ORIGIN as MCP_ORIGIN } from "../src/limits.ts";
import { crawlerPage, landingPage } from "../src/pages.ts";
import { readForm } from "../src/site/audit.ts";
import { LLMS_TXT, SITE_ROBOTS_TXT, SITEMAP_XML } from "../src/site/files.ts";
import { homePage, notFoundPage } from "../src/site/home.ts";
import { SITE_ORIGIN } from "../src/site/layout.ts";
import { renderReport } from "../src/site/report.ts";
import { rulesPage } from "../src/site/rules-page.ts";
import { OG_IMAGE, SERVER_CARD, SITE_CARD } from "../src/ui/og.ts";

const OPEN = { open: true, siteKey: "1x00000000000000000000BB" };

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
        "cache-control": "public, max-age=3600",
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
    // The rules page quotes "lorem ipsum" as the text content.placeholder-text looks for, which
    // that rule cannot tell from placeholder text left in a page.
    expect(problems(rules.findings)).toStrictEqual([
      "content.placeholder-text",
    ]);
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

  it("list every rule the audits report, each under its id", () => {
    const html = rulesPage();

    for (const rule of ALL_RULES) {
      expect(html).toContain(`id="${rule.id}"`);
    }
  });

  it("show the form only when the audit is on", () => {
    expect(homePage(OPEN)).toContain('action="/audit"');
    expect(homePage(OPEN)).toContain('data-sitekey="1x00000000000000000000BB"');

    const off = homePage({ open: false, siteKey: "" });

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

  it("share one frame with the hosted server's pages, served from each page's own hostname", () => {
    const site = [homePage(OPEN), rulesPage(), notFoundPage()];
    const server = [landingPage(100_000), crawlerPage()];

    for (const html of [...site, ...server]) {
      expect(html).toContain('<script src="/site.js" defer></script>');
      expect(html).toContain(
        '<link rel="preload" href="/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>'
      );
    }

    // Each hostname links the other's pages in its header and footer.
    for (const html of site) {
      expect(html).toContain(`href="${MCP_ORIGIN}/crawler"`);
    }

    for (const html of server) {
      expect(html).toContain(`href="${SITE_ORIGIN}/rules"`);
    }
  });

  it("give every page its hostname's share image, which the audit then finds complete", async () => {
    const pages: [html: string, origin: string, path: string][] = [
      [homePage(OPEN), SITE_ORIGIN, "/"],
      [rulesPage(), SITE_ORIGIN, "/rules"],
      [landingPage(100_000), MCP_ORIGIN, "/"],
      [crawlerPage(), MCP_ORIGIN, "/crawler"],
    ];

    const audits = await Promise.all(
      pages.map(([html, origin, path]) =>
        auditHtml(html, { url: `${origin}${path}`, source: "url" })
      )
    );

    for (const [index, [html, origin]] of pages.entries()) {
      expect(html).toContain(
        `<meta property="og:image" content="${origin}${OG_IMAGE.path}">`
      );
      expect(html).toContain(
        '<meta name="twitter:card" content="summary_large_image">'
      );
      expect(audits[index]?.findings.map((f) => f.rule)).not.toContain(
        "og.incomplete"
      );
    }
  });

  it("quote the example finding as text, not markup", () => {
    expect(homePage(OPEN)).toContain("&lt;link rel=\\&quot;canonical\\&quot;");
  });

  it("name the site's pages in the sitemap, robots.txt and llms.txt", () => {
    expect(SITEMAP_XML).toContain(`<loc>${SITE_ORIGIN}/rules</loc>`);
    expect(SITE_ROBOTS_TXT).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    expect(SITE_ROBOTS_TXT).toContain("Disallow: /audit");
    expect(LLMS_TXT.startsWith("# agentic-seo-check\n\n> ")).toBeTruthy();
    expect(notFoundPage()).toContain("Not found");
  });
});

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

/** The form as a POST with the Content-Length `length`, or without one. */
const post = (length: string | null) =>
  new Request("https://agentic-seo.rivi.software/audit", {
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
