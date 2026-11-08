import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";

import { auditDirectory, auditTarget } from "../src/core/audit.js";

const page = (title: string, body: string, canonicalPath: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><meta name="description" content="Description for ${title} that is comfortably long enough for the threshold."><link rel="canonical" href="https://www.example.com${canonicalPath}"></head><body><h1>${title}</h1>${body}</body></html>`;

const text = Array.from(
  { length: 40 },
  () => "Static site words about things and stuff in sentences."
).join(" ");

describe("audits of static build output", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-"));
    await mkdir(path.join(dir, "blog"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      page(
        "Home of the static fixture",
        `<p>${text}</p><a href="/about.html">About</a> <a href="/blog/">Blog</a> <a href="/nope">Nope</a> <a href="https://www.example.com/about">Abs</a>`,
        "/"
      )
    );
    await writeFile(
      path.join(dir, "about.html"),
      page(
        "About the static fixture",
        `<p>${text}</p><a href="/">Home</a> <a href="/blog/">Blog</a>`,
        "/about"
      )
    );
    await writeFile(
      path.join(dir, "blog", "index.html"),
      page(
        "Blog of the static fixture",
        `<p>${text}</p><a href="/">Home</a>`,
        "/blog/"
      )
    );
    await writeFile(
      path.join(dir, "lonely.html"),
      page(
        "Lonely page nobody links",
        `<p>${text}</p><a href="/">Home</a>`,
        "/lonely"
      )
    );
    await writeFile(
      path.join(dir, "sitemap.xml"),
      "<urlset><url><loc>https://www.example.com/</loc></url><url><loc>https://www.example.com/about</loc></url><url><loc>https://www.example.com/blog/</loc></url><url><loc>https://www.example.com/ghost</loc></url></urlset>"
    );
    await writeFile(
      path.join(dir, "robots.txt"),
      "User-agent: *\nAllow: /\nSitemap: https://www.example.com/sitemap.xml\n"
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe(auditDirectory, () => {
    let site: Awaited<ReturnType<typeof auditDirectory>>;
    let rules: string[];

    const ev = (rule: string) =>
      JSON.stringify(site.siteFindings.find((f) => f.rule === rule)?.evidence);

    beforeAll(async () => {
      site = await auditDirectory(dir, { baseUrl: "https://www.example.com" });
      rules = site.siteFindings.map((f) => f.rule);
    });

    it("audits every built HTML file", () => {
      expect(site.source).toBe("directory");
      expect(site.pages).toHaveLength(4);
      expect(site.pages.map((p) => p.url).toSorted()).toStrictEqual([
        "about.html",
        "blog/index.html",
        "index.html",
        "lonely.html",
      ]);
    });

    it.each([
      ["site.broken-internal-links", "/nope"],
      ["site.sitemap-broken-url", "/ghost"],
      ["site.unlinked-pages", "lonely.html"],
      ["site.not-in-sitemap", "lonely"],
    ])("reports %s with %s in its evidence", (rule, item) => {
      expect(rules).toContain(rule);
      expect(ev(rule)).toContain(item);
    });

    it("resolves a link to a file without its .html extension", () => {
      expect(ev("site.broken-internal-links")).not.toContain("/about");
    });

    it("finds the sitemap and robots.txt in the output", () => {
      expect(rules).not.toContain("site.sitemap-missing");
      expect(rules).not.toContain("site.robots-txt-missing");
    });

    it("compares canonicals by path, so a page's own canonical is not another page", () => {
      const about = site.pages.find((p) => p.url === "about.html");
      assert(about, "about.html was audited");
      expect(about.findings.map((f) => f.rule)).not.toContain(
        "canonical.other-page"
      );
      expect(about.depth).toBe(1);
    });
  });

  describe(auditTarget, () => {
    it("detects directories and files", async () => {
      const site = await auditTarget(dir, {
        baseUrl: "https://www.example.com",
      });

      expect(site.kind).toBe("site");

      const file = await auditTarget(path.join(dir, "about.html"));
      expect(file).toMatchObject({ kind: "page", source: "file" });
    });
  });
});
