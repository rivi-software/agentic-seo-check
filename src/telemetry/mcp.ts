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
 * agent's `context`, cleaned (issue #84). They also carry the model the agent runs as, the
 * conversation the call is part of, and the tool's description; an agent's feedback is an event
 * of its own, and so is a call to a tool the server does not have (issue #101).
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
import type { CaughtErrorContext } from "../core/errors.js";
import { ALL_RULES } from "../core/rules/index.js";
import { VERSION } from "../version.js";
import { cleanMessage } from "./exceptions.js";
import type { ReportedError } from "./exceptions.js";
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

/**
 * The model a call says it comes from (issue #101): from the client's metadata, which wins, or as
 * the agent wrote it in `llm_model`. Neither is checked: right for comparing models, nothing more.
 */
export interface CallModel {
  id: string;
  source: "client_metadata" | "self_reported";
}

/** What a call's request gave, by the names of the tool's arguments. */
interface Given {
  /** The names of the arguments the call gave that its tool has, sorted; never their values. */
  arguments?: string[];
  /** `arguments`, and `[redacted]` once when the call gave others: PostHog's `$mcp_input_keys`. */
  inputKeys?: string[];
  /** The agent's `context` argument, cleaned: what it says the call is for (`$mcp_intent`). */
  intent?: string;
  model?: CallModel;
  /** The `conversation_id` the call sent back, when it has the shape the server issues. */
  conversationId?: string;
}

export interface McpToolCall extends McpCaller, Given {
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
  /** The description the tool lists. */
  description?: string;
  /** What the tool noted of its call. */
  properties?: CallProperties;
  /** Errors the core caught within the call (`noteCaughtInCall`), sent with its event (issue #85). */
  caught?: CaughtInCall[];
}

/** What an agent told the server's developers with its feedback tool (issue #101), as it wrote it. */
export interface FeedbackReport {
  type: "missing_capability" | "issue" | "praise" | "other";
  summary: string;
  details?: string;
  frictionPoints?: string;
  suggestedImprovement?: string;
  /** The tool the feedback is about. */
  tool?: string;
  sentiment?: "positive" | "neutral" | "negative" | "mixed";
  taskCompleted?: boolean;
}

/** A call to the feedback tool, which is an event of its own rather than a tool call. */
export interface McpFeedback extends McpToolCall {
  report: FeedbackReport;
}

/** A call to a tool the server does not have (issue #101). */
export interface McpUnknownToolCall extends McpCaller {
  /** The name the call asked for, when it has a tool name's shape (`toolNameOf`). */
  tool: string;
  startedAt: Date;
  conversationId?: string;
}

/** An error the core caught and turned into a finding, within a tool call. */
export interface CaughtInCall extends CaughtErrorContext {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
  error: unknown;
}

/**
 * Errors the core caught within a call, as `exceptionEvents` reads them: handled, each with the
 * rule or the task it names.
 */
export const caughtErrors = (
  caught: readonly CaughtInCall[] = []
): ReportedError[] =>
  caught.map(({ error, ...context }) => ({
    error,
    handled: true,
    properties: { ...context },
  }));

/** Where a server's calls are reported. None may throw into the call it is told about. */
export interface McpAnalytics {
  /** Told once per tool call, when its answer is ready. */
  toolCall: (call: McpToolCall) => void;
  /** Told once per `initialize` request. */
  initialize: (caller: McpCaller) => void;
  /**
   * Told of a call whose tool noted feedback (`noteFeedback`), in place of `toolCall`. Without it,
   * such a call is a tool call.
   */
  feedback?: (feedback: McpFeedback) => void;
  /** Told of a call to a tool the server does not have; without it, such a call is left out. */
  unknownTool?: (call: McpUnknownToolCall) => void;
}

/**
 * The call a tool is answering, what the tool said of it and of its own failure, and what the core
 * caught.
 */
interface Slot {
  tool: string;
  errorType?: McpErrorType;
  error?: unknown;
  properties: CallProperties;
  caught: CaughtInCall[];
  conversationId?: string;
  feedback?: FeedbackReport;
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

/**
 * Notes the conversation a tool answered a call in (issue #101), which its event's session is
 * named after. Outside a call the transport watches, it notes nothing.
 */
export const noteConversation = (conversationId: string): void => {
  const slot = slots.getStore();

  if (slot) {
    slot.conversationId = conversationId;
  }
};

/**
 * Notes the feedback an agent sent with the call a tool is answering (issue #101): its event is
 * then the feedback, not a tool call. Outside a call the transport watches, it notes nothing.
 */
export const noteFeedback = (report: FeedbackReport): void => {
  const slot = slots.getStore();

  if (slot) {
    slot.feedback = report;
  }
};

/** The tool whose call is running here, if any: for an error the core caught within it. */
export const currentTool = (): string | undefined => slots.getStore()?.tool;

/** The most caught errors a call keeps for its events: one bug on every page of a crawl is one. */
const MAX_CAUGHT = 1000;

/**
 * Keeps an error the core caught for the event of the call it happened in, so a call's errors go
 * in one request with it (issue #85). False outside a call the transport watches: the caller then
 * sends it on its own.
 */
export const noteCaughtInCall = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
  error: unknown,
  context: CaughtErrorContext
): boolean => {
  const slot = slots.getStore();

  if (!slot) {
    return false;
  }

  if (slot.caught.length < MAX_CAUGHT) {
    slot.caught.push({ ...context, error });
  }

  return true;
};

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

/** A tool a server's analytics count with what its calls gave: its arguments and its description. */
export interface CountedTool {
  arguments: ReadonlySet<string>;
  description?: string;
}

/**
 * The tools a server's analytics count, by name. A map also describes each tool: a call's event
 * then lists the arguments it gave, its `context`, if the tool has one, is the call's intent, and
 * its `llm_model` and `conversation_id` are read too.
 */
export type CountedTools =
  | ReadonlySet<string>
  | ReadonlyMap<string, CountedTool>;

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

/** As long as each text of an agent's feedback may be. */
const MAX_FEEDBACK_TEXT = 1000;

/** How much of a text an agent wrote is read: the patterns run on no more. */
const MAX_AGENT_TEXT_READ = 2000;

/**
 * Text an agent wrote for the analytics, as an event carries it: cleaned as an error message is,
 * so a URL, a path, quoted text, an email, an IP address or a hostname in it never leaves, and cut
 * to `maxLength`. The ids of the tool's own rules stay, though they read as hostnames.
 */
export const agentText = (
  text: string,
  maxLength: number
): string | undefined => {
  const kept: string[] = [];

  const marked = text
    .slice(0, MAX_AGENT_TEXT_READ)
    .replaceAll(MARK_CHARS, "")
    .trim()
    .replaceAll(RULE_ID_WORD, (word) =>
      RULE_IDS.has(word) ? `\uE000${kept.push(word) - 1}\uE001` : word
    );

  const cleaned = cleanMessage(marked, maxLength)
    .replaceAll(MARK, (_, index: string) => kept[Number(index)] ?? "")
    // A mark the cut split in two.
    .replaceAll(/[\uE000\uE001]\d*/gu, "");

  if (cleaned === "") {
    return undefined;
  }

  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength - 1)}…`
    : cleaned;
};

/** The agent's `context`, as the event carries it (`agentText`). */
export const intentOf = (context: string): string | undefined =>
  agentText(context, MAX_INTENT);

/** A text of the agent's feedback, as the event carries it (`agentText`). */
const feedbackText = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : agentText(text, MAX_FEEDBACK_TEXT);

/** A tool's name: what MCP allows, less the dot, so that no hostname has the shape. */
const TOOL_NAME = /^[A-Za-z][\w-]{0,63}$/u;

/**
 * A tool's name as an event keeps it, when a caller wrote it (issue #101): itself in a tool name's
 * shape, and `other` when it is anything else.
 */
export const toolNameOf = (name: string): string =>
  TOOL_NAME.test(name) ? name : "other";

/** The shape of a model's id: letters, digits, `.`, `-`, `_` and `:`, such as `claude-opus-4-8`. */
const MODEL_ID = /^[\dA-Za-z][\w.:-]{0,99}$/u;

/**
 * A model's id as an event keeps it (issue #101): in the shape of one, and without what
 * `cleanMessage` takes out of a text, such as a hostname, so `us.anthropic.claude-…` is dropped too.
 * "unknown", which the argument's description offers, is no model.
 */
export const modelIdOf = (value: string): string | undefined => {
  const id = value.trim();

  return MODEL_ID.test(id) &&
    id.toLowerCase() !== "unknown" &&
    cleanMessage(id) === id
    ? id
    : undefined;
};

/** An argument the analytics read: only text is read, whatever else a caller sends in its place. */
const TextArgument = z.string();

/** Codex names the model in each request's `_meta`, under `x-codex-turn-metadata`. */
const CodexTurn = z.object({ model: TextArgument });

/** The model of a call: the client's metadata wins over what the agent says. */
const modelOf = (
  meta: CallToolRequest["params"]["_meta"],
  given: CallToolRequest["params"]["arguments"]
): CallModel | undefined => {
  const client = CodexTurn.transform(({ model }) => modelIdOf(model)).safeParse(
    meta?.["x-codex-turn-metadata"]
  ).data;

  if (client) {
    return { id: client, source: "client_metadata" };
  }

  const agent = TextArgument.transform(modelIdOf).safeParse(
    given?.llm_model
  ).data;

  return agent ? { id: agent, source: "self_reported" } : undefined;
};

/** The shape of the conversations' ids the hosted server issues (issue #101): a UUIDv7. */
const CONVERSATION_ID =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

/**
 * A conversation's id as a call sent it back, or undefined for anything the server would not have
 * issued. An id an agent makes up, such as `conv-1`, is not one: two callers who guessed alike
 * would share a session.
 */
export const conversationIdOf = (
  value: string | undefined
): string | undefined => {
  if (value === undefined || value.length > 64) {
    return undefined;
  }

  const id = value.trim().toLowerCase();

  return CONVERSATION_ID.test(id) ? id : undefined;
};

/**
 * What a call's request gave, for a tool whose arguments the server's analytics know: the names of
 * its arguments, its intent, its model and its conversation.
 */
const givenOf = (
  tool: CountedTool | undefined,
  params: CallToolRequest["params"]
): Given => {
  if (!tool) {
    return {};
  }

  const names = tool.arguments;
  const given = params.arguments;
  const all = Object.keys(given ?? {});
  const known = all.filter((name) => names.has(name)).toSorted();

  return {
    arguments: known,
    inputKeys: all.length > known.length ? [...known, "[redacted]"] : known,
    intent: names.has("context")
      ? TextArgument.transform(intentOf).safeParse(given?.context).data
      : undefined,
    model: modelOf(params._meta, names.has("llm_model") ? given : undefined),
    conversationId: names.has("conversation_id")
      ? TextArgument.transform(conversationIdOf).safeParse(
          given?.conversation_id
        ).data
      : undefined,
  };
};

/** A tool call the server has received and not answered yet. */
interface Pending {
  tool: string;
  description?: string;
  startedAt: Date;
  started: number;
  caller: McpCaller;
  given: Given;
  slot: Slot;
}

/**
 * Tells `analytics` about the `initialize` requests and the calls to `tools` that `transport`
 * carries. Call it once the server is connected to the transport, which is when the server starts
 * to listen. A call to a tool the server does not have is left out, unless `analytics` hears such
 * calls (`unknownTool`): its name is whatever the caller sent.
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

    if (!isJSONRPCRequest(message) || !call.success) {
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

    const caller: McpCaller = {
      clientName: short(client?.name) ?? session.clientName,
      clientVersion: short(client?.version) ?? session.clientVersion,
      protocolVersion: short(revision) ?? session.protocolVersion,
      ...http,
    };

    const { name } = call.data.params;

    if (!tools.has(name)) {
      analytics.unknownTool?.({
        tool: toolNameOf(name),
        startedAt: new Date(),
        conversationId: TextArgument.transform(conversationIdOf).safeParse(
          call.data.params.arguments?.conversation_id
        ).data,
        ...caller,
      });

      return undefined;
    }

    const counted = "get" in tools ? tools.get(name) : undefined;
    const slot: Slot = { tool: name, properties: {}, caught: [] };

    pending.set(message.id, {
      tool: name,
      description: counted?.description,
      slot,
      given: givenOf(counted, call.data.params),
      startedAt: new Date(),
      started: performance.now(),
      caller,
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

    const told: McpToolCall = {
      tool: call.tool,
      description: call.description,
      startedAt: call.startedAt,
      durationMs: Math.round(performance.now() - call.started),
      isError,
      errorType: isError ? errorType : undefined,
      error: isError ? call.slot.error : undefined,
      ...call.given,
      // The conversation the tool answered in, which is the one the call sent back or a new one.
      conversationId: call.slot.conversationId ?? call.given.conversationId,
      properties: call.slot.properties,
      caught: call.slot.caught.length > 0 ? call.slot.caught : undefined,
      ...call.caller,
    };

    if (call.slot.feedback && analytics.feedback) {
      analytics.feedback({ ...told, report: call.slot.feedback });
    } else {
      analytics.toolCall(told);
    }
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

/** The properties of every event. No person profile: the session is the only id. */
const common = (context: McpEventContext) => ({
  ...BASE_PROPERTIES,
  distinct_id: context.sessionId,
  $mcp_source: "posthog_mcp_analytics",
  $mcp_server_name: MCP_SERVER_NAME,
  $mcp_server_version: VERSION,
  surface: context.surface,
});

/** What a call says of the agent behind it: its model and its conversation (issue #101). */
const agentProperties = (
  call: Pick<McpToolCall, "model" | "conversationId">
) => ({
  $mcp_conversation_id: call.conversationId,
  $mcp_llm_model: call.model?.id,
  $mcp_llm_model_source: call.model?.source,
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
    ...agentProperties(call),
    $mcp_tool_description: call.description,
    $mcp_input_keys: call.inputKeys,
    arguments: call.arguments,
    ...call.properties,
    ...context.properties,
  },
});

/**
 * A call to the feedback tool (issue #101), as PostHog's MCP Analytics reads agent feedback: an
 * event of its own, never a tool call, with each text cleaned as an intent is and the summary and
 * the details as its intent.
 */
export const feedbackEvent = (
  feedback: McpFeedback,
  context: McpEventContext
): PostHogEvent => {
  const { report } = feedback;

  const intent = feedbackText(
    [report.summary, report.details].filter(Boolean).join("\n\n")
  );

  return {
    event: "$mcp_feedback",
    timestamp: feedback.startedAt.toISOString(),
    properties: {
      ...common(context),
      $session_id: context.sessionId,
      ...callerProperties(feedback),
      $mcp_resource_name: short(feedback.tool),
      $mcp_intent: intent,
      $mcp_intent_source:
        intent === undefined ? undefined : "context_parameter",
      ...agentProperties(feedback),
      $mcp_feedback_type: report.type,
      $mcp_feedback_summary: feedbackText(report.summary),
      $mcp_feedback_details: feedbackText(report.details),
      $mcp_feedback_friction_points: feedbackText(report.frictionPoints),
      $mcp_feedback_suggested_improvement: feedbackText(
        report.suggestedImprovement
      ),
      $mcp_feedback_tool:
        report.tool === undefined ? undefined : toolNameOf(report.tool),
      $mcp_feedback_sentiment: report.sentiment,
      $mcp_feedback_task_completed: report.taskCompleted,
      ...context.properties,
    },
  };
};

/** A call to a tool the server does not have (issue #101): the name it asked for, and who asked. */
export const unknownToolEvent = (
  call: McpUnknownToolCall,
  context: McpEventContext
): PostHogEvent => ({
  event: "$mcp_unknown_tool",
  timestamp: call.startedAt.toISOString(),
  properties: {
    ...common(context),
    $session_id: context.sessionId,
    ...callerProperties(call),
    $mcp_tool_name: call.tool,
    $mcp_resource_name: call.tool,
    $mcp_conversation_id: call.conversationId,
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
