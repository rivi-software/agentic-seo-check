/**
 * MCP Analytics (issue #57): one `$mcp_tool_call` event per tool call and one `$mcp_initialize` per
 * `initialize` request, in the shape PostHog's MCP Analytics reads
 * (https://posthog.com/docs/mcp-analytics/installation/other-languages). This module watches a
 * server's transport; the local server (telemetry/local.ts) and the hosted server
 * (hosted/src/analytics.ts) say where the events go. It reads the name of the tool and whether the
 * answer is an error, never the arguments' values or the answer itself, so nothing a caller sent
 * and nothing a page said reaches an event. A failed call's message stays out too: the messages
 * name the audited URL. The hosted server's tools add what they found and why a call stopped, in
 * counts and fixed lists (`noteCall`), and its events name the arguments a call gave and carry the
 * agent's `context`, cleaned (issue #84).
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
  CallToolRequest,
  CallToolResult,
  IsomorphicHeaders,
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { MCP_SERVER_NAME } from "../brand.js";
import { ALL_RULES } from "../core/rules/index.js";
import { VERSION } from "../version.js";
import { cleanMessage } from "./exceptions.js";
import { BASE_PROPERTIES, short } from "./posthog.js";
import type { PostHogEvent, PropertyValue } from "./posthog.js";

/** Who called, as the request says: the MCP client, the protocol revision, and the HTTP headers. */
export interface McpCaller {
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  /** The product token of the User-Agent header, on HTTP (`clientToken`). */
  userAgent?: string;
  /** The product token of the X-Anthropic-Client header, which tells Claude Code from claude.ai. */
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

/**
 * What a tool adds to its call's event (`noteCall`): counts, and values from fixed lists, such as
 * a score, the rule ids that fired or why the call stopped. Never a URL or anything from a page.
 */
export type CallProperties = Record<string, PropertyValue | undefined>;

export interface McpToolCall extends McpCaller {
  tool: string;
  startedAt: Date;
  durationMs: number;
  isError: boolean;
  errorType?: McpErrorType;
  /**
   * The error behind an internal failure, for its `$exception` event (issue #60, exceptions.ts).
   * `$mcp_tool_call` never carries it.
   */
  error?: unknown;
  /** The names of the arguments the call gave, from the tool's schema, sorted; never their values. */
  arguments?: string[];
  /** The agent's `context` argument, cleaned: what it says the call is for (`$mcp_intent`). */
  intent?: string;
  /** What the tool noted of its call. */
  properties?: CallProperties;
}

/** Where a server's calls are reported. Neither may throw into the call it is told about. */
export interface McpAnalytics {
  /** Told once per tool call, when its answer is ready. */
  toolCall: (call: McpToolCall) => void;
  /** Told once per `initialize` request. */
  initialize: (caller: McpCaller) => void;
}

/** The call a tool is answering, and what the tool said of it and of its own failure. */
interface Slot {
  tool: string;
  errorType?: McpErrorType;
  error?: unknown;
  properties: CallProperties;
}

/**
 * The slot of the call a tool is answering. The SDK parses a tool's result into a new object before
 * it sends it, so a mark on the result would not reach the transport; the call's async context
 * does. Node and Workers both have AsyncLocalStorage.
 */
const slots = new AsyncLocalStorage<Slot>();

/**
 * Notes the kind of failure a tool error is, for its call's event, and the error behind an internal
 * one; the result is unchanged. Outside a call the transport watches, it notes nothing.
 */
export const withErrorType = <T extends CallToolResult>(
  result: T,
  type: McpErrorType,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
  error?: unknown
): T => {
  const slot = slots.getStore();

  if (slot) {
    slot.errorType = type;
    slot.error = error;
  }

  return result;
};

/**
 * Adds `properties` to the event of the call a tool is answering; a later note of the same name
 * wins. Outside a call the transport watches, it notes nothing.
 */
export const noteCall = (properties: CallProperties): void => {
  const slot = slots.getStore();

  if (slot) {
    Object.assign(slot.properties, properties);
  }
};

/** The tool whose call is running here, if any: for an error the core caught within it. */
export const currentTool = (): string | undefined => slots.getStore()?.tool;

const header = (
  headers: IsomorphicHeaders | undefined,
  name: string
): string | undefined => {
  const value = headers?.[name];

  return short(Array.isArray(value) ? value[0] : value);
};

/**
 * The product token at the start of a header such as `claude-user/1.0 (…)`: the client's name.
 * The rest can hold a URL, or be distinctive enough to tie one caller's calls together, so it
 * never reaches an event.
 */
const PRODUCT_TOKEN = /^[A-Za-z][\w.-]{0,63}/u;

export const clientToken = (value: string | undefined): string | undefined =>
  PRODUCT_TOKEN.exec(value?.trim() ?? "")?.[0];

/** A revision of the protocol, such as `2025-11-25`: the only form a client's own value keeps. */
const ProtocolVersion = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/**
 * The tools a server's analytics count, by name. A map also names each tool's arguments: a call's
 * event then lists those it gave, and its `context`, if the tool has one, is the call's intent.
 */
export type CountedTools =
  | ReadonlySet<string>
  | ReadonlyMap<string, ReadonlySet<string>>;

/** The ids of the tool's own rules: an agent names the ones it fixed, and they say nothing of the user. */
const RULE_IDS: ReadonlySet<string> = new Set(ALL_RULES.map((rule) => rule.id));

/** A word shaped as a rule id, such as `meta-description.missing`, which reads as a hostname too. */
const RULE_ID_WORD =
  /(?<![\w.-])[a-z][\da-z-]{0,40}(?:\.[\da-z-]{1,60}){1,3}(?![\w-])/gu;

/**
 * The marks a kept rule id waits behind while the rest is cleaned: characters of the Unicode
 * private use area, which no pattern of `cleanMessage` takes, and which are taken out of the text
 * first, so it cannot write a mark of its own.
 */
const MARK_CHARS = /[\uE000\uE001]/gu;
const MARK = /\uE000(?<index>\d+)\uE001/gu;

/** As long as an intent may be: as an error's message. */
const MAX_INTENT = 300;

/**
 * The agent's `context`, as the event carries it: cleaned as an error message is, so a URL, a
 * path, quoted text, an email, an IP address or a hostname in it never leaves, and cut short. The
 * ids of the tool's own rules stay, though they read as hostnames.
 */
export const intentOf = (context: string): string | undefined => {
  const kept: string[] = [];

  const marked = context
    .replaceAll(MARK_CHARS, "")
    .trim()
    .replaceAll(RULE_ID_WORD, (word) =>
      RULE_IDS.has(word) ? `\uE000${kept.push(word) - 1}\uE001` : word
    );

  const intent = cleanMessage(marked)
    .replaceAll(MARK, (_, index: string) => kept[Number(index)] ?? "")
    // A mark the cut split in two.
    .replaceAll(/[\uE000\uE001]\d*/gu, "");

  if (intent === "") {
    return undefined;
  }

  return intent.length > MAX_INTENT
    ? `${intent.slice(0, MAX_INTENT - 1)}…`
    : intent;
};

/** A call's `context`: only text is read, whatever else a caller sends in its place. */
const ContextArgument = z.string();

/** What a call's request gave: the names of its arguments the tool has, and its intent. */
const givenOf = (
  names: ReadonlySet<string> | undefined,
  given: CallToolRequest["params"]["arguments"]
): Pick<McpToolCall, "arguments" | "intent"> => {
  if (!names) {
    return {};
  }

  return {
    arguments: Object.keys(given ?? {})
      .filter((name) => names.has(name))
      .toSorted(),
    intent: names.has("context")
      ? ContextArgument.transform(intentOf).safeParse(given?.context).data
      : undefined,
  };
};

/** A tool call the server has received and not answered yet. */
interface Pending {
  tool: string;
  startedAt: Date;
  started: number;
  caller: McpCaller;
  given: Pick<McpToolCall, "arguments" | "intent">;
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
  tools: CountedTools
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
      userAgent: clientToken(header(headers, "user-agent")),
      vendorClient: clientToken(header(headers, "x-anthropic-client")),
    };

