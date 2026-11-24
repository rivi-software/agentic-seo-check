/**
 * The server for an MCP request that calls no tool (issue #211). Almost every request to /mcp is
 * claude.ai's connector sending `initialize`, `notifications/initialized` and `tools/list`, each
 * time a conversation has it on. Building the hosted server for those registers every tool and
 * turns each input schema into JSON Schema, only to answer what is the same for every caller. So
 * such a request gets the SDK's own `Server` instead, with the info, capabilities and `tools/list`
 * answer that a server `createMcpServer` built gave once per isolate: it answers byte for byte as
 * that server does. A request with a tool call still gets the hosted server, built for its caller.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  InitializeResultSchema,
  isJSONRPCResultResponse,
  JSONRPCMessageSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  InitializeResult,
  JSONRPCMessage,
  JSONRPCRequest,
  ListToolsResult,
  RequestId,
  Result,
} from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { z } from "zod";

import { HOSTED_LIMITS } from "../../src/core/hosted.js";
import type { HostedProfile } from "../../src/mcp.js";
import { createMcpServer } from "../../src/mcp.js";

/** What the hosted server answers to every caller alike. */
interface Listing {
  initialize: InitializeResult;
  tools: ListToolsResult;
}

/**
 * The profile of the server the listing is read from: the free server's, or the premium one's,
 * whose tools list what a subscription adds (issue #230). Nothing calls its tools, so nothing
 * starts a call.
 */
const listingProfile = (premium: boolean): HostedProfile => ({
  ...(premium && { premium: true }),
  userAgent: "",
  startCall: () =>
    Promise.reject(new Error("The listing's server calls no tool.")),
});

/**
 * Asks a server `createMcpServer` built for its `initialize` and `tools/list` answers, as the
 * objects it would send: the light server sends the same objects, so the same bytes.
 */
const readListing = async (
  create: CreateServer,
  premium: boolean
): Promise<Listing> => {
  const server = create({ hosted: listingProfile(premium) });
  const [client, own] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<RequestId, (message: JSONRPCMessage) => void>();

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- a transport has one onmessage, and no events
  client.onmessage = (message) => {
    if ("id" in message && message.id !== undefined) {
      waiting.get(message.id)?.(message);
    }
  };

  const ask = (request: JSONRPCRequest): Promise<JSONRPCMessage> =>
    // oxlint-disable-next-line promise/avoid-new -- the transport hands each answer to a callback
    new Promise((resolve, reject) => {
      waiting.set(request.id, resolve);
      client.send(request).catch(reject);
    });

  await server.connect(own);

  try {
    const [initialize, tools] = await Promise.all([
      ask({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "listing", version: "0" },
        },
      }),
      ask({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ]);

    if (
      !(isJSONRPCResultResponse(initialize) && isInitialize(initialize.result))
    ) {
      throw new Error("The hosted server did not answer initialize.");
    }

    if (!(isJSONRPCResultResponse(tools) && isListing(tools.result))) {
      throw new Error("The hosted server did not answer tools/list.");
    }

    return {
      initialize: initialize.result,
      tools: tools.result,
    };
  } finally {
    await server.close();
  }
};

/**
 * Whether the server's answers are what they should be. The schemas only check them: the light
 * server sends the objects the hosted server answered, whose keys are in the order of its JSON,
 * where a schema's parse would put them in the order of its own.
 */
const isInitialize = (result: Result): result is InitializeResult =>
  InitializeResultSchema.safeParse(result).success;

const isListing = (result: Result): result is ListToolsResult =>
  ListToolsResultSchema.safeParse(result).success;

/**
 * The light server asks the client for nothing (no sampling, no elicitation), so it validates no
 * answer against a schema, and skips building the Ajv instance every `Server` makes by default.
 */
const NO_VALIDATION: jsonSchemaValidator = {
  getValidator: () => () => {
    throw new Error("The protocol server validates nothing.");
  },
};

/** How the hosted server is built: `createMcpServer`, which a test counts. */
type CreateServer = typeof createMcpServer;

/**
 * Makes servers for requests without a tool call: `initialize` and `tools/list` as the hosted
 * server answers them, `ping` and the notifications as the SDK does, and the SDK's error for any
 * other method, which the hosted server lacks too. The listing is read at the first request, once
 * for all that follow (once per isolate, as the Worker keeps one maker), and again after a failure.
 * With `premium`, it is the premium server's listing (issue #230).
 */
export const protocolServers = (
  create: CreateServer = createMcpServer,
  { premium = false }: { premium?: boolean } = {}
): (() => Promise<Server>) => {
  let listing: Promise<Listing> | undefined;

  const listingOnce = async (): Promise<Listing> => {
    listing ??= readListing(create, premium);

    try {
      return await listing;
    } catch (error) {
      listing = undefined;
      throw error;
    }
  };

  return async () => {
    const { initialize, tools } = await listingOnce();

    // `Server` is the SDK's low-level server, deprecated for writing tools: it registers none here.
    const server = new Server(initialize.serverInfo, {
      capabilities: initialize.capabilities,
      instructions: initialize.instructions,
      jsonSchemaValidator: NO_VALIDATION,
    });

    server.setRequestHandler(ListToolsRequestSchema, () => tools);

    return server;
  };
};

/** One JSON-RPC message, or a batch of them, as the transport reads a request's body. */
const MESSAGES = z.union([JSONRPCMessageSchema, z.array(JSONRPCMessageSchema)]);

/**
 * Whether a request to /mcp may call a tool, from its body, read from a copy so the transport
 * still reads the original. Whatever this cannot tell (no length, a body over the cap, not
 * JSON-RPC) goes to the hosted server, which answers it as it always has. Workers hold a body to
 * its Content-Length, so the cap is the copy's too.
 */
export const mayCallTool = async (request: Request): Promise<boolean> => {
  const length = Number(request.headers.get("content-length") ?? Number.NaN);

  if (!(length <= HOSTED_LIMITS.maxRequestBytes)) {
    return true;
  }

  let body: unknown;

  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    return true;
  }

  const parsed = MESSAGES.safeParse(body);

  if (!parsed.success) {
    return true;
  }

  const messages = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

  return messages.some(
    (message) => "method" in message && message.method === "tools/call"
  );
};
