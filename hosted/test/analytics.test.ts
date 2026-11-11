import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { onCaughtError } from "../../src/core/errors.ts";
import { HOSTED_TOOLS } from "../../src/mcp-hosted.ts";
import { InputError } from "../../src/mcp-shared.ts";
import { createMcpServer } from "../../src/mcp.ts";
import { instrumentTransport } from "../../src/telemetry/mcp.ts";
import {
  hearCaughtError,
  hostedAnalytics,
  inRequest,
  readSessionToken,
  reportError,
  reportTask,
  writeSessionToken,
} from "../src/analytics.ts";
import { callerOf } from "../src/callers.ts";

const POSTHOG = "https://posthog.test";

const Batch = z.object({
  batch: z.array(
    z.object({
      event: z.string(),
      properties: z.record(z.string(), z.unknown()),
    })
  ),
});

/**
 * The events the code under test sends to PostHog, each request's apart, and a context that waits
 * for them. Any other URL answers 404.
 */
const capture = () => {
  const events: z.infer<typeof Batch>["batch"] = [];
  const batches: z.infer<typeof Batch>["batch"][] = [];
  const waiting: Promise<unknown>[] = [];

  vi.stubGlobal(
    "fetch",
    (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) === `${POSTHOG}/batch/`) {
        const { batch } = Batch.parse(JSON.parse(String(init?.body)));

        events.push(...batch);
        batches.push(batch);

        return Promise.resolve(Response.json({ status: 1 }));
      }

      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
  );

  return {
    events,
    batches,
    ctx: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) },
    settled: () => Promise.all(waiting),
  };
};

const SESSION = "ses_01a1cb45-38c0-70bb-8e46-8e0d2e2198ef";

