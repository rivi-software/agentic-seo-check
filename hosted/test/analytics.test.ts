import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { InputError } from "../../src/mcp-shared.ts";
import {
  hostedAnalytics,
  readSessionToken,
  reportError,
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

/** The events the code under test sends to PostHog, and a context that waits for them. */
const capture = () => {
  const events: z.infer<typeof Batch>["batch"] = [];
  const waiting: Promise<unknown>[] = [];

  vi.stubGlobal(
    "fetch",
    (url: string, init: RequestInit): Promise<Response> => {
      if (url === `${POSTHOG}/batch/`) {
        events.push(...Batch.parse(JSON.parse(String(init.body))).batch);
      }

      return Promise.resolve(Response.json({ status: 1 }));
    }
  );

  return {
    events,
    ctx: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) },
    settled: () => Promise.all(waiting),
  };
};

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
      false
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

  const SESSION = "ses_01a1cb45-38c0-70bb-8e46-8e0d2e2198ef";

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
