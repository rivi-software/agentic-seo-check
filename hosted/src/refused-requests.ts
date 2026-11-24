/**
 * What the analytics hear of an MCP request the SDK's transport refuses before any tool runs
 * (issue #210): a 4xx such as "Unsupported protocol version", which is an answer and not an
 * exception, so neither error tracking nor a tool call's event hears it. Each one is a
 * `$mcp_request_refused` event (analytics.ts), so a client's mistake can be told from the server's.
 */
import { z } from "zod";

import { clientToken, ProtocolVersion } from "../../src/telemetry/mcp.js";
import type { McpRefusedRequest } from "../../src/telemetry/mcp.js";

/**
 * Why the transport refused a request, from the message of its JSON-RPC error. The messages are
 * the SDK's own fixed strings; only the protocol version comes from the client, and it is kept
 * apart, in a revision's shape only. A message the list does not know is `other`.
 */
const REASONS: readonly (readonly [prefix: string, reason: string])[] = [
  ["Bad Request: Unsupported protocol version", "protocol_version"],
  ["Parse error: Invalid JSON-RPC message", "invalid_message"],
  ["Parse error: Invalid JSON", "invalid_json"],
  ["Invalid Request: Batch must not exceed", "batch_size"],
  ["Invalid Request: Only one initialization request", "batch_initialize"],
  ["Not Acceptable", "accept"],
  ["Unsupported Media Type", "content_type"],
  ["Payload Too Large", "body_size"],
  ["Parse error", "parse_error"],
];

/** The body of a JSON-RPC error, as the transport answers a refusal. */
const JsonRpcError = z.object({ error: z.object({ message: z.string() }) });

/** The JSON-RPC error message of a refusal's body, or "" when it is no such error. */
const errorMessage = (body: string): string => {
  try {
    return JsonRpcError.safeParse(JSON.parse(body)).data?.error.message ?? "";
  } catch {
    return "";
  }
};

/** The protocol version a request named: in a revision's shape, `other` when it is not. */
const protocolVersionOf = (value: string | null): string | undefined => {
  if (value === null) {
    return undefined;
  }

  return ProtocolVersion.safeParse(value.trim()).data ?? "other";
};

/**
 * A refused request as its event tells it: the status, the reason, the product tokens of its
 * `User-Agent` and `X-Anthropic-Client` headers, and the protocol version it named. `body` is the
 * transport's answer, read once by the caller, which sends it on. Never the request's body,
 * another header's value, or the caller's address.
 */
export const refusalOf = (
  request: Request,
  status: number,
  body: string
): McpRefusedRequest => {
  const message = errorMessage(body);

  return {
    status,
    reason:
      REASONS.find(([prefix]) => message.startsWith(prefix))?.[1] ?? "other",
    userAgent: clientToken(request.headers.get("user-agent") ?? undefined),
    vendorClient: clientToken(
      request.headers.get("x-anthropic-client") ?? undefined
    ),
    protocolVersion: protocolVersionOf(
      request.headers.get("mcp-protocol-version")
    ),
    at: new Date(),
  };
};
