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
 */
import { z } from "zod";

import { exceptionEvent } from "../../src/telemetry/exceptions.js";
import { initializeEvent, toolCallEvent } from "../../src/telemetry/mcp.js";
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
 * route, from a fixed list, never the request's address.
 */
export type ErrorRoute = `${"server" | "website"}:${string}`;

/** An error's event, in `sessionId`'s session, and where it happened. */
const errorEvent = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
  error: unknown,
  sessionId: string,
  handled: boolean,
  properties: Record<string, PropertyValue | undefined>
): PostHogEvent | undefined =>
  exceptionEvent(error, {
    distinctId: sessionId,
    sessionId,
    handled,
    surface: "hosted",
    properties,
  });

/**
 * Sends the `$exception` event of an error the Worker met, with `ctx.waitUntil`, unless the
 * analytics are off or the error is no bug. `handled` is false for the Worker's last resort, the
 * 500.
 */
export const reportError = (
  env: AnalyticsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- as above
  error: unknown,
  route: ErrorRoute,
  handled = true
): void => {
  if (!env.POSTHOG_HOST) {
    return;
  }

  const event = errorEvent(error, `ses_${uuidv7()}`, handled, { route });

  if (event) {
    ctx.waitUntil(
      sendEvents([event], {
        host: env.POSTHOG_HOST,
        timeoutMs: SEND_TIMEOUT_MS,
      })
    );
  }
};

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

  const send = (event: PostHogEvent): void => {
    ctx.waitUntil(
      sendEvents([event], {
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

        send(initializeEvent(client, context(sessionId)));
      },
      toolCall: (call) => {
        const record = records.get(call.tool);
        records.delete(call.tool);

        const where = context(session?.session ?? `ses_${uuidv7()}`, record);
        send(toolCallEvent(withSession(call, session), where));

        // The error behind an internal failure, in the call's session.
        const event =
          call.error === undefined
            ? undefined
            : errorEvent(call.error, where.sessionId, true, {
                route: "server:/mcp",
                $mcp_tool_name: call.tool,
                platform: where.properties?.platform,
              });

        if (event) {
          send(event);
        }
      },
    },
  };
};
