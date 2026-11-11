/**
 * MCP Analytics (issue #57): one `$mcp_tool_call` event per tool call and one `$mcp_initialize` per
 * `initialize` request, in the shape PostHog's MCP Analytics reads
 * (https://posthog.com/docs/mcp-analytics/installation/other-languages). This module watches a
 * server's transport; the local server (telemetry/local.ts) and the hosted server
 * (hosted/src/analytics.ts) say where the events go. It reads the name of the tool and whether the
 * answer is an error, never the arguments or the answer itself, so nothing a caller sent and
 * nothing a page said reaches an event. A failed call's message stays out too: the messages name
 * the audited URL.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ImplementationSchema,
  InitializeRequestSchema,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  IsomorphicHeaders,
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { MCP_SERVER_NAME } from "../brand.js";
import { VERSION } from "../version.js";
import { BASE_PROPERTIES, short } from "./posthog.js";
import type { PostHogEvent, PropertyValue } from "./posthog.js";

/** Who called, as the request says: the MCP client, the protocol revision, and the HTTP headers. */
export interface McpCaller {
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  /** The User-Agent header, on HTTP. */
  userAgent?: string;
  /** The X-Anthropic-Client header, which tells Claude Code from claude.ai. */
  vendorClient?: string;
}

/**
 * What went wrong in a failed call, from a fixed list, as PostHog's MCP Analytics groups failures:
 * the caller's input, a site's refusal, a limit of the hosted server, or anything else.
 */
export type McpErrorType =
  | "validation"
  | "permission"
  | "rate_limited"
  | "internal";

export interface McpToolCall extends McpCaller {
  tool: string;
  startedAt: Date;
  durationMs: number;
  isError: boolean;
  errorType?: McpErrorType;
}

/** Where a server's calls are reported. Neither may throw into the call it is told about. */
export interface McpAnalytics {
  /** Told once per tool call, when its answer is ready. */
  toolCall: (call: McpToolCall) => void;
  /** Told once per `initialize` request. */
  initialize: (caller: McpCaller) => void;
}

/** What a tool said of its own failure, for the call it answers. */
interface Slot {
  errorType?: McpErrorType;
}

/**
 * The slot of the call a tool is answering. The SDK parses a tool's result into a new object before
 * it sends it, so a mark on the result would not reach the transport; the call's async context
 * does. Node and Workers both have AsyncLocalStorage.
 */
const slots = new AsyncLocalStorage<Slot>();

/**
 * Notes the kind of failure a tool error is, for its call's event; the result is unchanged. Outside
 * a call the transport watches, it notes nothing.
 */
export const withErrorType = <T extends CallToolResult>(
  result: T,
  type: McpErrorType
): T => {
  const slot = slots.getStore();

  if (slot) {
    slot.errorType = type;
  }

  return result;
};

const header = (
  headers: IsomorphicHeaders | undefined,
  name: string
): string | undefined => {
  const value = headers?.[name];

  return short(Array.isArray(value) ? value[0] : value);
};

const ProtocolVersion = z.string();

/** A tool call the server has received and not answered yet. */
interface Pending {
  tool: string;
  startedAt: Date;
  started: number;
  caller: McpCaller;
  slot: Slot;
}

/**
 * Tells `analytics` about the `initialize` requests and the calls to `tools` that `transport`
 * carries. Call it once the server is connected to the transport, which is when the server starts
 * to listen. A call to a tool the server does not have is left out: its name is whatever the
 * caller sent.
 */