    const initialize = InitializeRequestSchema.safeParse(message);

    if (initialize.success) {
      const { clientInfo, protocolVersion } = initialize.data.params;

      session = {
        clientName: short(clientInfo.name),
        clientVersion: short(clientInfo.version),
        protocolVersion: ProtocolVersion.safeParse(protocolVersion).data,
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
      ).data ??
      ProtocolVersion.safeParse(header(headers, "mcp-protocol-version")).data;

    const { name, arguments: given } = call.data.params;
    const slot: Slot = { tool: name, properties: {} };

    pending.set(message.id, {
      tool: name,
      slot,
      given: givenOf("get" in tools ? tools.get(name) : undefined, given),
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
      error: isError ? call.slot.error : undefined,
      ...call.given,
      properties: call.slot.properties,
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
  /** `ses_` and a UUIDv7: the session's, or the call's own when nothing names one. */
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
    $session_id: context.sessionId,
    ...callerProperties(call),
    $mcp_tool_name: short(call.tool),
    $mcp_resource_name: short(call.tool),
    $mcp_is_error: call.isError,
    $mcp_duration_ms: call.durationMs,
    $mcp_error_type: call.errorType,
    $mcp_intent: call.intent,
    $mcp_intent_source:
      call.intent === undefined ? undefined : "context_parameter",
    arguments: call.arguments,
    ...call.properties,
    ...context.properties,
  },
});

/**
 * An `initialize`: the session's id is its `distinct_id`, but it has no `$session_id`, so PostHog
 * counts no session from a handshake alone. A client such as claude.ai connects with every chat,
 * and most chats call no tool, so a session counted from handshakes would be one nobody used.
 */
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
