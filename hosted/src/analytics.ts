/**
 * The hosted server's analytics (issue #57): one `$mcp_tool_call` event per tool call and one
 * `$mcp_initialize` per `initialize`, sent to PostHog (EU) once the answer is on its way, with
 * `ctx.waitUntil`, and an `$exception` event for each error that may be a bug (issue #60).
 *
 * The transport is stateless, so a request knows nothing of the one before it. A connection's
 * calls share a session all the same, as PostHog's own SDKs do it for a stateless server: the
 * answer to `initialize` carries a session token in `Mcp-Session-Id`, which the client sends back
 * with every request, and the token holds the session's id and the client's name, version and
 * protocol revision. Nothing is kept on the server, and nothing ties one connection to another or
 * to a person, such as the caller's address. A client that sends no token back gets a session per
 * call. What an event says of the caller is the MCP client and the platform the call comes from:
 * claude.ai's or ChatGPT's addresses, or neither. The hostname a call audited stays in Analytics
 * Engine, for abuse reports, and out of PostHog.
 *
 * What a call did comes from the tools (issue #84, src/mcp-hosted.ts): the score, the counts and
 * the rules of its audit, a re-check's result, the options it ran with, why it stopped, the names
 * of the arguments it gave, and the agent's `context`, cleaned, as `$mcp_intent`.
 *
 * Issue #93 lets the Worker hear the errors the core catches (`hearCaughtError`) and the ones its
 * own work after an answer meets (`reportTask`), sends a call's errors in the call's request, one
 * event per bug, and gives each what its call's event says of the client and the options.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { z } from "zod";

import type { CaughtErrorContext } from "../../src/core/errors.js";
import {
  exceptionEvent,
  exceptionEvents,
} from "../../src/telemetry/exceptions.js";
import {
  caughtErrors,
  initializeEvent,
  noteCaughtInCall,
  toolCallEvent,
} from "../../src/telemetry/mcp.js";
import type {
  McpAnalytics,
  McpCaller,
  McpEventContext,
} from "../../src/telemetry/mcp.js";
import { sendEvents, uuidv7 } from "../../src/telemetry/posthog.js";
import type {
  PostHogEvent,
  PropertyValue,
} from "../../src/telemetry/posthog.js";
import type { Caller } from "./callers.js";
import type { CallRecord } from "./limits.js";

/** The Worker's variable the analytics use (wrangler.jsonc). */
export interface AnalyticsEnv {
  /**
   * PostHog's ingestion host. Empty turns the analytics off, on the website as on /mcp: `.dev.vars`
   * empties it for `hosted:dev`, and the tests point it at a host of their own.
   */
  POSTHOG_HOST: string;
}

/** The analytics of one request to /mcp, and how they hear the calls' records. */
export interface HostedAnalytics {
  analytics: McpAnalytics;
  /** Hears each call's record from the limits: `hostedProfile`'s `observe`. */
  observe: (record: CallRecord) => void;
  /**
   * The `Mcp-Session-Id` to answer the request with: the token of the session its `initialize`
   * started, or undefined when it had none.
   */
  sessionToken: () => string | undefined;
}

/** How long an event may take to reach PostHog; the answer has gone by then. */
const SEND_TIMEOUT_MS = 10_000;

/** What a session token holds: the session's id, and the client its `initialize` named. */
const SessionTokenSchema = z.object({
  session: z
    .string()
    .regex(
      /^ses_[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
    ),
  client: z.string().max(256).optional(),
  version: z.string().max(256).optional(),
  protocol: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
});

type SessionToken = z.infer<typeof SessionTokenSchema>;

/** The longest token read back: its three strings at their cap, in base64url, fit well within it. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * A session token as `Mcp-Session-Id` carries it: JSON in base64url, whose characters are the
 * visible ASCII the protocol asks of a session id.
 */
export const writeSessionToken = (token: SessionToken): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(token));

  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/**
 * The session token in a request's `Mcp-Session-Id`, or undefined for anything else. The client
 * can send any value, so a token is only read for the analytics, and one that is not in the shape
 * this server writes is ignored.
 */
