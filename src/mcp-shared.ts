/** What the local MCP server (mcp.ts) and the hosted one (mcp-hosted.ts) share: options and answers. */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { PRODUCT_NAME, REPOSITORY_URL, WEBSITE_URL } from "./brand.js";
import { compactAeoAudit } from "./core/aeo/audit.js";
import { compactAudit } from "./core/audit.js";
import type { CrawlOptions } from "./core/audit.js";
import { compactComparison, MAX_COMPETITORS } from "./core/compare.js";
import { ExpectedError } from "./core/errors.js";
import { RequestRefusedError } from "./core/fetch.js";
import { FIELD_DATA_PAGES } from "./core/field-data.js";
import { baselineFromIds } from "./core/recheck.js";
import {
  renderAeoMarkdown,
  renderComparisonMarkdown,
  renderMarkdown,
} from "./core/report/markdown.js";
import { ALL_RULES } from "./core/rules/index.js";
import type { AeoAudit, Audit, Comparison } from "./core/types.js";
import { noteCall, withErrorType } from "./telemetry/mcp.js";
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

/**
 * `fieldData` on seo_audit_page and seo_crawl_site (issue #130): the same switch on both servers,
 * whose descriptions say where the API key comes from.
 */
export const fieldDataOption = (key: string) =>
  z
    .boolean()
    .default(false)
    .describe(
      `With \`url\`: also read real-user Core Web Vitals from the Chrome UX Report (LCP, INP, CLS, FCP and TTFB at the 75th percentile, Chrome on phones, the last 28 days), for the URL or, when it has too few visits, its origin; a crawl asks for its first ${FIELD_DATA_PAGES} pages. Adds \`fieldData\` to each page audit and perf.field-* findings with Google's thresholds. A page without a record gets \`fieldData.reason: "no-data"\` and no finding: few visits say nothing against it. ${key}`
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
      'Rule ids or categories to skip, e.g. ["twitter.card-missing"] or ["social"]. Use seo_list_rules to see ids and their categories.'
    ),
  rules: z
    .array(z.string())
    .optional()
    .describe(
      'Run only these rule ids or categories: ["img.alt-missing"] to re-check the findings a fix was for (use with `baseline`), or ["structured-data"] for one category. Use seo_list_rules to see ids and their categories.'
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
      'Extra request headers, e.g. {"Authorization": "Basic ..."} for staging sites. Sent to the origin of the audited URL only: a redirect, a link or a third-party script on another origin does not get them.'
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

export const respondComparison = (
  comparison: Comparison,
  fmt: "json" | "markdown",
  det: "full" | "compact"
) => {
  const report = det === "compact" ? compactComparison(comparison) : comparison;

  const text =
    fmt === "markdown"
      ? renderComparisonMarkdown(report)
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

/**
 * What seo_compare_pages does (issue #129), on both servers; `note` is what the server adds before
 * its documentation.
 */
export const compareDescription = (
  server: "local" | "hosted",
  note = ""
): string =>
  `Compare one page with 1 to ${MAX_COMPETITORS} competitors' pages, such as those that rank for the page's query or that an AI answer cited. Runs the SEO and the AEO audit of each page, reading each site's robots.txt and llms.txt once, and returns each page's two scores and \`signals\` (words, <h2> subheadings, question headings and how many have a direct answer, tables, lists, structured data types, the Article's author and dates, \`keyword\` in the title, H1, description and text, the AI search crawlers and answer bots robots.txt keeps out, llms.txt, response time, and with \`fieldData\` real-user Core Web Vitals). ` +
  `\`gaps\` lists what at least half of the competitors read have and this page lacks, each with the \`rules\` and \`fix\` that close it on this page; the fix is empty when only the author can write what is missing, such as more text or a table. \`leads\` lists where this page is ahead. A gap is no finding: it has no severity and changes no score. ` +
  `This tool does not search for competitors: bring their URLs, from your own web search for the query, from the user, or from the pages an AI answer cited. A competitor that cannot be read is listed in \`pages\` with \`skipped\` and why, and left out of the gaps. For every finding on one page, use seo_audit_page and seo_aeo_audit. ${note}${docsNote(server)}`;

/** `competitors` on both servers: `url` is each server's schema for a URL to request. */
export const competitorsOption = (url: z.ZodString) =>
  z
    .array(url)
    .min(1)
    .max(MAX_COMPETITORS)
    .describe(
      `1 to ${MAX_COMPETITORS} competitors' pages to compare with, as absolute http(s) URLs: pages that rank for the same query, or that an AI answer cited.`
    );

/** `keyword` of seo_compare_pages, which reads it on every page rather than checking one. */
export const COMPARE_KEYWORD =
  "The query the pages compete for. Adds `keywordIn` to each page's signals (in the title, an H1, the meta description, the text), and gaps with the keyword.* rules' fix where the competitors have it and this page lacks it.";

/** `fieldData` of seo_compare_pages; `key` says where the server's API key comes from. */
export const compareFieldDataOption = (key: string) =>
  z
    .boolean()
    .default(false)
    .describe(
      `Also read each page's real-user Core Web Vitals from the Chrome UX Report (the 75th percentile of LCP, INP and CLS, Chrome on phones, the last 28 days, for the URL or its origin): \`coreWebVitals\` in its signals, and a gap, with the perf.field-* rule's fix, where competitors rate better. A page without a record has \`coreWebVitals: null\`. ${key}`
    );

/**
 * The title and annotations of a tool that only reads, spread into its config so the title is
 * written once and the annotations repeat it. All four hints are set: OpenAI's plugin guidelines
 * want `readOnlyHint`, `destructiveHint` and `openWorldHint` as explicit booleans on every tool,
 * and a tool that is safe to retry to say so, which `idempotentHint` does. Reading deletes
 * nothing, and a second call has no further effect, as an HTTP GET is idempotent though the page
 * it returns may change. `openWorld` is whether the tool requests pages on the web, rather than
 * reading files or its own rules.
 */
export const readOnlyTool = (
  title: string,
  { openWorld }: { openWorld: boolean }
) => ({
  title,
  annotations: {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: openWorld,
  } satisfies ToolAnnotations,
});

/** seo_list_rules: the same tool on both servers. */
export const LIST_RULES = {
  ...readOnlyTool("List SEO rules", { openWorld: false }),
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

/**
 * Why a call's arguments cannot work, for its event (issue #123): it names nothing to audit, or for
 * seo_aeo_audit more than one thing (`target`), or the hosted server's address rules turn its URL
 * away (`address`).
 */
export type InputReason = "target" | "address";

/** A tool call whose arguments cannot work: its message tells the caller what to send instead. */
export class InputError extends ExpectedError {
  override name = "InputError";
  declare readonly reason: InputReason | undefined;

  constructor(message: string, options: { reason?: InputReason } = {}) {
    super(message, options);
  }
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
 * failure, and the `reason` of an expected error (issue #123), never the message, which can name
 * the audited URL. An internal failure also hands over the error, for its `$exception` event
 * (issue #60), which cleans the message first.
 */
export const fail = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
  error: unknown,
  type: McpErrorType = errorTypeOf(error)
) => {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof ExpectedError && error.reason !== undefined) {
    noteCall({ reason: error.reason });
  }

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
