/**
 * The Worker as Cloudflare runs it: built by Wrangler with the same defines as a deploy, run in
 * workerd, and driven over Streamable HTTP by the SDK's client, as test/mcp.test.ts drives the
 * local server over stdio. The Worker's own requests go to `site`, never to the internet.
 */
import { gzipSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { z } from "zod";

import { HOSTED_LIMITS } from "../../src/core/hosted.ts";
import { readVersion, defines } from "../scripts/defines.ts";

const ORIGIN = "https://mcp.agentic-seo.rivi.software";
const SITE = "https://agentic-seo.rivi.software";
const FORMER = "https://mcp.agentic-seo-check.rivi.software";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const html = (title: string, body = "", head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`;

/** Bytes of a page whose title is written in another charset than UTF-8. */
const encoded = (bytes: number[]) =>
  new Uint8Array([
    ...new TextEncoder().encode("<!doctype html><html><head><title>"),
    ...bytes,
    ...new TextEncoder().encode("</title></head><body><p>x</p></body></html>"),
  ]);

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
}

/** The sites the Worker's fetch() reaches, by absolute URL. */
const site = new Map<string, Route>(
  Object.entries<Route>({
    "https://shop.example.com/robots.txt": {
      headers: { "content-type": "text/plain" },
      body: "User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml.gz\n",
    },
    "https://shop.example.com/": {
      body: html(
        "Shop home page for the fixture",
        '<a href="/about">About</a> <a href="/missing">Missing</a> <a href="http://10.0.0.1/admin">Router</a>'
      ),
    },
    "https://shop.example.com/about": {
      body: html("About the fixture shop", '<a href="/">Home</a>'),
    },
    "https://shop.example.com/sitemap.xml.gz": {
      headers: { "content-type": "application/gzip" },
      body: new Uint8Array(
        gzipSync(
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://shop.example.com/</loc></url><url><loc>https://shop.example.com/about</loc></url></urlset>'
        )
      ),
    },
    "https://shop.example.com/large": {
      body: html(
        "A page larger than the cap",
        `<p>${"word ".repeat(600_000)}</p>`
      ),
    },
    "https://shop.example.com/cp1252": {
      headers: { "content-type": "text/html; charset=windows-1252" },
      body: encoded([67, 97, 102, 233, 32, 151, 32, 49, 48, 128]),
    },
    "https://shop.example.com/sjis": {
      headers: { "content-type": "text/html; charset=Shift_JIS" },
      body: encoded([
        147, 250, 150, 123, 140, 234, 130, 204, 131, 121, 129, 91, 131, 87,
      ]),
    },
    "https://walled.example.com/": {
      status: 403,
      headers: { "cf-mitigated": "challenge" },
      body: html("Just a moment..."),
    },
    "https://openai.com/chatgpt-connectors.json": {
      headers: { "content-type": "application/octet-stream" },
      body: '{"creationTime":"2026-11-06T18:26:55","prefixes":[{"ipv4Prefix":"104.210.139.192/28"}]}',
    },
  })
);

/** What the Worker requested, with the User-Agent it sent. */
const requests: { url: string; userAgent: string | null }[] = [];

/** The Web Bot Auth headers of each request the Worker sent, by URL. */
const signatures = new Map<string, Record<string, string | null>>();

/** The eight bytes every PNG file starts with, as hex. */
const PNG_SIGNATURE = "89504e470d0a1a0a";

const signatureOf = (bytes: ArrayBuffer) =>
  Buffer.from(bytes.slice(0, 8)).toString("hex");

/** The keyid of the RFC 9421 test key in .dev.vars: its JWK thumbprint. */
const TEST_KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

/** The same Worker, answering as the website's hostname. */
let website: Awaited<ReturnType<typeof unstable_startWorker>>;

/** The same Worker, answering as the MCP server's hostname in 0.7.0. */
let former: Awaited<ReturnType<typeof unstable_startWorker>>;
let client: Client;
let base: URL;

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const [first] = CallToolResultSchema.parse(result).content;
  assert(first?.type === "text", "the first content block is text");

  return first.text;
};

const Audit = z.object({
  summary: z.object({ title: z.string().nullable() }).optional(),
  findings: z
    .array(z.object({ rule: z.string(), severity: z.string() }))
    .optional(),
  siteFindings: z
    .array(
      z.object({
        rule: z.string(),
        severity: z.string(),
        evidence: z.unknown(),
      })
    )
    .optional(),
  sitemaps: z.object({ sources: z.array(z.string()) }).optional(),
});

const audit = async (
  name: string,
  args: Record<string, string | number | boolean>
) => {
  const result = await client.callTool({ name, arguments: args });

  return { result, audit: Audit.safeParse(result.structuredContent).data };
};

/** Sends the audit form as a browser does, with Turnstile's token. */
const sendForm = (url: string, token = "a-person", origin = SITE) =>
  website.fetch(`${SITE}/audit`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body: new URLSearchParams({
      url,
      "cf-turnstile-response": token,
    }).toString(),
  });

/**
 * Starts the Worker in workerd, answering as `origin`: Wrangler's dev server gives every request
 * one hostname, whatever address it was sent to.
 */
const start = (origin: string) =>
  unstable_startWorker({
    config: new URL("../wrangler.jsonc", import.meta.url).pathname,
    build: { define: defines() },
    dev: {
      origin: { hostname: new URL(origin).hostname, secure: true },
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      persist: false,
      watch: false,
      // Serves /__scheduled, which runs the Cron Trigger.
      testScheduled: true,
      outboundService: async (request: Request) => {
        // Turnstile, as the audit form asks it: only the token "a-person" passes.
        if (request.url === SITEVERIFY) {
          const sent = new URLSearchParams(await request.text());

          return Response.json({
            success: sent.get("response") === "a-person",
          });
        }

        requests.push({
          url: request.url,
          userAgent: request.headers.get("user-agent"),
        });
        signatures.set(
          request.url,
          Object.fromEntries(
            ["signature-agent", "signature-input", "signature"].map((name) => [
              name,
              request.headers.get(name),
            ])
          )
        );

        // The hosted server auditing its own pages: answer from the Worker itself.
        if (request.url.startsWith(`${ORIGIN}/`)) {
          return worker.fetch(request.url);
        }

        const route = site.get(request.url);

        return new Response(route?.body ?? html("Not found"), {
          status: route ? (route.status ?? 200) : 404,
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...route?.headers,
          },
        });
      },
    },
  });

describe("the hosted Worker in workerd", () => {
  beforeAll(async () => {
    worker = await start(ORIGIN);
    website = await start(SITE);
    former = await start(FORMER);
    await Promise.all([worker.ready, website.ready, former.ready]);
    base = await worker.url;
    client = new Client({ name: "worker-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", base))
    );
  });

  afterAll(async () => {
    await client?.close();
    await Promise.all([
      worker?.dispose(),
      website?.dispose(),
      former?.dispose(),
    ]);
  });

  describe("the hosted Worker", () => {
    it("serves the hosted tools under the package's name and version", async () => {
      const { tools } = await client.listTools();

      expect(client.getServerVersion()).toMatchObject({
        name: "agentic-seo-check",
        version: readVersion(),
      });
      expect(tools.map((t) => t.name).toSorted()).toStrictEqual([
        "seo_aeo_audit",
        "seo_audit_page",
        "seo_crawl_site",
        "seo_list_rules",
      ]);
    });

    it("audits inline HTML", async () => {
      const { result, audit: page } = await audit("seo_audit_page", {
        html: "<html><head><title>React App</title></head><body></body></html>",
        baseUrl: "https://a.example.com/",
      });

      expect(result.isError).toBeFalsy();
      expect(page?.findings?.map((f) => f.rule)).toContain("title.generic");
    });

    it("refuses an address it may not request, without requesting it", async () => {
      const before = requests.length;

      const { result } = await audit("seo_audit_page", {
        url: "http://localhost:8787/",
      });

      expect(textOf(result)).toContain("cannot reach localhost");
      expect(requests).toHaveLength(before);
    });

    it("refuses a request body over the cap before parsing it", async () => {
      const res = await fetch(new URL("/mcp", base), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "seo_audit_page",
            arguments: { html: "x".repeat(HOSTED_LIMITS.maxRequestBytes) },
          },
        }),
      });

      expect(res.status).toBe(413);
    });

    it("requests a page with the hosted User-Agent and reads 2 MB of it", async () => {
      const { audit: page } = await audit("seo_audit_page", {
        url: "https://shop.example.com/large",
      });

      expect(requests.find((r) => r.url.endsWith("/large"))?.userAgent).toBe(
        `Mozilla/5.0 (compatible; agentic-seo-check/${readVersion()}; +${ORIGIN}/crawler)`
      );
      expect(page?.findings?.map((f) => f.rule)).toContain(
        "response.truncated"
      );
    });

    it("signs every request with Web Bot Auth, robots.txt first", async () => {
      await audit("seo_audit_page", { url: "https://shop.example.com/about" });

      for (const url of [
        "https://shop.example.com/robots.txt",
        "https://shop.example.com/about",
      ]) {
        expect(signatures.get(url)).toStrictEqual({
          "signature-agent": `"${ORIGIN}"`,
          "signature-input": expect.stringMatching(
            new RegExp(
              `^sig1=\\("@authority" "signature-agent"\\);created=\\d+;expires=\\d+;keyid="${TEST_KEYID}";alg="ed25519";nonce="[^"]+";tag="web-bot-auth"$`,
              "u"
            )
          ),
          signature: expect.stringMatching(/^sig1=:[\w+/]+={0,2}:$/u),
        });
      }
    });

    it("reads windows-1252 and Shift_JIS pages as Node does", async () => {
      const titles = await Promise.all(
        ["cp1252", "sjis"].map(async (path) => {
          const answer = await audit("seo_audit_page", {
            url: `https://shop.example.com/${path}`,
          });

          return answer.audit?.summary?.title;
        })
      );

      expect(titles).toStrictEqual(["Café — 10€", "日本語のページ"]);
    });

    it("crawls a site: robots.txt, a gzip sitemap, links, and an IP address left unchecked", async () => {
      const { result, audit: crawl } = await audit("seo_crawl_site", {
        url: "https://shop.example.com/",
      });

      expect(result.isError).toBeFalsy();
      expect(crawl?.sitemaps?.sources).toStrictEqual([
        "https://shop.example.com/sitemap.xml.gz",
      ]);

      const broken = JSON.stringify(
        crawl?.siteFindings?.find(
          (f) => f.rule === "site.broken-internal-links"
        )?.evidence
      );

      expect(broken).toContain("https://shop.example.com/missing");
      expect(requests.map((r) => r.url)).not.toContain("http://10.0.0.1/admin");
    });

    it("says a site turned it away", async () => {
      const { result } = await audit("seo_aeo_audit", {
        url: "https://walled.example.com/",
      });

      expect(result.isError).toBeTruthy();
      expect(textOf(result)).toContain(
        "walled.example.com answered the hosted server with a challenge page"
      );
    });

    it("passes its own audit, landing page included", async () => {
      const { result, audit: page } = await audit("seo_audit_page", {
        url: `${ORIGIN}/`,
      });

      // Cloudflare compresses the Worker's HTML and asks origins for compression on its network;
      // local workerd does neither, so the compression check has nothing to go on here.
      expect(result.isError).toBeFalsy();
      expect(
        page?.findings
          ?.filter(
            (f) => f.severity !== "info" && f.rule !== "loading.no-compression"
          )
          .map((f) => f.rule)
      ).toStrictEqual([]);
    });
  });

  describe("the hosted Worker's other addresses", () => {
    it("serve the landing page, the page for site owners, robots.txt, the icon, and the website's script and fonts", async () => {
      const answers = await Promise.all(
        [
          "/",
          "/crawler",
          "/robots.txt",
          "/favicon.svg",
          "/site.js",
          "/og.png",
          "/fonts/geist-latin.woff2",
          "/fonts/geist-mono-latin.woff2",
          "/nope",
        ].map(async (path) => {
          const res = await fetch(new URL(path, base));
          await res.arrayBuffer();

          return [path, res.status, res.headers.get("content-type")];
        })
      );

      expect(answers).toStrictEqual([
        ["/", 200, "text/html; charset=utf-8"],
        ["/crawler", 200, "text/html; charset=utf-8"],
        ["/robots.txt", 200, "text/plain; charset=utf-8"],
        ["/favicon.svg", 200, "image/svg+xml"],
        ["/site.js", 200, "text/javascript; charset=utf-8"],
        ["/og.png", 200, "image/png"],
        ["/fonts/geist-latin.woff2", 200, "font/woff2"],
        ["/fonts/geist-mono-latin.woff2", 200, "font/woff2"],
        ["/nope", 404, "text/html; charset=utf-8"],
      ]);
    });

    it("answer browsers' preflight and leave GET /mcp to POST", async () => {
      const preflight = await fetch(new URL("/mcp", base), {
        method: "OPTIONS",
      });

      const get = await fetch(new URL("/mcp", base));

      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(get.status).toBe(405);
    });

    it("serve the Web Bot Auth key directory, signed", async () => {
      const res = await fetch(
        new URL("/.well-known/http-message-signatures-directory", base)
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/http-message-signatures-directory+json"
      );
      expect(res.headers.get("signature-input")).toContain(
        `("@authority";req);alg="ed25519";keyid="${TEST_KEYID}";`
      );
      await expect(res.json()).resolves.toStrictEqual({
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
          },
        ],
      });
    });

    it("answer no OpenAI domain challenge until one is set", async () => {
      const res = await fetch(
        new URL("/.well-known/openai-apps-challenge", base)
      );

      expect(res.status).toBe(404);
    });

    it("fetch OpenAI's ChatGPT connector ranges on the daily schedule", async () => {
      const res = await fetch(new URL("/__scheduled?cron=17+3+*+*+*", base));

      expect(res.status).toBe(200);
      expect(requests.map((r) => r.url)).toContain(
        "https://openai.com/chatgpt-connectors.json"
      );
    });
  });

  describe("the MCP server's hostname in 0.7.0", () => {
    it("still serves the tools at /mcp", async () => {
      const old = new Client({ name: "worker-test", version: "0.0.0" });
      await old.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", await former.url))
      );

      try {
        const { tools } = await old.listTools();

        expect(tools.map((t) => t.name)).toContain("seo_audit_page");
      } finally {
        await old.close();
      }
    });

    it("sends its pages to the current hostname", async () => {
      const answers = await Promise.all(
        ["/", "/crawler?from=ua"].map(async (path) => {
          const res = await former.fetch(`${FORMER}${path}`, {
            redirect: "manual",
          });

          return [res.status, res.headers.get("location")];
        })
      );

      expect(answers).toStrictEqual([
        [301, `${ORIGIN}/`],
        [301, `${ORIGIN}/crawler?from=ua`],
      ]);
    });
  });

  describe("the website on its own hostname", () => {
    it("serves the homepage, the rules and the files a crawler asks for", async () => {
      const answers = await Promise.all(
        [
          "/",
          "/rules",
          "/robots.txt",
          "/sitemap.xml",
          "/llms.txt",
          "/site.js",
          "/favicon.svg",
          "/og.png",
          "/fonts/geist-latin.woff2",
          "/fonts/geist-mono-latin.woff2",
          "/nope",
        ].map(async (path) => {
          const res = await website.fetch(`${SITE}${path}`);
          await res.arrayBuffer();

          return [path, res.status, res.headers.get("content-type")];
        })
      );

      expect(answers).toStrictEqual([
        ["/", 200, "text/html; charset=utf-8"],
        ["/rules", 200, "text/html; charset=utf-8"],
        ["/robots.txt", 200, "text/plain; charset=utf-8"],
        ["/sitemap.xml", 200, "application/xml; charset=utf-8"],
        ["/llms.txt", 200, "text/markdown; charset=utf-8"],
        ["/site.js", 200, "text/javascript; charset=utf-8"],
        ["/favicon.svg", 200, "image/svg+xml"],
        ["/og.png", 200, "image/png"],
        ["/fonts/geist-latin.woff2", 200, "font/woff2"],
        ["/fonts/geist-mono-latin.woff2", 200, "font/woff2"],
        ["/nope", 404, "text/html; charset=utf-8"],
      ]);
    });

    it("serves its own share image, not the hosted server's", async () => {
      const [ours, theirs] = await Promise.all([
        website.fetch(`${SITE}/og.png`),
        fetch(new URL("/og.png", base)),
      ]);

      const [siteCard, serverCard] = await Promise.all([
        ours.arrayBuffer(),
        theirs.arrayBuffer(),
      ]);

      expect([signatureOf(siteCard), signatureOf(serverCard)]).toStrictEqual([
        PNG_SIGNATURE,
        PNG_SIGNATURE,
      ]);
      expect(Buffer.from(siteCard).equals(Buffer.from(serverCard))).toBeFalsy();
    });

    it("serves the fonts as WOFF2 files that never change, and no MCP endpoint", async () => {
      const font = await website.fetch(`${SITE}/fonts/geist-latin.woff2`);
      const bytes = new Uint8Array(await font.arrayBuffer());
      const mcp = await website.fetch(`${SITE}/mcp`, { method: "POST" });

      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
      expect(font.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable"
      );
      expect(mcp.status).toBe(405);
    });

    it("audits a page for the form and answers with both reports", async () => {
      const before = requests.length;
      const res = await sendForm("shop.example.com/about");
      const page = await res.text();

      // Never cached and never indexed: a report has no address of its own.
      expect([
        res.status,
        res.headers.get("cache-control"),
        res.headers.get("x-robots-tag"),
      ]).toStrictEqual([200, "no-store", "noindex"]);
      expect(page).toContain("About the fixture shop");
      expect(page).toContain("SEO: search engines");
      expect(page).toContain("AEO: AI answer engines");
      expect(requests.slice(before)).toContainEqual({
        url: "https://shop.example.com/about",
        userAgent: `Mozilla/5.0 (compatible; agentic-seo-check/${readVersion()}; +${ORIGIN}/crawler)`,
      });
    });

    it("requests nothing for a link that fills the field, or for GET /audit", async () => {
      const before = requests.length;

      const filled = await website.fetch(
        `${SITE}/?url=https://shop.example.com/about`
      );

      const opened = await website.fetch(`${SITE}/audit`, {
        redirect: "manual",
      });

      await expect(filled.text()).resolves.toContain(
        'value="https://shop.example.com/about"'
      );
      expect(opened.status).toBe(303);
      expect(opened.headers.get("location")).toBe("/");
      expect(requests).toHaveLength(before);
    });

    it("refuses a form without a token Turnstile gave, before any request", async () => {
      const before = requests.length;
      const res = await sendForm("https://shop.example.com/about", "a-bot");

      expect(res.status).toBe(403);
      await expect(res.text()).resolves.toContain(
        "The check that keeps bots out did not pass"
      );
      expect(requests).toHaveLength(before);
    });

    it("refuses a form another site sent", async () => {
      const res = await sendForm(
        "https://shop.example.com/about",
        "a-person",
        "https://elsewhere.example.com"
      );

      expect(res.status).toBe(403);
      await res.text();
    });

    it("refuses an address the hosted server may not request", async () => {
      const before = requests.length;
      const res = await sendForm("http://localhost:8787/");

      expect(res.status).toBe(400);
      await expect(res.text()).resolves.toContain("cannot reach localhost");
      expect(requests).toHaveLength(before);
    });

    it("says a site turned the audit away", async () => {
      const res = await sendForm("https://walled.example.com/");

      expect(res.status).toBe(502);
      await expect(res.text()).resolves.toContain(
        "walled.example.com answered the hosted server with a challenge page"
      );
    });
  });
});