export const readSessionToken = (
  header: string | null | undefined
): SessionToken | undefined => {
  if (
    !header ||
    header.length > MAX_TOKEN_LENGTH ||
    !/^[\w-]+$/u.test(header)
  ) {
    return undefined;
  }

  try {
    const binary = atob(header.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);

    return SessionTokenSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes))
    ).data;
  } catch {
    // Not base64 or not JSON: no token.
    return undefined;
  }
};

/**
 * The call with its session's client where its own request names none. A stateless transport
 * hears the `initialize` in another request, so a call names its client only when its `_meta`
 * does.
 */
const withSession = <T extends McpCaller>(
  call: T,
  session: SessionToken | undefined
): T => ({
  ...call,
  ...(call.clientName === undefined &&
    session && {
      clientName: session.client,
      clientVersion: session.version,
    }),
  protocolVersion: call.protocolVersion ?? session?.protocol,
});

/**
 * Where in the Worker an error happened: the hostname's part (`server` or `website`) and the
 * route, from a fixed list, never the request's address. `server:cron` is the Cron Trigger.
 */
export type ErrorRoute = `${"server" | "website"}:${string}`;

/**
 * What the Worker was doing after an answer, or apart from one, when an error came (issue #93):
 * counting the day's requests, keeping a call's record, reading OpenAI's ranges, reading the
 * signing keys, or signing a request.
 */
export type ErrorTask =
  | "request_count"
  | "call_record"
  | "openai_ranges"
  | "signing_keys"
  | "request_signature";

/** Hears an error of `task`, for its event; it never throws. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
export type ReportTask = (error: unknown, task: ErrorTask) => void;

/** How `reportError` sends an error. */
export interface ReportOptions {
  /** False for the Worker's last resort, the 500. */
  handled?: boolean;
  /**
   * The request's `Mcp-Session-Id`: the error then sits in the session its token names, with the
   * client it names. Any other value gives the error a session of its own.
   */
  session?: string | null;
  properties?: Record<string, PropertyValue | undefined>;
}

/**
 * Sends the `$exception` event of an error the Worker met, with `ctx.waitUntil`, unless the
 * analytics are off or the error is no bug. Resolves once it is sent, or false when nothing was,
 * for a Cron Trigger that fails after it.
 */
export const reportError = (
  env: AnalyticsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
  error: unknown,
  route: ErrorRoute,
  { handled = true, session, properties }: ReportOptions = {}
): Promise<boolean> => {
  if (!env.POSTHOG_HOST) {
    return Promise.resolve(false);
  }

  const token = readSessionToken(session);
  const sessionId = token?.session ?? `ses_${uuidv7()}`;

  const event = exceptionEvent(error, {
    distinctId: sessionId,
    sessionId,
    handled,
    surface: "hosted",
    properties: {
      route,
      $mcp_client_name: token?.client,
      $mcp_client_version: token?.version,
      $mcp_protocol_version: token?.protocol,
      ...properties,
    },
  });

  if (!event) {
    return Promise.resolve(false);
  }

  const sent = sendEvents([event], {
    host: env.POSTHOG_HOST,
    timeoutMs: SEND_TIMEOUT_MS,
  });

  ctx.waitUntil(sent);

  return sent;
};

/** `ReportTask` for the errors of `route`'s work after its answer. */
export const reportTask =
  (
    env: AnalyticsEnv,
    ctx: Pick<ExecutionContext, "waitUntil">,
    route: ErrorRoute
  ): ReportTask =>
  (error, task) => {
    try {
      void reportError(env, ctx, error, route, { properties: { task } });
    } catch {
      // Error tracking never costs the request its answer.
    }
  };

/** The request a Worker is answering, for an error the core catches outside a tool call. */
interface RequestScope {
  env: AnalyticsEnv;
  ctx: Pick<ExecutionContext, "waitUntil">;
  route: ErrorRoute;
}

const requests = new AsyncLocalStorage<RequestScope>();

