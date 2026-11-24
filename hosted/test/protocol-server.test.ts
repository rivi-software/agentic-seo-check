import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  JSONRPCResultResponseSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { HOSTED_LIMITS } from "../../src/core/hosted.ts";
import { HOSTED_TOOLS } from "../../src/mcp-hosted.ts";
import { createMcpServer } from "../../src/mcp.ts";
import { mayCallTool, protocolServers } from "../src/protocol-server.ts";

/** The hosted servers the light servers' listing built. */
let built = 0;

const protocolServer = protocolServers((options) => {
  built += 1;

  return createMcpServer(options);
});

const PROTOCOL_HEADERS = { "mcp-protocol-version": LATEST_PROTOCOL_VERSION };

/** A POST to /mcp as a client sends it, with the length a client gives its body. */
/** What a test posts: JSON-RPC, or something else that a client might send. */
type Body = JSONRPCMessage | JSONRPCMessage[] | Record<string, string>;

const post = (body: Body, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);

  return new Request("https://agentic-seo.org/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(text).byteLength),
      ...headers,
    },
    body: text,
  });
};

/** A server's answer to one request, through the transport the Worker gives it (index.ts). */
const answer = async (
  server: Pick<Awaited<ReturnType<typeof protocolServer>>, "connect" | "close">,
  request: Request
) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: HOSTED_LIMITS.maxRequestBytes,
  });

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);

    return {
      status: response.status,
      type: response.headers.get("content-type"),
      body: await response.text(),
    };
  } finally {
    await server.close();
  }
};

/** The hosted server, as a tool call gets it; its tools are never called here. */
const hostedServer = () =>
  createMcpServer({
    hosted: {
      userAgent: "test",
      startCall: () => Promise.reject(new Error("No call in this test.")),
    },
  });

const initialize = (protocolVersion: string, id = 1): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "claude-ai", version: "0.1.0" },
  },
});

describe("the light server for requests without a tool call (issue #211)", () => {
  it("builds the hosted server once for every request it answers", async () => {
    for (const request of [
      post(initialize(LATEST_PROTOCOL_VERSION)),
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, PROTOCOL_HEADERS),
      post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, PROTOCOL_HEADERS),
    ]) {
      // In turn, as requests to one isolate come.
      // oxlint-disable-next-line eslint/no-await-in-loop -- one request after the other
      const { status } = await answer(await protocolServer(), request);
      expect(status).toBe(200);
    }

    expect(built).toBe(1);
  });

  it.each([
    ["initialize", () => post(initialize(LATEST_PROTOCOL_VERSION))],
    ["initialize at an older revision", () => post(initialize("2025-03-26"))],
    ["initialize at a revision it lacks", () => post(initialize("1999-01-01"))],
    [
      "tools/list",
      () =>
        post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, PROTOCOL_HEADERS),
    ],
    [
      "tools/list with a cursor",
      () =>
        post(
          {
            jsonrpc: "2.0",
            id: "a",
            method: "tools/list",
            params: { cursor: "x" },
          },
          PROTOCOL_HEADERS
        ),
    ],
    [
      "ping",
      () => post({ jsonrpc: "2.0", id: 8, method: "ping" }, PROTOCOL_HEADERS),
    ],
    [
      "notifications/initialized",
      () =>
        post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          PROTOCOL_HEADERS
        ),
    ],
    [
      "a method the server lacks",
      () =>
        post(
          { jsonrpc: "2.0", id: 9, method: "resources/list" },
          PROTOCOL_HEADERS
        ),
    ],
  ])("answers %s byte for byte as the hosted server", async (_, request) => {
    const light = await answer(await protocolServer(), request());
    const hosted = await answer(hostedServer(), request());

    expect(light).toStrictEqual(hosted);
  });

  it("lists every hosted tool", async () => {
    const { body } = await answer(
      await protocolServer(),
      post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, PROTOCOL_HEADERS)
    );

    const { result } = JSONRPCResultResponseSchema.parse(JSON.parse(body));

    expect(
      ListToolsResultSchema.parse(result).tools.map(({ name }) => name)
    ).toStrictEqual([...HOSTED_TOOLS.keys()]);
  });
});

describe("which requests go to the hosted server", () => {
  const call: JSONRPCMessage = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "seo_list_rules", arguments: {} },
  };

  it.each([
    ["a tool call", post(call), true],
    [
      "a batch with a tool call",
      post([{ jsonrpc: "2.0", method: "notifications/initialized" }, call]),
      true,
    ],
    ["initialize", post(initialize(LATEST_PROTOCOL_VERSION)), false],
    [
      "tools/list",
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      false,
    ],
    [
      "a notification",
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      false,
    ],
    ["a body that is no JSON-RPC", post({ hello: "world" }), true],
    [
      "a body over the cap",
      post(initialize(LATEST_PROTOCOL_VERSION), {
        "content-length": String(HOSTED_LIMITS.maxRequestBytes + 1),
      }),
      true,
    ],
    [
      "a body without a length",
      new Request("https://agentic-seo.org/mcp", {
        method: "POST",
        body: JSON.stringify(initialize(LATEST_PROTOCOL_VERSION)),
      }),
      true,
    ],
  ])("%s: %s", async (_, request, expected) => {
    await expect(mayCallTool(request)).resolves.toBe(expected);
    // The transport still reads the body.
    expect(request.bodyUsed).toBeFalsy();
  });
});
