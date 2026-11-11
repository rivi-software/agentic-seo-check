/** What the local MCP server (mcp.ts) and the hosted one (mcp-hosted.ts) share: options and answers. */
import { z } from "zod";

import { PRODUCT_NAME, REPOSITORY_URL, WEBSITE_URL } from "./brand.js";
import { compactAeoAudit } from "./core/aeo/audit.js";
import { compactAudit } from "./core/audit.js";
import type { CrawlOptions } from "./core/audit.js";
import { ExpectedError } from "./core/errors.js";
import { RequestRefusedError } from "./core/fetch.js";
import { baselineFromIds } from "./core/recheck.js";
import { renderAeoMarkdown, renderMarkdown } from "./core/report/markdown.js";
import { ALL_RULES } from "./core/rules/index.js";
import type { AeoAudit, Audit } from "./core/types.js";
import { withErrorType } from "./telemetry/mcp.js";
import type { McpErrorType } from "./telemetry/mcp.js";

export const format = z
  .enum(["json", "markdown"])
  .default("json")
  .describe(
    "json (default) returns the structured audit; markdown returns a human-readable report."
  );

export const detail = z
  .enum(["full", "compact"])
  .default("compact")
  .describe(
    "compact trims evidence lists and bulky fields to save tokens (default); full returns everything."
  );

export const commonOptions = {
  keyword: z
    .string()
    .optional()
    .describe(
      "Target keyword/phrase. Enables keyword.* checks (title, H1, body, description, URL, density)."
    ),
  includeInfo: z
    .boolean()
    .default(true)
    .describe(
      "Include info-level findings (best practices). Set false to see only errors and warnings."
    ),
  disableRules: z
    .array(z.string())
    .optional()
    .describe(
      'Rule ids to skip, e.g. ["twitter.card-missing"]. Use seo_list_rules to see ids.'
    ),
  rules: z
    .array(z.string())
    .optional()
    .describe(
      'Run only these rule ids, e.g. ["img.alt-missing"] to re-check the findings a fix was for. Use with `baseline`.'
    ),
  baseline: z
    .array(z.string())
    .optional()
    .describe(
      "The `id` of every finding of the earlier audit. The result then has `baseline`: the ids since fixed, still open and new (a new one may be a problem a fix caused). Re-check with the same options; for a crawl or directory, run both audits with pageDetail full so page findings have ids."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .optional()
    .describe("Per-request timeout in milliseconds (default 15000)."),
  userAgent: z.string().optional().describe("Override the User-Agent header."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Extra request headers, e.g. {"Authorization": "Basic ..."} for staging sites.'
    ),
  format,
  detail,
};

export const toOptions = (input: {
  keyword?: string;
  includeInfo?: boolean;
  disableRules?: string[];
  rules?: string[];
  baseline?: string[];
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
}): CrawlOptions => ({
  keyword: input.keyword,
  includeInfo: input.includeInfo,
  disableRules: input.disableRules,
  onlyRules: input.rules,
  baseline: input.baseline ? baselineFromIds(input.baseline) : undefined,
  fetch: {
    timeoutMs: input.timeoutMs,
    userAgent: input.userAgent,
    headers: input.headers,
  },
});

export const respond = (
  audit: Audit,
  fmt: "json" | "markdown",
  det: "full" | "compact"
) => {
  const report = det === "compact" ? compactAudit(audit) : audit;

  const text =
    fmt === "markdown"
      ? renderMarkdown(report)
      : JSON.stringify(report, null, 2);

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ...report },
  };
};

export const respondAeo = (
  audit: AeoAudit,
  fmt: "json" | "markdown",
  det: "full" | "compact"
) => {
  const report = det === "compact" ? compactAeoAudit(audit) : audit;

  const text =
    fmt === "markdown"
      ? renderAeoMarkdown(report)
      : JSON.stringify(report, null, 2);

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { ...report },
  };
};

/**
 * The end of an audit tool's description: where its documentation is. Directory listings ask for
 * it, and an agent that meets a rule id finds what it checks and the search engine's own docs.
 */
export const docsNote = (server: "local" | "hosted"): string =>
  `Documentation: ${REPOSITORY_URL}#${server === "hosted" ? "hosted-server" : "mcp-server"}. Every rule, with the search engine documentation it follows: ${WEBSITE_URL}/rules.`;

/** seo_list_rules: the same tool on both servers. */
export const LIST_RULES = {
  title: "List SEO rules",
  description:
    "List every rule this tool can report, with id, category, typical severity, what it checks and the generic fix. Filter by category or look up one rule id to understand a finding.",
  inputSchema: {
    category: z
      .string()
      .optional()
      .describe(
        "Filter by category (title, meta, headings, canonical, indexing, document, social, images, links, international, structured-data, content, keyword, response, rendering, performance, site, aeo)."
      ),
    rule: z.string().optional().describe("Return only this rule id."),
  },
  annotations: {
    title: "List SEO rules",
    readOnlyHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
};

export const listRules = (input: { category?: string; rule?: string }) => {
  const rules = ALL_RULES.filter(
    (r) =>
      (!input.category || r.category === input.category) &&
      (!input.rule || r.id === input.rule)
  );

  const payload = { count: rules.length, rules };

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
};

/** A tool call whose arguments cannot work: its message tells the caller what to send instead. */
export class InputError extends ExpectedError {
  override name = "InputError";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
const errorTypeOf = (error: unknown): McpErrorType => {
  if (error instanceof RequestRefusedError) {
    return "permission";
  }

  // The caller's input, or something else the tool expects and explains, such as a directory that
  // is not there.
  return error instanceof ExpectedError ? "validation" : "internal";
};

/**
 * A tool error with `error`'s message. Its event (telemetry/mcp.ts) gets `type`, the kind of
 * failure, and never the message, which can name the audited URL. An internal failure also hands
 * over the error, for its `$exception` event (issue #60), which cleans the message first.
 */
export const fail = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
  error: unknown,
  type: McpErrorType = errorTypeOf(error)
) => {
  const message = error instanceof Error ? error.message : String(error);

  return withErrorType(
    {
      isError: true,
      content: [
        { type: "text" as const, text: `${PRODUCT_NAME} error: ${message}` },
      ],
    },
    type,
    type === "internal" ? error : undefined
  );
};