describe("the hosted server's error tracking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a 500's error with its route, never the address it was asked for", async () => {
    const { events, ctx, settled } = capture();

    reportError(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      new TypeError("Cannot render https://shop.example.com/about"),
      "website:/share/:result",
      { handled: false }
    );
    await settled();

    expect(events).toMatchObject([
      {
        event: "$exception",
        properties: {
          surface: "hosted",
          route: "website:/share/:result",
          distinct_id: expect.stringMatching(/^ses_/u),
          $exception_list: [
            {
              type: "TypeError",
              value: "Cannot render <url>",
              mechanism: { handled: false },
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("shop.example.com");
  });

  it("sends nothing while the analytics are off, or for an expected failure", async () => {
    const { events, ctx, settled } = capture();

    reportError({ POSTHOG_HOST: "" }, ctx, new TypeError("x"), "server:/mcp");
    reportError(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      new InputError("Provide `url` or `html`."),
      "server:/mcp"
    );
    await settled();

    expect(events).toStrictEqual([]);
  });

  it("sends a tool's internal error in the call's session", async () => {
    const { events, ctx, settled } = capture();

    const tracking = hostedAnalytics(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      callerOf("203.0.113.5", [])
    );

    tracking?.analytics.toolCall({
      tool: "seo_audit_page",
      startedAt: new Date(),
      durationMs: 12,
      isError: true,
      errorType: "internal",
      error: new RangeError("Invalid time value"),
    });
    await settled();

    const call = events.find((event) => event.event === "$mcp_tool_call");
    const error = events.find((event) => event.event === "$exception");

    expect(call?.properties).not.toHaveProperty("$exception_list");
    expect(error?.properties).toMatchObject({
      route: "server:/mcp",
      $mcp_tool_name: "seo_audit_page",
      platform: "none",
      $session_id: call?.properties.$session_id,
      $exception_list: [{ type: "RangeError", value: "Invalid time value" }],
    });
  });

  it("sends a 500 in the session the request's token names, with its client (issue #93)", async () => {
    const { events, ctx, settled } = capture();

    const token = writeSessionToken({
      session: SESSION,
      client: "claude-ai",
      version: "0.1.0",
      protocol: "2025-11-25",
    });

    void reportError(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      new TypeError("x is not a function"),
      "server:/mcp",
      { handled: false, session: token }
    );
    void reportError(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      new TypeError("y is not a function"),
      "server:/mcp",
      { handled: false, session: "6f9619ff-8b86-d011-b42d-00cf4fc964ff" }
    );
    await settled();

    expect(events.map((event) => event.properties)).toMatchObject([
      {
        $session_id: SESSION,
        distinct_id: SESSION,
        $mcp_client_name: "claude-ai",
        $mcp_client_version: "0.1.0",
        $mcp_protocol_version: "2025-11-25",
      },
      { $session_id: expect.not.stringMatching(SESSION) },
    ]);
    expect(events[1]?.properties).not.toHaveProperty("$mcp_client_name");
  });

  it("sends a call's errors in the call's request, one per bug, with what the call says of its client and options (issue #93)", async () => {
    const { batches, ctx, settled } = capture();

    const tracking = hostedAnalytics(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      callerOf("203.0.113.5", [])
    );

    tracking?.observe({
      tool: "seo_crawl_site",
      outcome: "ok",
      requests: 120,
      pages: 100,
    });
    tracking?.analytics.toolCall({
      tool: "seo_crawl_site",
      startedAt: new Date(),
      durationMs: 41_000,
      isError: false,
      clientName: "claude-code",
      clientVersion: "2.1.0",
      arguments: ["context", "url"],
      intent: "first audit before a redesign",
      properties: {
        target: "url",
        score: 81,
        rules: ["tool.rule-error"],
        format: "json",
        detail: "compact",
        page_detail: "summary",
        recheck: false,
      },
      caught: Array.from({ length: 100 }, () => ({
        error: new RangeError("Invalid time value"),
        rule: "meta.date",
      })),
    });
    await settled();

    expect(batches).toHaveLength(1);

    const [call, error] = batches[0] ?? [];

    expect(batches[0]?.map((event) => event.event)).toStrictEqual([
      "$mcp_tool_call",
      "$exception",
    ]);
    expect(error?.properties).toMatchObject({
      route: "server:/mcp",
      $session_id: call?.properties.$session_id,
      rule: "meta.date",
      occurrences: 100,
      $mcp_tool_name: "seo_crawl_site",
      $mcp_client_name: "claude-code",
      $mcp_client_version: "2.1.0",
      $mcp_duration_ms: 41_000,
      arguments: ["context", "url"],
      target: "url",
      format: "json",
      detail: "compact",
      page_detail: "summary",
      recheck: false,
      platform: "none",
      outcome: "ok",
      requests: 120,
      pages: 100,
      $exception_list: [{ type: "RangeError", mechanism: { handled: true } }],
    });

    for (const name of ["$mcp_intent", "score", "rules"]) {
      expect(error?.properties).not.toHaveProperty(name);
    }
  });

  it("hears an error the core caught within a tool call, and sends it with the call (issue #93)", async () => {
    const { batches, ctx, settled } = capture();

    const tracking = hostedAnalytics(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      callerOf("203.0.113.5", [])
    );

    assert(tracking, "the analytics are on");

    onCaughtError(hearCaughtError);

    const server = createMcpServer({
      hosted: {
        userAgent: "agentic-seo-check-test",
        // A request that cannot be signed: the core fails it, and error tracking hears why.
        sign: () => {
          throw new DOMException(
            "Key usage not permitted",
            "InvalidAccessError"
          );
        },
        // oxlint-disable-next-line eslint/require-await -- the Worker's startCall awaits its limits
        startCall: async () => ({}),
      },
    });

    const client = new Client({ name: "test-client", version: "0.0.0" });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    instrumentTransport(serverTransport, tracking.analytics, HOSTED_TOOLS);
    await client.connect(clientTransport);

    try {
      await client.callTool({
        name: "seo_audit_page",
        arguments: { url: "https://shop.example.com/" },
      });
    } finally {
      onCaughtError(undefined);
      await client.close();
    }

    await settled();

    const batch = batches.find((events) =>
      events.some((event) => event.event === "$mcp_tool_call")
    );

    expect(batch?.map((event) => event.event)).toStrictEqual([
      "$mcp_tool_call",
      "$exception",
    ]);
    expect(batch?.[1]?.properties).toMatchObject({
      task: "request_signature",
      $mcp_tool_name: "seo_audit_page",
      occurrences: expect.any(Number),
      $exception_list: [
        { type: "InvalidAccessError", value: "Key usage not permitted" },
      ],
    });
    expect(JSON.stringify(batches)).not.toContain("shop.example.com");
  });

  it("sends an error the core caught outside a tool call on its own, in the request it was in", async () => {
    const { events, ctx, settled } = capture();

    onCaughtError(hearCaughtError);

    try {
      inRequest(
        { env: { POSTHOG_HOST: POSTHOG }, ctx, route: "server:/mcp" },
        () => {
          hearCaughtError(new RangeError("Invalid time value"), {
            rule: "meta.date",
          });
        }
      );
      // Outside a request, nothing knows where to send it.
      hearCaughtError(new RangeError("Invalid time value"), {});
    } finally {
      onCaughtError(undefined);
    }

    await settled();

    expect(events).toMatchObject([
      {
        event: "$exception",
        properties: {
          route: "server:/mcp",
          rule: "meta.date",
          $exception_list: [{ mechanism: { handled: true } }],
        },
      },
    ]);
  });

  it("sends the failures of the work after an answer with their task, and never throws (issue #93)", async () => {
    const { events, ctx, settled } = capture();
    const report = reportTask({ POSTHOG_HOST: POSTHOG }, ctx, "server:/mcp");

    report(
      new Error("Durable Object reset because its code was updated."),
      "request_count"
    );
    expect(() => {
      // A thrown value that String() cannot read.
      report(Object.create(null), "call_record");
    }).not.toThrow();
    await settled();

    expect(events).toMatchObject([
      {
        properties: {
          route: "server:/mcp",
          task: "request_count",
          $exception_list: [{ mechanism: { handled: true } }],
        },
      },
    ]);
  });
});

/** A token's JSON, in any shape a client might send. */
type Sent = string[] | Record<string, string>;

/** JSON in base64url without padding, as a session token is written. */
const json = (value: Sent): string =>
  btoa(JSON.stringify(value)).replaceAll("=", "");

describe("the hosted server's sessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads back the token it writes, in the characters a session id may have", () => {
    const token = writeSessionToken({
      session: SESSION,
      client: "Anthropic/ClaudeAI ✓",
      version: "1.0.0",
      protocol: "2025-11-25",
    });

    expect(token).toMatch(/^[\w-]+$/u);
    expect(readSessionToken(token)).toStrictEqual({
      session: SESSION,
      client: "Anthropic/ClaudeAI ✓",
      version: "1.0.0",
      protocol: "2025-11-25",
    });
  });

  it("ignores a session id it did not write", () => {
    expect(
      [
        undefined,
        null,
        "",
        "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
        "not base64!",
        "x".repeat(5000),
        json(["a"]),
        json({ session: "ses_1" }),
        json({ session: SESSION, client: "x".repeat(300) }),
        json({ session: SESSION, protocol: "latest" }),
      ].map((header) => readSessionToken(header))
    ).toStrictEqual(Array.from({ length: 10 }));
  });

  it("starts a session at initialize, which the calls that send its token back share", async () => {
    const { events, ctx, settled } = capture();
    const env = { POSTHOG_HOST: POSTHOG };
    const caller = callerOf("203.0.113.5", []);

    const start = hostedAnalytics(env, ctx, caller);

    start?.analytics.initialize({
      clientName: "claude-code",
      clientVersion: "2.1.0",
      protocolVersion: "2025-11-25",
      vendorClient: "Cowork",
    });

    const token = start?.sessionToken();
    assert(token, "a session token");

    // A later request, with no initialize of its own: only the token names the client.
    const later = hostedAnalytics(env, ctx, caller, token);

    later?.analytics.toolCall({
      tool: "seo_audit_page",
      startedAt: new Date(),
      durationMs: 12,
      isError: false,
      vendorClient: "Cowork",
    });
    await settled();

    const [initialize, call] = events;

    expect(later?.sessionToken()).toBeUndefined();
    expect(initialize?.properties).not.toHaveProperty("$session_id");
    expect(call?.properties).toMatchObject({
      $session_id: initialize?.properties.distinct_id,
      distinct_id: initialize?.properties.distinct_id,
      $mcp_client_name: "claude-code",
      $mcp_client_version: "2.1.0",
      $mcp_protocol_version: "2025-11-25",
      $mcp_vendor_client: "Cowork",
    });
  });
});

describe("the hosted server's tool calls (issue #84)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends what a call found, the arguments it gave and the agent's intent", async () => {
    const { events, ctx, settled } = capture();

    const tracking = hostedAnalytics(
      { POSTHOG_HOST: POSTHOG },
      ctx,
      callerOf("203.0.113.5", [])
    );

    tracking?.observe({
      tool: "seo_crawl_site",
      outcome: "ok",
      requests: 31,
      pages: 25,
    });
    tracking?.analytics.toolCall({
      tool: "seo_crawl_site",
      startedAt: new Date(),
      durationMs: 4200,
      isError: false,
      arguments: ["context", "url"],
      intent: "first audit before a redesign",
      properties: {
        target: "url",
        score: 81,
        errors: 1,
        warnings: 4,
        infos: 7,
        rules: ["meta-description.missing", "site.broken-link"],
        format: "json",
        detail: "compact",
        page_detail: "summary",
        recheck: false,
      },
    });
    tracking?.analytics.toolCall({
      tool: "seo_list_rules",
      startedAt: new Date(),
      durationMs: 1,
      isError: false,
      arguments: [],
      properties: {},
    });
    await settled();

    const [crawl, rules] = events;

    expect(crawl?.properties).toMatchObject({
      $mcp_tool_name: "seo_crawl_site",
      $mcp_intent: "first audit before a redesign",
      $mcp_intent_source: "context_parameter",
      arguments: ["context", "url"],
      target: "url",
      score: 81,
      errors: 1,
      rules: ["meta-description.missing", "site.broken-link"],
      page_detail: "summary",
      recheck: false,
      outcome: "ok",
      requests: 31,
      pages: 25,
      platform: "none",
    });
    expect(rules?.properties).not.toHaveProperty("$mcp_intent");
    expect(rules?.properties).not.toHaveProperty("$mcp_intent_source");
  });
});
