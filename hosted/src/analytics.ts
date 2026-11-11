/**
 * The hosted server's analytics (issue #57): one `$mcp_tool_call` event per tool call and one
 * `$mcp_initialize` per `initialize`, sent to PostHog (EU) once the answer is on its way, with
 * `ctx.waitUntil`. The transport is stateless, so each call is its own session, and nothing that
 * could tie two calls to one person, such as the caller's address, goes into an event. What it
 * says of the caller is the MCP client and the platform the call comes from: claude.ai's or
 * ChatGPT's addresses, or neither. The hostname a call audited stays in Analytics Engine, for abuse
 * reports, and out of PostHog.
 */
import { initializeEvent, toolCallEvent } from "../../src/telemetry/mcp.js";
import type { McpAnalytics, McpEventContext } from "../../src/telemetry/mcp.js";
import { sendEvents, uuidv7 } from "../../src/telemetry/posthog.js";
import type { PostHogEvent } from "../../src/telemetry/posthog.js";
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
}

/** How long an event may take to reach PostHog; the answer has gone by then. */
const SEND_TIMEOUT_MS = 10_000;

/** The analytics of one request to /mcp, or undefined while they are off. */
export const hostedAnalytics = (
  env: AnalyticsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  caller: Caller
): HostedAnalytics | undefined => {
  if (!env.POSTHOG_HOST) {
    return undefined;
  }

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

  const context = (record?: CallRecord): McpEventContext => ({
    sessionId: `ses_${uuidv7()}`,
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
    analytics: {
      initialize: (client) => send(initializeEvent(client, context())),
      toolCall: (call) => {
        const record = records.get(call.tool);
        records.delete(call.tool);

        send(toolCallEvent(call, context(record)));
      },
    },
  };
};
