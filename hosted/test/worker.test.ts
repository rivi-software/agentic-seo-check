/**
 * The Workers as Cloudflare runs them: built by Wrangler with the same defines as a deploy, run in
 * workerd, and driven over Streamable HTTP by the SDK's client, as test/mcp.test.ts drives the
 * local server over stdio. The Workers' own requests go to `site`, never to the internet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { unstable_startWorker } from "wrangler";
import { z } from "zod";

import { HOSTED_LIMITS } from "../../src/core/hosted.ts";
import {
  defines,
  readVersion,
  SERVER_CONFIG,
  SITE_CONFIG,
} from "../scripts/defines.ts";

const ORIGIN = "https://mcp.agentic-seo.rivi.software";
const SITE = "https://agentic-seo.rivi.software";
const FORMER = "https://mcp.agentic-seo-check.rivi.software";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Where the Worker sends its analytics in the tests (issue #57): never PostHog itself. */
const POSTHOG = "https://posthog.test";

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
    "https://shop.example.com/away": {
      status: 301,
      headers: { location: "https://elsewhere.example.com/page" },
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

const PostHogBatch = z.object({
  api_key: z.string(),
  batch: z.array(
    z.object({
      event: z.string(),
      timestamp: z.string().optional(),
      properties: z.record(z.string(), z.unknown()),
    })
  ),
});

/** The events the Worker sent to POSTHOG, and the token each came with. */
const events: (z.infer<typeof PostHogBatch>["batch"][number] & {
  token: string;
})[] = [];

/** The events named `name` sent after the first `after` events, once at least one is in. */
const eventsAfter = (after: number, name: string) =>
  vi.waitFor(() => {
    const found = events.slice(after).filter((e) => e.event === name);
    assert(found.length > 0, `an ${name} event`);

    return found;
  });

/** The Web Bot Auth headers of each request the Worker sent, by URL. */
const signatures = new Map<string, Record<string, string | null>>();

/** The eight bytes every PNG file starts with, as hex. */
const PNG_SIGNATURE = "89504e470d0a1a0a";

const signatureOf = (bytes: ArrayBuffer) =>
  Buffer.from(bytes.slice(0, 8)).toString("hex");

/** The keyid of the RFC 9421 test key in .dev.vars: its JWK thumbprint. */
const TEST_KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

type StartedWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

/** The MCP server's Worker. */
let worker: StartedWorker;

/** The website's Worker, which binds the MCP server's Durable Object. */
let website: StartedWorker;

/** The MCP server's Worker again, answering as its hostname in 0.7.0. */
let former: StartedWorker;
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

/** Sends the audit form as a browser does, with Turnstile's token, to `to` (the website). */
const sendForm = (
  url: string,
  token = "a-person",
  origin = SITE,
  to: StartedWorker = website
) =>
  to.fetch(`${SITE}/audit`, {
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
 * Sends `url` to the Worker `to` and reads the answer's body as soon as it comes, as Miniflare
 * wants (vitest.config.ts): the answer, and its body as text.
 */
const fetchRead = async (
  to: StartedWorker,
  url: string,
  init?: Parameters<StartedWorker["fetch"]>[1]
) => {
  const res = await to.fetch(url, init);

  return { res, text: await res.text() };
};

/**
 * Where the MCP server's Worker and the website's find each other, as `wrangler dev` sessions do:
 * the website's Durable Object binding names the MCP server's Worker. Only one Worker of a name may
 * be in a registry.
 */
const newRegistry = () => mkdtempSync(`${tmpdir()}/agentic-seo-check-workers-`);

const registry = newRegistry();

interface StartOptions {
  /** The configuration in hosted/: the MCP server's, or the website's. */
  config?: string;
  /** The dev registry the Worker joins; none by default. */
  registry?: string;
  /** Variables that replace the configuration's. */
  vars?: Record<string, number>;
}

/**
 * Starts the Worker of `config` in workerd, answering as `origin`: Wrangler's dev server gives
 * every request one hostname, whatever address it was sent to.
 */
const start = (
  origin: string,
  { config = SERVER_CONFIG, registry: joins, vars = {} }: StartOptions = {}
) =>
  unstable_startWorker({
    config: new URL(`../${config}`, import.meta.url).pathname,
    build: {
      define: defines(config),
      // The configuration's build command runs in hosted/, as `wrangler` does.
      custom: { workingDirectory: new URL("../", import.meta.url).pathname },
    },
    bindings: {
      POSTHOG_HOST: { type: "plain_text", value: POSTHOG },
      ...Object.fromEntries(
        Object.entries(vars).map(([name, value]) => [
          name,
          { type: "json", value },
        ])
      ),
    },
    dev: {
      origin: { hostname: new URL(origin).hostname, secure: true },
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      persist: false,
      watch: false,
      // Serves /__scheduled, which runs the Cron Trigger.
      testScheduled: true,
      ...(joins ? { registry: joins } : null),
      outboundService: async (request: Request) => {
        // PostHog, which the Worker tells of each tool call: kept apart from the sites' requests.
        if (request.url === `${POSTHOG}/batch/`) {
          const body = PostHogBatch.parse(await request.json());

          events.push(
            ...body.batch.map((event) => ({ ...event, token: body.api_key }))
          );

          return Response.json({ status: 1 });
        }

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
    worker = await start(ORIGIN, { registry });
    website = await start(SITE, { config: SITE_CONFIG, registry });
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
    rmSync(registry, { recursive: true, force: true });
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

    it("tells PostHog of a tool call: the tool and how it went, not the site or the answer", async () => {
      const before = events.length;

      const { result } = await audit("seo_audit_page", {
        url: "https://shop.example.com/about",
      });

      expect(result.isError).toBeFalsy();

      const [event] = await eventsAfter(before, "$mcp_tool_call");
      assert(event, "the call's event");

      expect(event).toMatchObject({
        token: expect.stringMatching(/^phc_/u),
        properties: {
          $mcp_source: "posthog_mcp_analytics",
          $mcp_server_name: "agentic-seo-check",
          $mcp_server_version: readVersion(),
          $mcp_tool_name: "seo_audit_page",
          $mcp_is_error: false,
          $process_person_profile: false,
          surface: "hosted",
          platform: "none",
          outcome: "ok",
          pages: 1,
          requests: expect.any(Number),
          distinct_id: expect.stringMatching(/^ses_[\da-f-]{36}$/u),
          // The User-Agent's product token, never the rest of the header.
          $mcp_client_user_agent: expect.stringMatching(/^[A-Za-z][\w.-]*$/u),
          // From the session's token: the call's own request names no client.
          $mcp_client_name: "worker-test",
          $mcp_client_version: "0.0.0",
        },
      });
      expect(event.properties.requests).toBeGreaterThan(0);
      expect(event.properties.$session_id).toBe(event.properties.distinct_id);
      expect(JSON.stringify(event)).not.toMatch(
        /example\.com|About the fixture/u
      );
    });

    it("tells PostHog of each initialize, and puts the calls that follow in its session", async () => {
      const before = events.length;

      const other = new Client({ name: "analytics-test", version: "1.2.3" });

      const transport = new StreamableHTTPClientTransport(
        new URL("/mcp", base)
      );

      await other.connect(transport);
      await other.callTool({ name: "seo_list_rules", arguments: {} });
      await other.callTool({ name: "seo_list_rules", arguments: {} });
      await other.close();

      const [handshake] = await eventsAfter(before, "$mcp_initialize");

      const calls = await vi.waitFor(async () => {
        const found = await eventsAfter(before, "$mcp_tool_call");
        assert(found.length === 2, "both calls' events");

        return found;
      });

      // The session's token, in the characters the protocol allows a session id.
      expect(transport.sessionId).toMatch(/^[\w-]+$/u);
      expect(handshake?.properties).toMatchObject({
        $mcp_client_name: "analytics-test",
        $mcp_client_version: "1.2.3",
        surface: "hosted",
      });
      // The handshake is in no session of its own; the calls share the one it started.
      expect(handshake?.properties).not.toHaveProperty("$session_id");
      expect(calls.map((call) => call.properties)).toStrictEqual(
        Array.from({ length: 2 }, () =>
          expect.objectContaining({
            $session_id: handshake?.properties.distinct_id,
            $mcp_client_name: "analytics-test",
          })
        )
      );
    });

    it("tells PostHog a call failed and what kind of failure, not its message", async () => {
      const before = events.length;

      const { result } = await audit("seo_audit_page", {
        url: "http://localhost:8787/",
      });

      expect(result.isError).toBeTruthy();

      const [event] = await eventsAfter(before, "$mcp_tool_call");

      expect(event?.properties).toMatchObject({
        $mcp_tool_name: "seo_audit_page",
        $mcp_is_error: true,
        $mcp_error_type: "validation",
      });
      expect(JSON.stringify(event)).not.toContain("localhost");
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
          "/ph.js",
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
        ["/ph.js", 200, "text/javascript; charset=utf-8"],
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
          const { res } = await fetchRead(former, `${FORMER}${path}`, {
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

    it("serves posthog-js as a module that names the project and the host, with a cookie banner it lets PostHog reach", async () => {
      const [script, home] = await Promise.all([
        fetchRead(website, `${SITE}/ph.js`),
        fetchRead(website, `${SITE}/`),
      ]);

      const { text: source } = script;
      const { text: page } = home;

      expect(script.res.headers.get("content-type")).toBe(
        "text/javascript; charset=utf-8"
      );
      expect(source).toMatch(
        /get_explicit_consent_status[\s\S]*\nexport const TOKEN = "phc_\w+";\nexport const API_HOST = "https:\/\/posthog\.test";\n$/u
      );
      expect(source).not.toContain("sourceMappingURL");
      // The footer's Cookie settings, then the banner: both hidden until PostHog has loaded.
      expect(page).toMatch(
        /data-consent-settings hidden[\s\S]*<section class="consent" id="consent"[^>]*hidden>/u
      );
      expect(home.res.headers.get("content-security-policy")).toContain(
        "connect-src 'self' https://eu.i.posthog.com"
      );
    });

    it("serves its own share image, not the hosted server's", async () => {
      const [siteCard, serverCard] = await Promise.all([
        website.fetch(`${SITE}/og.png`).then((res) => res.arrayBuffer()),
        fetch(new URL("/og.png", base)).then((res) => res.arrayBuffer()),
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

      const { res: mcp } = await fetchRead(website, `${SITE}/mcp`, {
        method: "POST",
      });

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

    it("gives a report a share link, whose page stays out of search and whose image is the result's", async () => {
      const res = await sendForm("shop.example.com/about");
      const report = await res.text();
      const link = /data-share-url="(?<url>[^"]+)"/u.exec(report)?.groups?.url;

      assert(link, "the report has a share link");
      expect(link.startsWith(`${SITE}/share/`)).toBeTruthy();

      const page = await website.fetch(link);
      const sharePage = await page.text();
      const image = await website.fetch(`${link}.png`);
      const png = Buffer.from(await image.arrayBuffer());

      expect([
        page.status,
        page.headers.get("x-robots-tag"),
        sharePage.includes(`<meta property="og:image" content="${link}.png">`),
        image.headers.get("content-type"),
        image.headers.get("cache-control"),
      ]).toStrictEqual([
        200,
        "noindex",
        true,
        "image/png",
        "public, max-age=31536000, immutable",
      ]);
      expect([
        png.subarray(0, 8).toString("hex"),
        png.readUInt32BE(16),
        png.readUInt32BE(20),
      ]).toStrictEqual([PNG_SIGNATURE, 1200, 630]);
    });

    it("answers a share link no key signed with the 404 page, and draws no image for it", async () => {
      const forged = `${SITE}/share/${Buffer.from("[1]").toString("base64url")}.${"A".repeat(22)}`;

      const [page, image] = await Promise.all([
        fetchRead(website, forged),
        fetchRead(website, `${forged}.png`),
      ]);

      expect([
        page.res.status,
        image.res.status,
        image.res.headers.get("content-type"),
      ]).toStrictEqual([404, 404, "text/html; charset=utf-8"]);
    });

    it("crawls the site for the form when given its homepage, and streams its progress", async () => {
      const before = requests.length;
      const res = await sendForm("shop.example.com");
      const page = await res.text();
      const sent = requests.slice(before).map((r) => r.url);

      expect([
        res.status,
        res.headers.get("cache-control"),
        res.headers.get("x-robots-tag"),
      ]).toStrictEqual([200, "no-store", "noindex"]);

      // The progress comes first, then the report, then the rest of the page.
      const at = [
        'id="progress"',
        'id="report"',
        'aria-labelledby="loop-title"',
      ].map((part) => page.indexOf(part));

      expect(at.every((index, n) => index > (at[n - 1] ?? 0))).toBeTruthy();
      expect(page).toContain("<code>site.broken-internal-links</code>");
      expect(page).toContain("https://shop.example.com/missing");
      // One crawl for both audits: each page requested once, and llms.txt for the AEO audit.
      expect(
        [
          "https://shop.example.com/",
          "https://shop.example.com/about",
          "https://shop.example.com/llms.txt",
        ].map((url) => sent.filter((u) => u === url).length)
      ).toStrictEqual([1, 1, 1]);
    });

    it("requests nothing for a link that fills the field, or for GET /audit", async () => {
      const before = requests.length;

      const filled = await fetchRead(
        website,
        `${SITE}/?url=https://shop.example.com/about`
      );

      const { res: opened } = await fetchRead(website, `${SITE}/audit`, {
        redirect: "manual",
      });

      expect(filled.text).toContain('value="https://shop.example.com/about"');
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

    it("says a site turned the audit away, before a crawl's answer streams", async () => {
      const res = await sendForm("https://walled.example.com/");
      const page = await res.text();

      expect(res.status).toBe(502);
      expect(page).toContain(
        "walled.example.com answered the hosted server with a challenge page"
      );
      expect(page).not.toContain('id="progress"');
    });

    it("counts a crawl as one of the crawls an address may start in a minute", async () => {
      const answers: [number, string][] = [];

      // Earlier tests crawled already; each crawl here waits for the one before it.
      while (answers.length < 4 && answers.at(-1)?.[0] !== 429) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the limit counts crawls in the order they start
        const res = await sendForm("https://shop.example.com/");
        // oxlint-disable-next-line eslint/no-await-in-loop -- read before the next crawl starts
        answers.push([res.status, await res.text()]);
      }

      const [status, page] = answers.at(-1) ?? [0, ""];

      expect(status).toBe(429);
      expect(page).toContain(
        "This address has started 3 crawls on the hosted server in the last minute"
      );
    });

    it("lets an address audit as many different sites a day as CALLER_SITES says, and those again", async () => {
      // A website of its own, which allows one site a day, beside an MCP server of its own, whose
      // Durable Object has counted no site yet.
      const own = newRegistry();
      const server = await start(ORIGIN, { registry: own });

      const capped = await start(SITE, {
        config: SITE_CONFIG,
        registry: own,
        vars: { CALLER_SITES: 1 },
      });

      try {
        await Promise.all([server.ready, capped.ready]);

        const first = await sendForm(
          "https://shop.example.com/about",
          undefined,
          undefined,
          capped
        );

        const firstPage = await first.text();

        const other = await sendForm(
          "https://elsewhere.example.com/page",
          undefined,
          undefined,
          capped
        );

        const otherPage = await other.text();

        const again = await sendForm(
          "https://www.shop.example.com/about",
          undefined,
          undefined,
          capped
        );

        await again.text();

        const away = await sendForm(
          "https://shop.example.com/away",
          undefined,
          undefined,
          capped
        );

        const awayPage = await away.text();

        // The second site is refused, and a redirect to it; www. names the first site again.
        expect([
          first.status,
          other.status,
          again.status,
          away.status,
        ]).toStrictEqual([200, 429, 200, 502]);
        expect(firstPage).toContain("About the fixture shop");
        expect(otherPage).toContain(
          "This address has audited 1 different site on the hosted server today, its daily limit per caller. Sites it audited today still work; others wait until 00:00 UTC."
        );
        expect(awayPage).toContain(
          "The page led to elsewhere.example.com, another site than the one audited."
        );
        expect(
          requests.some((r) => r.url.includes("elsewhere.example.com/page"))
        ).toBeFalsy();
      } finally {
        await Promise.all([capped.dispose(), server.dispose()]);
        rmSync(own, { recursive: true, force: true });
      }
    });
  });
});
