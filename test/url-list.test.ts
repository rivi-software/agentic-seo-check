import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { auditAeoSite } from "../src/core/aeo/audit.js";
import { auditSite } from "../src/core/audit.js";
import { InvalidUrlListError, listedPages } from "../src/core/url-list.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

const rulesOf = (findings: { rule: string }[]) => findings.map((f) => f.rule);

describe("a crawl of a list of URLs (issue #231)", () => {
  describe(listedPages, () => {
    const start = "https://example.com/";

    it("is null without a list, and normalizes, reads paths against the start URL and drops repeats", () => {
      expect(listedPages(start, undefined, 10)).toBeNull();
      expect(
        listedPages(
          start,
          [
            "/about/",
            "https://EXAMPLE.com/blog#top",
            "https://example.com/about/",
          ],
          10
        )
      ).toStrictEqual([
        "https://example.com/about/",
        "https://example.com/blog",
      ]);
    });

    it.each([
      [
        "another origin",
        ["https://other.example/"],
        10,
        "is not a URL on https://example.com",
      ],
      [
        "another scheme",
        ["http://example.com/a"],
        10,
        "is not a URL on https://example.com",
      ],
      ["no http(s) URL", ["mailto:a@example.com"], 10, "is not a URL on"],
      ["an empty list", [], 10, "`urls` is empty"],
      [
        "more than maxPages",
        ["/a", "/b", "/c"],
        2,
        "lists 3 pages, more than the 2",
      ],
    ])("refuses %s before any request", (_what, urls, maxPages, message) => {
      expect(() => listedPages(start, urls, maxPages)).toThrow(
        InvalidUrlListError
      );
      expect(() => listedPages(start, urls, maxPages)).toThrow(message);
    });
  });

  describe("on the fixture site", () => {
    let server: FixtureServer;

    beforeAll(async () => {
      server = await startFixtureServer(siteRoutes());
    });

    afterAll(async () => {
      await server.close();
    });

    describe("a list of two pages", () => {
      let site: Awaited<ReturnType<typeof auditSite>>;
      let rules: string[];

      beforeAll(async () => {
        site = await auditSite(server.origin, {
          urls: ["/about/", `${server.origin}/blog/post-1`],
        });
        rules = rulesOf(site.siteFindings);
      });

      it("audits exactly the listed pages and counts them beside the other page counts", () => {
        expect(site.pages.map((p) => p.url).toSorted()).toStrictEqual([
          `${server.origin}/about/`,
          `${server.origin}/blog/post-1`,
        ]);
        expect(site.crawl).toMatchObject({
          pagesCrawled: 2,
          pagesDiscovered: 2,
          pagesListed: 2,
          hitPageLimit: false,
        });
        expect(Object.keys(site.crawl).slice(0, 3)).toStrictEqual([
          "pagesCrawled",
          "pagesDiscovered",
          "pagesListed",
        ]);
      });

      it("runs the site rules over the listed pages, and reads robots.txt as a crawl does", () => {
        // /about/ links to a page robots.txt keeps out; the home page's broken link is not listed.
        expect(rules).toContain("site.robots-blocked-pages");
        expect(rules).toContain("site.sitemap-noindex-page");
        expect(rules).not.toContain("site.broken-internal-links");
        expect(server.requests).toContain("/robots.txt");
      });

      it("leaves out the orphan check, which needs every page's links, and reports no page limit", () => {
        expect(rules).not.toContain("site.orphan-pages");
        expect(rules).not.toContain("site.crawl-limit-reached");
      });
    });

    it("follows a listed URL's redirect to the page", async () => {
      const site = await auditSite(server.origin, { urls: ["/redirect"] });

      expect(site.pages.map((p) => p.url)).toStrictEqual([
        `${server.origin}/about/`,
      ]);
    });

    it("refuses a list longer than maxPages", async () => {
      await expect(
        auditSite(server.origin, { urls: ["/", "/about/"], maxPages: 1 })
      ).rejects.toThrow(InvalidUrlListError);
    });

    it("reads the CLI's --urls file: a URL or a path a line, without blank lines and comments", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "agentic-seo-urls-"));
      const file = path.join(dir, "urls.txt");
      await writeFile(
        file,
        `# changed pages\n/about/\n\n${server.origin}/blog/post-1\n`
      );

      // Exit code 1 is findings at or above --fail-on; the report is on stdout either way.
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "src/cli.ts",
        "crawl",
        server.origin,
        "--urls",
        file,
        "-f",
        "json",
        "-q",
      ]).catch((error: { stdout: string }) => error);

      const site = z
        .object({ pages: z.array(z.object({ url: z.string() })) })
        .parse(JSON.parse(stdout));

      expect(site.pages.map((p) => p.url).toSorted()).toStrictEqual([
        `${server.origin}/about/`,
        `${server.origin}/blog/post-1`,
      ]);
    });

    it("gives the AEO audit the listed pages only", async () => {
      const aeo = await auditAeoSite(server.origin, {
        urls: ["/about/", "/blog/post-1"],
      });

      expect(aeo.pages?.map((p) => p.url).toSorted()).toStrictEqual([
        `${server.origin}/about/`,
        `${server.origin}/blog/post-1`,
      ]);
    });
  });
});