/** Runs `work`, the answer to a request to `route`, so that the errors it meets know where they were. */
export const inRequest = <T>(scope: RequestScope, work: () => T): T =>
  requests.run(scope, work);

/**
 * Hears an error the core caught and turned into a finding (issue #93): a rule that throws, a page
 * a crawl leaves out, a request it could not sign. Within a tool call, the call's events carry it.
 * Outside one, it is sent on its own, in the request it happened in. A Worker sets it once, with
 * `onCaughtError`.
 */
export const hearCaughtError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
  error: unknown,
  context: CaughtErrorContext
): void => {
  if (noteCaughtInCall(error, context)) {
    return;
  }

  const scope = requests.getStore();

  if (scope) {
    void reportError(scope.env, scope.ctx, error, scope.route, {
      properties: { ...context },
    });
  }
};

/**
 * What a call's `$exception` repeats of its `$mcp_tool_call` (issue #93): the client, the arguments
 * it gave, the options, and how far it got. Not the agent's intent, the one property in free text,
 * nor what the audit found.
 */
const CALL_PROPERTIES = [
  "$mcp_tool_name",
  "$mcp_client_name",
  "$mcp_client_version",
  "$mcp_protocol_version",
  "$mcp_client_user_agent",
  "$mcp_vendor_client",
  "$mcp_duration_ms",
  "arguments",
  "format",
  "detail",
  "page_detail",
  "recheck",
  "target",
  "platform",
  "outcome",
  "requests",
  "pages",
] as const;

const callProperties = (
  event: PostHogEvent
): Record<string, PropertyValue | undefined> =>
  Object.fromEntries(
    CALL_PROPERTIES.map((name) => [name, event.properties[name]])
  );

/**
 * The analytics of one request to /mcp, or undefined while they are off. `sessionHeader` is the
 * request's `Mcp-Session-Id`.
 */
export const hostedAnalytics = (
  env: AnalyticsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  caller: Caller,
  sessionHeader?: string | null
): HostedAnalytics | undefined => {
  if (!env.POSTHOG_HOST) {
    return undefined;
  }

  // The session the client sent back, and the token of the one this request's initialize starts.
  const session = readSessionToken(sessionHeader);
  let started: string | undefined;

  // The last record of each tool. A request carries one call, so the record and the answer that
  // follows it belong together.
  const records = new Map<string, CallRecord>();

  const send = (events: PostHogEvent[]): void => {
    ctx.waitUntil(
      sendEvents(events, {
        host: env.POSTHOG_HOST,
        timeoutMs: SEND_TIMEOUT_MS,
      })
    );
  };

  const context = (
    sessionId: string,
    record?: CallRecord
  ): McpEventContext => ({
    sessionId,
    surface: "hosted",
    properties: {
      platform: caller.platform ?? "none",
      outcome: record?.outcome,
      requests: record?.requests,
      pages: record?.pages,
    },
  });

  return {
    observe: (record) => {
      records.set(record.tool, record);
    },
    sessionToken: () => started,
    analytics: {
      initialize: (client) => {
        const sessionId = `ses_${uuidv7()}`;

        started = writeSessionToken({
          session: sessionId,
          client: client.clientName,
          version: client.clientVersion,
          protocol: client.protocolVersion,
        });

        send([initializeEvent(client, context(sessionId))]);
      },
      toolCall: (call) => {
        const record = records.get(call.tool);
        records.delete(call.tool);

        const where = context(session?.session ?? `ses_${uuidv7()}`, record);
        const event = toolCallEvent(withSession(call, session), where);

        // The error behind an internal failure, then the ones the core caught within the call: one
        // event per bug, in the call's session and the call's request (issue #93). The failure
        // comes first, so the cap on bugs never drops it.
        const errors = [
          ...(call.error === undefined
            ? []
            : [{ error: call.error, handled: true }]),
          ...caughtErrors(call.caught),
        ];

        send([
          event,
          ...exceptionEvents(errors, {
            distinctId: where.sessionId,
            sessionId: where.sessionId,
            surface: "hosted",
            properties: { route: "server:/mcp", ...callProperties(event) },
          }),
        ]);
      },
    },
  };
};
