import { describe, expect, it } from "vitest";

import { auditAeoHtml } from "../../src/core/aeo/audit.ts";
import { auditHtml } from "../../src/core/audit.ts";
import { ORIGIN } from "../src/limits.ts";
import { crawlerPage, landingPage } from "../src/pages.ts";

/** The audit of a page as the Worker serves it, at `path`. */
const audit = (html: string, path: string) => {
  const url = `${ORIGIN}${path}`;

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

describe("the hosted server's pages", () => {
  it("pass the server's own SEO audit", async () => {
    const landing = await audit(landingPage(100_000), "/");
    const crawler = await audit(crawlerPage(), "/crawler");

    expect(problems(landing.findings)).toStrictEqual([]);
    expect(problems(crawler.findings)).toStrictEqual([]);
  });

  it("pass the server's own AEO audit", async () => {
    const landing = await auditAeoHtml(landingPage(100_000), {
      url: `${ORIGIN}/`,
    });

    expect(problems(landing.findings)).toStrictEqual([]);
  });

  it("state the limits wrangler.jsonc sets", () => {
    const html = landingPage(100_000);

    for (const limit of [
      "300 requests a minute",
      "30 calls a minute, 3 crawls a minute among them",
      "300 calls a minute, 30 crawls a minute among them",
      "100,000 a day",
      "25 pages, 3 links deep, 50 link checks, 10 sitemaps of up to 5 MB",
      "the first 2 MB of its HTML, within 15 seconds",
    ]) {
      expect(html).toContain(limit);
    }
  });

  it("say how to report abuse and how to block the requests", () => {
    const html = crawlerPage();

    expect(html).toContain("https://help.rivi.software/contact");
    expect(html).toContain("User-agent: agentic-seo-check\nDisallow: /");
    expect(html).toContain('cf.worker.upstream_zone eq "rivi.software"');
    expect(html).toContain("User-agent: agentic-seo-check-local");
  });

  it("say how to recognise a request by its signature, and what robots.txt does", () => {
    const html = crawlerPage();

    expect(html).toContain(`Signature-Agent: "${ORIGIN}"`);
    expect(html).toContain(
      'href="/.well-known/http-message-signatures-directory"'
    );
    expect(html).toContain("Every audit reads robots.txt first and obeys it");
    expect(landingPage(100_000)).toContain(
      "The server obeys robots.txt for every request it sends"
    );
    expect(landingPage(100_000)).toContain(
      "https://help.rivi.software/contact"
    );
  });
});
