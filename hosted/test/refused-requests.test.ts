import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMcpServer } from "../../src/mcp.ts";
import { hostedAnalytics } from "../src/analytics.ts";
import { callerOf } from "../src/callers.ts";
import { refusalOf } from "../src/refused-requests.ts";

const POSTHOG = "https://posthog.test";

const LIST_TOOLS = { jsonrpc: "2.0", id: 1, method: "tools/list" };

const INITIALIZE = {
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

/** A POST to /mcp as claude.ai sends one, with the body and headers given. */
const post = (body: string, headers: Record<string, string> = {}): Request =>
  new Request("https://agentic-seo.org/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent":
        "Claude-User (claude-code/2.0; +https://support.anthropic.com/)",
      ...headers,
    },
    body,
  });

/** The transport's answer to a request, set up as the hosted server's is (hosted/src/index.ts). */
const answer = async (request: Request): Promise<Response> => {
  const server = createMcpServer();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
};

const Batch = z.object({
  batch: z.array(
    z.object({
      event: z.string(),
      properties: z.record(z.string(), z.unknown()),
    })
  ),
});

describe("refused MCP requests (issue #210)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "an unsupported protocol version",
      post(JSON.stringify(LIST_TOOLS), {
        "mcp-protocol-version": "2099-01-01",
      }),
      400,
      "protocol_version",
      "2099-01-01",
    ],
    [
      "a body that is no JSON",
      post("{not json"),
      400,
      "invalid_json",
      undefined,
    ],
    [
      "JSON that is no JSON-RPC message",
      post(JSON.stringify({ hello: "world" })),
      400,
      "invalid_message",
      undefined,
    ],
    [
      "a batch with two initialize requests",
      post(
        JSON.stringify([
          { ...INITIALIZE, id: 1 },
          { ...INITIALIZE, id: 2 },
        ])
      ),
      400,
      "batch_initialize",
      undefined,
    ],
    [
      "an Accept header without text/event-stream",
      post(JSON.stringify(LIST_TOOLS), { accept: "application/json" }),
      406,
      "accept",
      undefined,
    ],
    [
      "a body that is not JSON by its Content-Type",
      post(JSON.stringify(LIST_TOOLS), { "content-type": "text/plain" }),
      415,
      "content_type",
      undefined,
    ],
  ])(
    "read the reason of %s",
    async (_name, request, status, reason, protocolVersion) => {
      const response = await answer(request);

      expect(response.status).toBe(status);
      expect(refusalOf(request, status, await response.text())).toStrictEqual({
        status,
        reason,
        userAgent: "Claude-User",
        vendorClient: undefined,
        protocolVersion,
        at: expect.any(Date),
      });
    }
  );

  it("keep a protocol version only in a revision's shape", () => {
    const refusal = refusalOf(
      post("{}", { "mcp-protocol-version": "https://example.com/x" }),
      400,
      JSON.stringify({
        error: { message: "Bad Request: Unsupported protocol version: …" },
      })
    );

    expect(refusal.protocolVersion).toBe("other");
  });

  it("call a message the SDK may add later, or a body that is no error, other", () => {
    const request = post("{}");

    expect(
      refusalOf(request, 400, JSON.stringify({ error: { message: "New: x" } }))
        .reason
    ).toBe("other");
    expect(refusalOf(request, 400, "no").reason).toBe("other");
  });

  it("send a $mcp_request_refused event with no session, and nothing of the body or the address", async () => {
    const events: z.infer<typeof Batch>["batch"] = [];
    const waiting: Promise<unknown>[] = [];

    vi.stubGlobal(
      "fetch",
      (input: string | URL, init?: RequestInit): Promise<Response> => {
        expect(String(input)).toBe(`${POSTHOG}/batch/`);
        events.push(...Batch.parse(JSON.parse(String(init?.body))).batch);

        return Promise.resolve(Response.json({ status: 1 }));
      }
    );

    const tracking = hostedAnalytics(
      { POSTHOG_HOST: POSTHOG },
      { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) },
      callerOf("203.0.113.5", [])
    );

    const request = post('{"secret":"https://shop.example.com/private"}', {
      "mcp-protocol-version": "2099-01-01",
      "x-anthropic-client": "claude-ai/1.0 (web)",
    });

    tracking?.refused(
      refusalOf(
        request,
        400,
        JSON.stringify({
          error: {
            message:
              "Bad Request: Unsupported protocol version: 2099-01-01 (supported versions: 2025-11-25)",
          },
        })
      )
    );
    await Promise.all(waiting);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "$mcp_request_refused",
      properties: {
        $mcp_http_status: 400,
        $mcp_refusal_reason: "protocol_version",
        $mcp_protocol_version: "2099-01-01",
        $mcp_client_name: "claude-ai",
        $mcp_client_name_source: "vendor_client",
        $mcp_client_user_agent: "Claude-User",
        $mcp_interface: "mcp",
        platform: "none",
      },
    });
    // A refused client used nothing, so it counts no session.
    expect(events[0]?.properties).not.toHaveProperty("$session_id");
    expect(JSON.stringify(events)).not.toMatch(/example|secret|203\.0\.113/u);
  });
});
