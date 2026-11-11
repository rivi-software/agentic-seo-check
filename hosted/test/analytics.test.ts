import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { InputError } from "../../src/mcp-shared.ts";
import { hostedAnalytics, reportError } from "../src/analytics.ts";
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
