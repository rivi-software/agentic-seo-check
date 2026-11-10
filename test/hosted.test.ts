import { gzipSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { sleep } from "../src/core/concurrency.js";
import type { RequestGate } from "../src/core/fetch.js";
import {
  HOSTED_LIMITS,
  hostedUrlProblem,
  siteRefusal,
} from "../src/core/hosted.js";
import { createMcpServer } from "../src/mcp.js";
import type {
  HostedCallEnd,
  HostedCallInfo,
  HostedProfile,
} from "../src/mcp.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; agentic-seo-check/0.0.0-test; +https://mcp.agentic-seo.rivi.software/crawler)";

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
}

/** Every request of the last `serve`, with when it was sent and its headers. */
const sentRequests: { url: string; at: number; headers: Headers }[] = [];

/**
 * The site the core's fetch() sees, by absolute URL ("*" answers every other URL), and the
 * requests it got with their User-Agent.
 */
const serve = (routes: Record<string, Route>) => {
  const requests: { url: string; userAgent: string | null }[] = [];
  sentRequests.length = 0;

  // oxlint-disable-next-line eslint/require-await -- fetch() answers with a promise
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, userAgent: headers.get("user-agent") });
    sentRequests.push({ url, at: performance.now(), headers });
    const route = routes[url] ?? routes["*"];

    return new Response(
      route ? (route.body ?? "") : "<title>Not found</title>",
      {
        status: route ? (route.status ?? 200) : 404,
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...route?.headers,
        },
      }
    );
  });

  return requests;
};

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`;

interface Profile {
  profile: HostedProfile;
  calls: HostedCallInfo[];
  ends: HostedCallEnd[];
}

/** A hosted profile that lets every call through, with `gate` as the server's own limits. */
const profileWith = (
  options: {
    gate?: RequestGate;
    refuse?: string;
    sign?: HostedProfile["sign"];
  } = {}
): Profile => {
  const calls: HostedCallInfo[] = [];
  const ends: HostedCallEnd[] = [];

  return {
    calls,
    ends,
    profile: {
      userAgent: USER_AGENT,
      sign: options.sign,
      // oxlint-disable-next-line eslint/require-await -- the Worker's startCall awaits its limits
      startCall: async (call) => {
        calls.push(call);

        if (options.refuse) {
          throw new Error(options.refuse);
        }

        return { gate: options.gate, end: (end) => ends.push(end) };
      },
    },
  };
};

const connect = async (profile: HostedProfile) => {
  const server = createMcpServer({ hosted: profile });
  const client = new Client({ name: "test-client", version: "0.0.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const [first] = CallToolResultSchema.parse(result).content;
  assert(first?.type === "text", "the first content block is text");

  return first.text;
};

const Findings = z.object({
  findings: z.array(
    z.object({
      rule: z.string(),
      message: z.string(),
      evidence: z.record(z.string(), z.unknown()).optional(),
    })
  ),
});

const SiteFindings = z.object({
  siteFindings: z.array(
    z.object({
      rule: z.string(),
      message: z.string(),
      evidence: z.record(z.string(), z.unknown()).optional(),
    })
  ),
});

const rulesOf = (findings: { rule: string }[]) => findings.map((f) => f.rule);

describe("the hosted server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("its address rules", () => {
    it("allows http and https URLs on public hostnames", () => {
      for (const url of [
        "https://www.example.com/page?q=1",
        "http://example.co.uk:8080/",
        "https://shop.example.com./",
      ]) {
        expect(hostedUrlProblem(new URL(url))).toBeUndefined();
      }
    });

    it("refuses other schemes, credentials, IP addresses and local names", () => {
      const problems = Object.fromEntries(
        [
          "ftp://example.com/",
          "https://user:secret@example.com/",
          "http://127.0.0.1/",
          "http://2130706433/",
          "http://[::1]:3000/",
          "http://localhost:3000/",
          "http://app.localhost/",
          "http://printer.local/",
          "http://metadata.google.internal/",
          "http://intranet/",
        ].map((url) => [url, hostedUrlProblem(new URL(url))])
      );

      expect(problems).toMatchObject({
        "ftp://example.com/": expect.stringContaining(
          "http and https URLs only"
        ),
        "https://user:secret@example.com/":
          expect.stringContaining("credentials"),
        "http://127.0.0.1/": expect.stringContaining("not IP addresses"),
        "http://2130706433/": expect.stringContaining(
          "not IP addresses (127.0.0.1)"
        ),
        "http://[::1]:3000/": expect.stringContaining("not IP addresses"),
        "http://localhost:3000/": expect.stringContaining(
          "cannot reach localhost"
        ),
        "http://app.localhost/": expect.stringContaining("cannot reach"),
        "http://printer.local/": expect.stringContaining("cannot reach"),
        "http://metadata.google.internal/":
          expect.stringContaining("cannot reach"),
        "http://intranet/": expect.stringContaining("cannot reach intranet"),
      });
    });

    it("tells a site's refusal from its page", () => {
      const url = new URL("https://www.example.com/a");

      const answer = (status: number, headers: Record<string, string> = {}) =>
        siteRefusal(url, { status, headers: new Headers(headers) });

      expect(answer(200)).toBeUndefined();
      expect(answer(404)).toBeUndefined();
      expect(answer(403)?.scope).toBe("url");
      expect(answer(429)?.scope).toBe("host");
      expect(answer(403, { "cf-mitigated": "challenge" })?.scope).toBe("host");
    });
  });

  describe("its MCP tools", () => {
    it("lists the local server's tools that work without the user's machine, capped", async () => {
      const client = await connect(profileWith().profile);
      const { tools } = await client.listTools();

      expect(tools.map((t) => t.name).toSorted()).toStrictEqual([
        "seo_aeo_audit",
        "seo_audit_page",
        "seo_crawl_site",
        "seo_list_rules",
      ]);

      const inputs = tools.flatMap((t) =>
        Object.keys(t.inputSchema.properties ?? {})
      );

      for (const left of [
        "render",
        "lighthouse",
        "formFactor",
        "userAgent",
        "headers",
        "aiBots",
        "dir",
        "respectRobots",
      ]) {
        expect(inputs).not.toContain(left);
      }

      const crawl = tools.find((t) => t.name === "seo_crawl_site");
      const pageTool = tools.find((t) => t.name === "seo_audit_page");

      expect(crawl?.inputSchema.properties).toMatchObject({
        maxPages: { maximum: 25 },
        maxDepth: { maximum: 3 },
        concurrency: { maximum: 4 },
        includePatterns: { maxItems: 20, items: { maxLength: 200 } },
        timeoutMs: { maximum: 15_000 },
      });
      expect(pageTool?.inputSchema.properties).toMatchObject({
        html: { maxLength: HOSTED_LIMITS.maxHtmlChars },
      });
      expect(pageTool?.description).toContain(
        "npx -y @rivi-software/agentic-seo-check mcp"
      );
      expect(pageTool?.description).not.toContain("localhost dev server");
    });

    it("audits inline HTML as a call that requests nothing", async () => {
      const { profile, calls, ends } = profileWith();
      const client = await connect(profile);

      const result = await client.callTool({
        name: "seo_audit_page",
        arguments: {
          html: "<html><head><title>React App</title></head><body></body></html>",
          baseUrl: "https://a.example.com/",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(
        rulesOf(Findings.parse(result.structuredContent).findings)
      ).toContain("title.generic");
      expect(calls).toStrictEqual([
        { tool: "seo_audit_page", fetches: false, crawl: false, host: null },
      ]);
      expect(ends).toStrictEqual([{ outcome: "ok", pages: 1 }]);
    });

    it("answers a call the server refuses with the refusal", async () => {
      const client = await connect(
        profileWith({ refuse: "This address has started 30 tool calls." })
          .profile
      );

      const result = await client.callTool({
        name: "seo_list_rules",
        arguments: { rule: "title.missing" },
      });

      expect(result.isError).toBeTruthy();
      expect(textOf(result)).toBe(
        "agentic-seo-check error: This address has started 30 tool calls."
      );
    });

    it("answers a call whose end the server could not record, and tells it the end once", async () => {
      serve({
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", ""),
        },
      });

      const ends: HostedCallEnd[] = [];

      const client = await connect({
        userAgent: USER_AGENT,
        // oxlint-disable-next-line eslint/require-await -- the Worker's startCall awaits its limits
        startCall: async () => ({
          end: (end) => {
            ends.push(end);
            throw new TypeError("An index is longer than 96 bytes.");
          },
        }),
      });

      const result = await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/" },
      });

      expect(result.isError).toBeFalsy();
      expect(
        Findings.parse(result.structuredContent).findings
      ).not.toHaveLength(0);
      expect(ends).toStrictEqual([{ outcome: "ok", pages: 1 }]);
    });

    it("refuses a URL it may not request before the call starts", async () => {
      const requests = serve({});
      const { profile, calls } = profileWith();
      const client = await connect(profile);

      const results = await Promise.all(
        [
          ["seo_audit_page", "http://localhost:3000/"],
          ["seo_crawl_site", "http://192.168.1.10/"],
          ["seo_aeo_audit", "file:///etc/passwd"],
        ].map(([name, url]) =>
          client.callTool({ name: name ?? "", arguments: { url } })
        )
      );

      expect(results.map((r) => r.isError)).toStrictEqual([true, true, true]);
      expect(results.map(textOf)).toStrictEqual([
        expect.stringContaining("cannot reach localhost"),
        expect.stringContaining("not IP addresses (192.168.1.10)"),
        expect.stringContaining("http and https URLs only"),
      ]);
      expect(calls).toStrictEqual([]);
      expect(requests).toStrictEqual([]);
    });

    it("caps the inputs a call can make the server work on", async () => {
      const client = await connect(profileWith().profile);

      const tooMany = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://www.example.com/", maxPages: 26 },
      });

      const tooLong = await client.callTool({
        name: "seo_audit_page",
        arguments: { html: "x".repeat(HOSTED_LIMITS.maxHtmlChars + 1) },
      });

      expect(tooMany.isError).toBeTruthy();
      expect(tooLong.isError).toBeTruthy();
    });

    it("requests with its own User-Agent and reads the first 2 MB of a page", async () => {
      const big = page(
        "Widgets for every workshop",
        `<p>${"Blue widgets for workshops. ".repeat(100_000)}</p>`
      );

      const requests = serve({ "https://shop.example.com/": { body: big } });
      const { profile, calls, ends } = profileWith();
      const client = await connect(profile);

      const result = await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/" },
      });

      const { findings } = Findings.parse(result.structuredContent);

      expect(requests).toStrictEqual([
        { url: "https://shop.example.com/robots.txt", userAgent: USER_AGENT },
        { url: "https://shop.example.com/", userAgent: USER_AGENT },
      ]);
      expect(calls).toStrictEqual([
        {
          tool: "seo_audit_page",
          fetches: true,
          crawl: false,
          host: "shop.example.com",
        },
      ]);
      expect(ends).toStrictEqual([{ outcome: "ok", pages: 1 }]);
      expect(
        findings.find((f) => f.rule === "response.truncated")
      ).toMatchObject({
        message:
          "The audit read the first 2.0 MB of the page and stopped there.",
      });
    });

    it("says a site turned it away rather than auditing the refusal", async () => {
      serve({
        "https://a.example.com/": { status: 403, body: page("Forbidden", "") },
        "https://b.example.com/": { status: 429, body: "slow down" },
        "https://c.example.com/": {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
          body: page("Just a moment...", ""),
        },
        "https://d.example.com/": {
          status: 503,
          body: page("Just a moment...", ""),
        },
      });

      const { profile, ends } = profileWith();
      const client = await connect(profile);

      const texts = await Promise.all(
        ["a", "b", "c", "d"].map(async (host) =>
          textOf(
            await client.callTool({
              name: "seo_audit_page",
              arguments: { url: `https://${host}.example.com/` },
            })
          )
        )
      );

      expect(texts).toStrictEqual([
        expect.stringContaining("answered the hosted server with HTTP 403"),
        expect.stringContaining("answered the hosted server with HTTP 429"),
        expect.stringContaining(
          "with a challenge page (cf-mitigated: challenge)"
        ),
        expect.stringContaining(
          'with a challenge page ("Just a moment...", HTTP 503)'
        ),
      ]);
      expect(ends.map((e) => e.outcome)).toStrictEqual([
        "refused",
        "refused",
        "refused",
        "refused",
      ]);
      // The site decides what it serves: the refusal names no way around it.
      expect(texts.join("\n")).not.toContain("local server");
    });

    it("leaves the links it may not request unchecked, never broken", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n",
        },
        "https://shop.example.com/": {
          body: page(
            "Shop home page for the fixture",
            '<a href="/forbidden">Members</a> <a href="/missing">Gone</a> <a href="http://192.168.1.10/admin">Router</a> <a href="http://intranet/wiki">Wiki</a> <a href="https://blocked.example.org/">Elsewhere</a>'
          ),
        },
        "https://shop.example.com/forbidden": {
          status: 403,
          body: page("Forbidden", ""),
        },
        "https://blocked.example.org/": {
          status: 403,
          body: page("Forbidden", ""),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: {
          url: "https://shop.example.com/",
          checkExternalLinks: true,
          pageDetail: "full",
          detail: "full",
        },
      });

      const { siteFindings } = SiteFindings.parse(result.structuredContent);

      const broken = JSON.stringify(
        siteFindings.filter((f) => f.rule.startsWith("site.broken"))
      );

      expect(broken).toContain("https://shop.example.com/missing");
      expect(
        [
          "/forbidden",
          "192.168.1.10",
          "intranet",
          "blocked.example.org",
        ].filter((target) => broken.includes(target))
      ).toStrictEqual([]);
      expect(rulesOf(siteFindings)).not.toContain("site.crawl-stopped");
    });

    it("stops a crawl the server's limit for the site ends, and says so", async () => {
      const links = Array.from(
        { length: 8 },
        (_, i) => `<a href="/page-${i}">Page ${i}</a>`
      ).join(" ");

      const pages = Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `https://shop.example.com/page-${i}`,
          {
            body: page(
              `Page number ${i} of the fixture`,
              '<a href="/">Home</a>'
            ),
          },
        ])
      );

      serve({
        ...pages,
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", links),
        },
        "https://shop.example.com/sitemap.xml": {
          headers: { "content-type": "application/xml" },
          body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from(
            { length: 8 },
            (_, i) => `<url><loc>https://shop.example.com/page-${i}</loc></url>`
          ).join(
            ""
          )}<url><loc>https://shop.example.com/only-in-sitemap</loc></url></urlset>`,
        },
      });

      let sent = 0;

      const gate: RequestGate = {
        beforeRequest: () => {
          sent += 1;

          return sent > 6
            ? {
                scope: "host",
                message:
                  "The hosted server has sent shop.example.com 300 requests in the last minute.",
              }
            : undefined;
        },
      };

      const client = await connect(profileWith({ gate }).profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/", concurrency: 1 },
      });

      expect(result.isError).toBeFalsy();
      const { siteFindings } = SiteFindings.parse(result.structuredContent);
      const stopped = siteFindings.find((f) => f.rule === "site.crawl-stopped");

      expect(stopped?.message).toMatch(
        /^The crawl stopped after \d+ page\(s\): The hosted server has sent shop\.example\.com 300 requests in the last minute\.$/u
      );
      // Pages and sitemap URLs the crawl never reached are not orphans.
      expect(rulesOf(siteFindings)).not.toContain("site.orphan-pages");
      expect(rulesOf(siteFindings)).not.toContain("site.broken-internal-links");
    });

    it("takes a site's own error page titled 'Access denied' for the site's answer", async () => {
      serve({
        "https://shop.example.com/": {
          body: page(
            "Shop home page for the fixture",
            '<a href="/members">Members</a> <a href="/b">B</a>'
          ),
        },
        "https://shop.example.com/members": {
          status: 401,
          body: page("Access denied", "<p>Sign in first.</p>"),
        },
        "https://shop.example.com/b": {
          body: page("Page B of the fixture", '<a href="/">Home</a>'),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/", detail: "full" },
      });

      const { siteFindings } = SiteFindings.parse(result.structuredContent);

      expect(rulesOf(siteFindings)).not.toContain("site.crawl-stopped");
      expect(
        JSON.stringify(
          siteFindings.find((f) => f.rule === "site.broken-internal-links")
        )
      ).toContain("https://shop.example.com/members");
    });

    it("stops a crawl the site starts refusing, and says so", async () => {
      serve({
        "https://shop.example.com/": {
          body: page(
            "Shop home page for the fixture",
            '<a href="/a">A</a> <a href="/b">B</a>'
          ),
        },
        "https://shop.example.com/a": { status: 429, body: "slow down" },
        "https://shop.example.com/b": {
          body: page("Page B of the fixture", '<a href="/">Home</a>'),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/", concurrency: 1 },
      });

      const { siteFindings } = SiteFindings.parse(result.structuredContent);

      expect(
        siteFindings.find((f) => f.rule === "site.crawl-stopped")?.message
      ).toContain("shop.example.com answered the hosted server with HTTP 429");
      expect(rulesOf(siteFindings)).not.toContain("site.broken-internal-links");
    });

    it("obeys a robots.txt group for agentic-seo-check, without reporting it as a problem", async () => {
      const requests = serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n\nUser-agent: agentic-seo-check\nDisallow: /private/\n",
        },
        "https://shop.example.com/": {
          body: page(
            "Shop home page for the fixture",
            '<a href="/private/report">Report</a>'
          ),
        },
        "https://other.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: agentic-seo-check\nDisallow: /\n",
        },
      });

      const client = await connect(profileWith().profile);

      const crawl = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/" },
      });

      const kept = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://other.example.com/" },
      });

      const { siteFindings } = SiteFindings.parse(crawl.structuredContent);

      expect(requests.map((r) => r.url)).not.toContain(
        "https://shop.example.com/private/report"
      );
      expect(rulesOf(siteFindings)).not.toContain("site.robots-blocked-pages");
      expect(kept.isError).toBeTruthy();
      // The site's reason and nothing more: no way around robots.txt.
      expect(textOf(kept)).toBe(
        "agentic-seo-check error: https://other.example.com/robots.txt asks agentic-seo-check not to crawl https://other.example.com/ (in a User-agent: agentic-seo-check group), so there is nothing to crawl."
      );
      expect(requests.map((r) => r.url)).not.toContain(
        "https://other.example.com/"
      );
    });

    it("sends a site whose robots.txt keeps every crawler out nothing but the robots.txt request", async () => {
      const requests = serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: agentic-seo-check\nDisallow: /\n\nUser-agent: *\nDisallow: /\n",
        },
        "*": { body: page("Shop home page for the fixture", "") },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/" },
      });

      const { siteFindings } = SiteFindings.parse(result.structuredContent);

      // No page, no sitemap and none of the soft-404, http and www probes: all are under the
      // disallowed /, and a sitemap that was not requested is unread, not missing.
      expect(requests.map((r) => r.url)).toStrictEqual([
        "https://shop.example.com/robots.txt",
      ]);
      expect(rulesOf(siteFindings)).toContain("site.robots-txt-blocks-all");
      expect(rulesOf(siteFindings)).not.toContain("site.sitemap-missing");
    });

    it("reads sitemaps up to 5 MB and says which were larger", async () => {
      const large = gzipSync(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${"<url><loc>https://shop.example.com/x</loc></url>".repeat(120_000)}</urlset>`
      );

      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\nSitemap: https://shop.example.com/large.xml.gz\n",
        },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", ""),
        },
        "https://shop.example.com/large.xml.gz": {
          headers: { "content-type": "application/gzip" },
          body: new Uint8Array(large),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/" },
      });

      const { siteFindings } = SiteFindings.parse(result.structuredContent);

      expect(
        siteFindings.find((f) => f.rule === "site.sitemap-too-large")?.message
      ).toBe(
        "1 sitemap(s) are larger than the 5 MB this audit reads, so their URLs were not checked."
      );
    });

    it("finishes a crawl whose probes of made-up URLs the site refuses", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n",
        },
        "https://shop.example.com/sitemap.xml": { status: 404 },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", '<a href="/a">A</a>'),
        },
        "https://shop.example.com/a": {
          body: page("Page A of the fixture", '<a href="/">Home</a>'),
        },
        // The soft-404, http and www probes ask for URLs nobody links to.
        "*": { status: 429, body: "slow down" },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/" },
      });

      const { siteFindings } = SiteFindings.parse(result.structuredContent);

      expect(result.isError).toBeFalsy();
      expect(rulesOf(siteFindings)).not.toContain("site.crawl-stopped");
    });

    it("does not ask a host that refused it again, behind a redirect", async () => {
      const requests = serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n",
        },
        "https://shop.example.com/": {
          body: page(
            "Shop home page for the fixture",
            '<a href="/a">A</a> <a href="/b">B</a>'
          ),
        },
        "https://shop.example.com/a": {
          status: 301,
          headers: { location: "https://cdn.example.net/a" },
        },
        "https://shop.example.com/b": {
          status: 301,
          headers: { location: "https://cdn.example.net/b" },
        },
        "https://cdn.example.net/a": { status: 429, body: "slow down" },
        "https://cdn.example.net/b": { status: 429, body: "slow down" },
      });

      const client = await connect(profileWith().profile);

      await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/", concurrency: 1 },
      });

      expect(
        requests
          .map((r) => r.url)
          .filter((u) => u.startsWith("https://cdn.example.net/"))
      ).toStrictEqual([
        "https://cdn.example.net/robots.txt",
        "https://cdn.example.net/a",
      ]);
    });

    it("obeys robots.txt for one page, and says only why", async () => {
      const requests = serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /private/\n",
        },
        "https://shop.example.com/private/report": {
          body: page("A report kept out of crawls", ""),
        },
      });

      const { profile, ends } = profileWith();
      const client = await connect(profile);

      const texts = await Promise.all(
        ["seo_audit_page", "seo_aeo_audit"].map(async (name) =>
          textOf(
            await client.callTool({
              name,
              arguments: { url: "https://shop.example.com/private/report" },
            })
          )
        )
      );

      expect(texts).toStrictEqual([
        'agentic-seo-check error: https://shop.example.com/robots.txt keeps agentic-seo-check from https://shop.example.com/private/report (line 5: "Disallow: /private/"), so the hosted server did not request it.',
        'agentic-seo-check error: https://shop.example.com/robots.txt keeps agentic-seo-check from https://shop.example.com/private/report (line 5: "Disallow: /private/"), so the hosted server did not request it.',
      ]);
      expect(ends.map((e) => e.outcome)).toStrictEqual(["refused", "refused"]);
      expect(requests.map((r) => r.url)).not.toContain(
        "https://shop.example.com/private/report"
      );
    });

    it("reads robots.txt once for an AEO audit of one page, before the page", async () => {
      const requests = serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n",
        },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", "<p>Widgets.</p>"),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_aeo_audit",
        arguments: { url: "https://shop.example.com/" },
      });

      expect(result.isError).toBeFalsy();
      expect(requests.map((r) => r.url)).toStrictEqual([
        "https://shop.example.com/robots.txt",
        "https://shop.example.com/",
        "https://shop.example.com/llms.txt",
      ]);
      expect(result.structuredContent).toMatchObject({
        crawlers: { bots: expect.any(Array) },
      });
    });

    it("takes a robots.txt that answers with a server error to disallow everything", async () => {
      const requests = serve({
        "https://shop.example.com/robots.txt": { status: 503, body: "down" },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", ""),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/" },
      });

      expect(textOf(result)).toBe(
        "agentic-seo-check error: https://shop.example.com/robots.txt answered HTTP 503, and a crawler that cannot read robots.txt takes it to disallow everything (RFC 9309), so the hosted server did not request https://shop.example.com/."
      );
      expect(requests.map((r) => r.url)).toStrictEqual([
        "https://shop.example.com/robots.txt",
      ]);
    });

    it("waits between a crawl's requests as robots.txt's Crawl-delay asks", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n\nUser-agent: agentic-seo-check\nCrawl-delay: 0.2\n",
        },
        "https://shop.example.com/": {
          body: page(
            "Shop home page for the fixture",
            '<a href="/a">A</a> <a href="/b">B</a> <a href="/c">C</a>'
          ),
        },
        "*": { body: page("A page of the fixture shop", "") },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/", concurrency: 4 },
      });

      expect(result.isError).toBeFalsy();

      const times = sentRequests.flatMap((r) =>
        r.url.startsWith("https://shop.example.com/") ? [r.at] : []
      );

      expect(times.length).toBeGreaterThan(4);

      // Timers may fire a millisecond early; the gaps are 200 ms, not the 0 of four at a time.
      for (const [i, at] of times.slice(1).entries()) {
        expect(at - (times[i] ?? 0)).toBeGreaterThanOrEqual(190);
      }
    });

    it("leaves the time its gate held a request out of the response time", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n",
        },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", ""),
        },
      });

      // Limits as slow to answer as robots.txt or a Crawl-delay can make the gate, refusing only
      // another site.
      const gate: RequestGate = {
        beforeRequest: async (url) => {
          await sleep(2500);

          return url.hostname === "other.example.com"
            ? { scope: "host", message: "Not this site." }
            : undefined;
        },
      };

      const client = await connect(profileWith({ gate }).profile);

      const result = await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/" },
      });

      const { findings } = Findings.parse(result.structuredContent);

      expect(rulesOf(findings)).not.toContain("response.slow");
    });

    it("leaves a one-page audit and other sites out of a site's Crawl-delay", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nCrawl-delay: 30\n",
        },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", ""),
        },
      });

      const client = await connect(profileWith().profile);
      const started = performance.now();

      const result = await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/" },
      });

      expect(result.isError).toBeFalsy();
      expect(performance.now() - started).toBeLessThan(5000);
    });

    it("stops a crawl whose Crawl-delay is longer than a hosted crawl waits, and says so", async () => {
      const requests = serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\nCrawl-delay: 60\n",
        },
        "*": { body: page("Shop home page for the fixture", "") },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_crawl_site",
        arguments: { url: "https://shop.example.com/" },
      });

      expect(JSON.stringify(result)).toContain(
        "https://shop.example.com/robots.txt asks agentic-seo-check to wait 60 s between requests (Crawl-delay), and a crawl on the hosted server waits at most 30 s in all for a site, so it sent shop.example.com no more requests."
      );
      expect(requests.map((r) => r.url)).toStrictEqual([
        "https://shop.example.com/robots.txt",
      ]);
    });

    it("signs every request it sends, each for the host it goes to", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n",
        },
        "https://shop.example.com/": {
          status: 301,
          headers: { location: "https://www.shop.example.com/" },
        },
        "https://www.shop.example.com/": {
          body: page("Shop home page for the fixture", ""),
        },
      });

      const signed: string[] = [];

      const client = await connect(
        profileWith({
          sign: (url) => {
            signed.push(url.href);

            return { signature: `sig1=:${url.host}:` };
          },
        }).profile
      );

      await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/" },
      });

      expect(
        sentRequests.map((r) => [r.url, r.headers.get("signature")])
      ).toStrictEqual([
        ["https://shop.example.com/robots.txt", "sig1=:shop.example.com:"],
        ["https://shop.example.com/", "sig1=:shop.example.com:"],
        [
          "https://www.shop.example.com/robots.txt",
          "sig1=:www.shop.example.com:",
        ],
        ["https://www.shop.example.com/", "sig1=:www.shop.example.com:"],
      ]);
      expect(signed).toStrictEqual(sentRequests.map((r) => r.url));
    });

    it("audits one page for AEO when the site refuses its robots.txt", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          status: 403,
          body: page("Forbidden", ""),
        },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", "<p>Widgets.</p>"),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_aeo_audit",
        arguments: { url: "https://shop.example.com/" },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        kind: "aeo",
        crawlers: null,
      });
    });

    it("stops an AEO crawl the site starts refusing, and leaves llms.txt unread", async () => {
      serve({
        "https://shop.example.com/robots.txt": {
          headers: { "content-type": "text/plain" },
          body: "User-agent: *\nAllow: /\n",
        },
        "https://shop.example.com/": {
          body: page("Shop home page for the fixture", '<a href="/a">A</a>'),
        },
        "https://shop.example.com/a": {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
          body: page("Just a moment...", ""),
        },
      });

      const client = await connect(profileWith().profile);

      const result = await client.callTool({
        name: "seo_aeo_audit",
        arguments: { url: "https://shop.example.com/", crawl: true },
      });

      const { findings } = Findings.parse(result.structuredContent);

      expect(rulesOf(findings)).toContain("aeo.crawl-stopped");
      expect(rulesOf(findings)).not.toContain("aeo.llms-txt-missing");
    });
  });
});