export const instrumentTransport = (
  transport: Transport,
  analytics: McpAnalytics,
  tools: ReadonlySet<string>
): void => {
  const receive = transport.onmessage;

  if (!receive) {
    return;
  }

  const send = transport.send.bind(transport);
  const pending = new Map<RequestId, Pending>();

  // The session's client, from its `initialize`: on stdio, one session is the whole connection.
  let session: McpCaller = {};

  /** Notes what `message` asks; a tool call gets the slot its answer runs with. */
  const received = (
    message: JSONRPCMessage,
    extra: MessageExtraInfo | undefined
  ): Slot | undefined => {
    const headers = extra?.requestInfo?.headers;

    const http = {
      userAgent: header(headers, "user-agent"),
      vendorClient: header(headers, "x-anthropic-client"),
    };

    const initialize = InitializeRequestSchema.safeParse(message);

    if (initialize.success) {
      const { clientInfo, protocolVersion } = initialize.data.params;

      session = {
        clientName: short(clientInfo.name),
        clientVersion: short(clientInfo.version),
        protocolVersion: short(protocolVersion),
      };

      analytics.initialize({ ...session, ...http });

      return undefined;
    }

    const call = CallToolRequestSchema.safeParse(message);

    if (
      !isJSONRPCRequest(message) ||
      !call.success ||
      !tools.has(call.data.params.name)
    ) {
      return undefined;
    }

    // Newer revisions of the protocol name the client and the revision in each request.
    const meta = call.data.params._meta;

    const client = ImplementationSchema.safeParse(
      meta?.["io.modelcontextprotocol/clientInfo"]
    ).data;

    const revision =
      ProtocolVersion.safeParse(
        meta?.["io.modelcontextprotocol/protocolVersion"]
      ).data ?? header(headers, "mcp-protocol-version");

    const slot: Slot = {};

    pending.set(message.id, {
      tool: call.data.params.name,
      slot,
      startedAt: new Date(),
      started: performance.now(),
      caller: {
        clientName: short(client?.name) ?? session.clientName,
        clientVersion: short(client?.version) ?? session.clientVersion,
        protocolVersion: short(revision) ?? session.protocolVersion,
        ...http,
      },
    });

    return slot;
  };

  const answered = (message: JSONRPCMessage): void => {
    const result = isJSONRPCResultResponse(message) ? message.result : null;

    if (!result && !isJSONRPCErrorResponse(message)) {
      return;
    }

    const id = "id" in message ? message.id : undefined;
    const call = id === undefined ? undefined : pending.get(id);

    if (id === undefined || !call) {
      return;
    }

    pending.delete(id);

    // A tool error no tool noted is the SDK's answer to arguments the schema refused.
    const isError = result ? result.isError === true : true;

    const errorType = result
      ? (call.slot.errorType ?? "validation")
      : "internal";

    analytics.toolCall({
      tool: call.tool,
      startedAt: call.startedAt,
      durationMs: Math.round(performance.now() - call.started),
      isError,
      errorType: isError ? errorType : undefined,
      ...call.caller,
    });
  };

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- a transport has one onmessage, which the server has set: this wraps it
  transport.onmessage = (message, extra) => {
    let slot: Slot | undefined;

    try {
      slot = received(message, extra);
    } catch {
      // Analytics never cost the caller the answer.
    }

    if (slot) {
      slots.run(slot, () => receive.call(transport, message, extra));
    } else {
      receive.call(transport, message, extra);
    }
  };

  transport.send = async (message, options) => {
    try {
      answered(message);
    } catch {
      // As above.
    }

    await send(message, options);
  };
};

/** Where an event comes from: its session, the server that sends it, and that server's own properties. */
export interface McpEventContext {
  /** `ses_` and a UUIDv7: the session's, or the call's own when the server keeps none. */
  sessionId: string;
  surface: "hosted" | "local";
  properties?: Record<string, PropertyValue | undefined>;
}

const callerProperties = (caller: McpCaller) => ({
  $mcp_client_name: caller.clientName,
  $mcp_client_version: caller.clientVersion,
  $mcp_protocol_version: caller.protocolVersion,
  $mcp_client_user_agent: caller.userAgent,
  $mcp_vendor_client: caller.vendorClient,
});

/** The properties of both events. No person profile: the session is the only id. */
const common = (context: McpEventContext) => ({
  ...BASE_PROPERTIES,
  distinct_id: context.sessionId,
  $session_id: context.sessionId,
  $mcp_source: "posthog_mcp_analytics",
  $mcp_server_name: MCP_SERVER_NAME,
  $mcp_server_version: VERSION,
  surface: context.surface,
});

export const toolCallEvent = (
  call: McpToolCall,
  context: McpEventContext
): PostHogEvent => ({
  event: "$mcp_tool_call",
  timestamp: call.startedAt.toISOString(),
  properties: {
    ...common(context),
    ...callerProperties(call),
    $mcp_tool_name: short(call.tool),
    $mcp_resource_name: short(call.tool),
    $mcp_is_error: call.isError,
    $mcp_duration_ms: call.durationMs,
    $mcp_error_type: call.errorType,
    ...context.properties,
  },
});

export const initializeEvent = (
  caller: McpCaller,
  context: McpEventContext,
  at = new Date()
): PostHogEvent => ({
  event: "$mcp_initialize",
  timestamp: at.toISOString(),
  properties: {
    ...common(context),
    ...callerProperties(caller),
    ...context.properties,
  },
});
