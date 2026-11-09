import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditSite, auditUrl } from "../src/core/audit.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

const rulesOf = (findings: { rule: string }[]) => findings.map((f) => f.rule);

describe("audits of a site served over HTTP", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer(siteRoutes());
  });

  afterAll(async () => {
    await server.close();
  });

  describe(auditUrl, () => {
    it("fetches, follows redirects and audits a live page", async () => {
      const audit = await auditUrl(`${server.origin}/redirect`);
      expect(audit.response?.status).toBe(200);
      expect(audit.response?.redirectChain).toHaveLength(1);
      expect(audit.url).toBe(`${server.origin}/about/`);
      expect(rulesOf(audit.findings)).toContain("response.redirected");
      expect(audit.summary.title).toBe("Home page title for fixture");
    });

    it("reports fetch failures as a finding instead of throwing", async () => {
      const audit = await auditUrl("http://127.0.0.1:9/", {
        fetch: { timeoutMs: 2000 },
      });

      expect(audit.findings[0]?.rule).toBe("response.fetch-failed");
      expect(audit.score).toBeLessThan(100);
    });
  });

  describe(auditSite, () => {
    describe("a crawl of the whole fixture site", () => {
      let site: Awaited<ReturnType<typeof auditSite>>;
      let siteRules: string[];
      let requestsDuringCrawl: string[];

      const evidence = (rule: string) =>
        JSON.stringify(
          site.siteFindings.find((f) => f.rule === rule)?.evidence
        );

      beforeAll(async () => {
        site = await auditSite(server.origin, {
          maxPages: 20,
          maxDepth: 3,
          concurrency: 3,
        });
        siteRules = rulesOf(site.siteFindings);
        // A later crawl ignores robots.txt and fetches the disallowed page, so keep what was
        // requested up to now.
        requestsDuringCrawl = [...server.requests];
      });

      it("reads robots.txt and the sitemap and crawls the linked pages", () => {
        expect(site.kind).toBe("site");
        expect(site.robotsTxt?.found).toBeTruthy();
        expect(site.sitemaps.urlCount).toBe(5);
        expect(site.crawl.pagesCrawled).toBeGreaterThanOrEqual(3);
        expect(site.pages.map((p) => p.url)).toStrictEqual(
          expect.arrayContaining([
            `${server.origin}/`,
            `${server.origin}/about/`,
            `${server.origin}/blog/post-1`,
          ])
        );
      });

      it.each([
        ["site.broken-internal-links", "/missing"],
        ["site.redirected-internal-links", "/redirect"],
        ["site.redirect-chains", "/chain"],
        ["site.sitemap-noindex-page", "/blog/post-1"],
        ["site.sitemap-broken-url", "/gone"],
        ["site.orphan-pages", "/orphan"],
        ["site.robots-blocked-pages", "/private/secret"],
      ])("reports %s with %s in its evidence", (rule, url) => {
        expect(siteRules).toContain(rule);
        expect(evidence(rule)).toContain(url);
      });

      it("reports duplicate titles and nothing wrong with soft 404s, the sitemap or robots.txt", () => {
        expect(siteRules).toContain("site.duplicate-titles");
        // Quoted as the pages write it, not as the lowercased key the pages are grouped by.
        expect(evidence("site.duplicate-titles")).toContain(
          '"value":"Home page title for fixture"'
        );
        expect(siteRules).not.toContain("site.soft-404");
        expect(siteRules).not.toContain("site.sitemap-missing");
        expect(siteRules).not.toContain("site.robots-txt-missing");
      });

      it("does not fetch a page robots.txt disallows", () => {
        expect(requestsDuringCrawl).not.toContain("/private/secret");
      });

      it("rolls page findings up by rule", () => {
        expect(site.issues.length).toBeGreaterThan(0);
        expect(
          site.issues.every((i) => i.pages >= 1 && i.examples.length >= 1)
        ).toBeTruthy();
        expect(site.score).toBeGreaterThanOrEqual(0);
      });
    });

    it("respects maxPages and reports the limit", async () => {
      const site = await auditSite(server.origin, {
        maxPages: 1,
        maxDepth: 3,
      });

      expect(site.crawl.pagesCrawled).toBe(1);
      expect(site.crawl.hitPageLimit).toBeTruthy();
      expect(rulesOf(site.siteFindings)).toContain("site.crawl-limit-reached");
      expect(rulesOf(site.siteFindings)).not.toContain("site.orphan-pages");
    });

    it("can ignore robots.txt", async () => {
      const site = await auditSite(server.origin, {
        maxPages: 20,
        respectRobots: false,
      });

      expect(site.pages.map((p) => p.url)).toContain(
        `${server.origin}/private/secret`
      );
    });

    it("pageDetail summary strips per-page findings", async () => {
      const site = await auditSite(server.origin, {
        maxPages: 5,
        pageDetail: "summary",
      });

      expect(site.pages.every((p) => p.findings.length === 0)).toBeTruthy();
      expect(site.issues.length).toBeGreaterThan(0);
    });
  });
});
