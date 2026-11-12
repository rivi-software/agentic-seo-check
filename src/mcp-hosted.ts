/**
 * The tools of the hosted MCP server (hosted/, issue #35): the local server's names and options,
 * less what cannot work on Cloudflare's network (files on disk, rendering, Lighthouse, a caller's
 * headers or User-Agent, AI bot probes), with every input capped and every request through the
 * hosted gate, which obeys robots.txt (issue #41). Once published, these schemas are a contract of their own.
 * Each call tells its analytics event what it found and why it stopped, in counts and fixed lists
 * (issue #84). Each answer names the conversation it belongs to, and `send_feedback` lets an agent
 * tell the developers what it missed (issue #101).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { PRODUCT_NAME } from "./brand.js";
import { auditAeoHtml, auditAeoSite, auditAeoUrl } from "./core/aeo/audit.js";
import type { AeoOptions } from "./core/aeo/audit.js";
import { auditHtml, auditSite, auditUrl } from "./core/audit.js";
import {
  comparePages,
  competitorCounts,
  competitorsOf,
} from "./core/compare.js";
import { caughtError, ExpectedError } from "./core/errors.js";
import { RequestRefusedError } from "./core/fetch.js";
import type { FetchOptions, RequestGate } from "./core/fetch.js";
import type { FieldDataOptions } from "./core/field-data.js";
import {
  HOSTED_LIMITS,
  hostedFetch,
  hostedUrlProblem,
  LOCAL_SERVER,
} from "./core/hosted.js";
import type { AeoAudit, Audit, Comparison } from "./core/types.js";
import {
  commonOptions,
  COMPARE_KEYWORD,
  compareDescription,
  compareFieldDataOption,
  competitorsOption,
  detail,
  docsNote,
  fail,
  fieldDataOption,
  format,
  InputError,
  LIST_RULES,
  listRules,
  readOnlyTool,
  respond,
  respondAeo,
  respondComparison,
  toOptions,
} from "./mcp-shared.js";
import {
  conversationIdOf,
  noteCall,
  noteConversation,
  noteFeedback,
} from "./telemetry/mcp.js";
import type { CallProperties, CountedTool } from "./telemetry/mcp.js";
import { uuidv7 } from "./telemetry/posthog.js";
import { comparisonReport, runReport } from "./telemetry/report.js";

/** One tool call, as the hosted server's `startCall` is told it. */
export interface HostedCallInfo {
  tool: string;
  /** The call requests a site: a `url` to audit or crawl, not inline HTML or the rule list. */
  fetches: boolean;
  /** The call crawls a site: seo_crawl_site, or seo_aeo_audit with `crawl`. */
  crawl: boolean;
  /** The host of the `url` the call audits, or null. */
  host: string | null;
  /**
   * seo_compare_pages (issue #129): the hosts of the competitors' pages it reads besides `host`,
   * each a site of the day once it is requested.
   */
  competitors?: string[];
}

/** How a hosted tool call ended. */
export interface HostedCallEnd {
  /**
   * ok: it answered with an audit or the rules; refused: the gate or the site refused a request it
   * needed; error: any other tool error.
   */
  outcome: "ok" | "refused" | "error";
  /** Pages the call audited. */
  pages: number;
}

/** A tool call the hosted server let through. */
export interface HostedCall {
  /** The server's limits on this call's requests; the address rules and site refusals come first. */
  gate?: RequestGate;
  /** Told once, when the call's answer is ready. What it throws is reported, and the answer stands. */
  end?: (end: HostedCallEnd) => void;
}

/** What the hosted server (hosted/src/index.ts) adds to the tools. */
export interface HostedProfile {
  /** The User-Agent of every request the tools send; it keeps the agentic-seo-check product token. */
  userAgent: string;
  /** Signs each request the tools send (Web Bot Auth, issue #41); without it they go unsigned. */
  sign?: FetchOptions["sign"];
  /**
   * Starts a tool call. Throws a CallLimitError to refuse it (a limit reached, the server paused),
   * whose message is the tool error the caller gets. Anything else it throws is the server's own
   * failure, such as its Durable Object's (issue #93).
   */
  startCall: (call: HostedCallInfo) => Promise<HostedCall>;
  /**
   * The server's own Chrome UX Report key, and the cache that keeps each answer for a day, for
   * `fieldData` (issue #130). Without it, a call that asks for field data fails and says so.
   */
  fieldData?: FieldDataOptions;
  /**
   * The session that the request's `Mcp-Session-Id` token names, as a UUIDv7 (hosted/src/analytics.ts).
   * A call that sends no conversation back joins it, so a connection's first conversation is its
   * session (issue #101).
   */
  connection?: string;
}

/**
 * Which limit kept a call out, from a fixed list, for its analytics event (issue #84): the server
 * paused or not crawling, a caller's or a platform's calls or crawls a minute, the day's requests,
 * or the different sites a caller or a platform may audit in a day.
 */
export type LimitReason =
  | "paused"
  | "no_crawls"
  | "caller_calls"
  | "caller_crawls"
  | "platform_calls"
  | "platform_crawls"
  | "daily_requests"
  | "caller_sites"
  | "platform_sites";

/**
 * What `HostedProfile.startCall` throws to keep a call out: its message is the caller's answer,
 * and its reason the analytics'.
 */
export class CallLimitError extends ExpectedError {
  override name = "CallLimitError";
  declare readonly reason: LimitReason;

  constructor(message: string, reason: LimitReason) {
    super(message, { reason });
  }
}

const LIMITS = HOSTED_LIMITS;

/** What every hosted tool says it cannot do, and where to go instead. */
const HOSTED_NOTE = `This is the hosted server: it requests pages from Cloudflare's network, so it cannot reach localhost, private networks or sites behind a login, cannot read build directories, does not render JavaScript or run Lighthouse, and limits requests per site and per caller. The local server does all of that: \`${LOCAL_SERVER}\`. The hosted server obeys robots.txt for every request it sends (the group for agentic-seo-check, or \`*\` without one), and its crawls wait between requests as Crawl-delay asks. `;

const description = (schema: z.ZodType): string => schema.description ?? "";

const ruleIds = (base: z.ZodType) =>
  z
    .array(z.string().max(LIMITS.maxRuleIdChars))
    .max(LIMITS.maxRuleIds)
    .optional()
    .describe(description(base));

/** The local server's common options, capped, without `userAgent` and `headers`. */
const hostedOptions = {
  keyword: z
    .string()
    .max(LIMITS.maxKeywordChars)
    .optional()
    .describe(description(commonOptions.keyword)),
  includeInfo: commonOptions.includeInfo,
  disableRules: ruleIds(commonOptions.disableRules),
  rules: ruleIds(commonOptions.rules),
  baseline: z
    .array(z.string().max(LIMITS.maxBaselineIdChars))
    .max(LIMITS.maxBaselineIds)
    .optional()
    .describe(description(commonOptions.baseline)),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(LIMITS.timeoutMs)
    .optional()
    .describe(
      `Per-request timeout in milliseconds (default and most ${LIMITS.timeoutMs}).`
    ),
  format,
  detail,
};

/** What an argument for the analytics alone is read as when it is missing, not text or too long. */
// oxlint-disable-next-line unicorn/no-useless-undefined -- zod's catch takes the value to read instead, and that is none
const none = (): undefined => undefined;

// SAFETY: zod types the value of a catch as its schema's, a string, but no tool reads `context`: the
// transport reads it from the request's own arguments (telemetry/mcp.ts).
const noContext = none as () => never;

/**
 * What the agent says the call is for, for the analytics alone (issues #84 and #101): no tool reads
 * it, and its event carries it cleaned of URLs, hostnames and emails (`intentOf` in
 * telemetry/mcp.ts). `tools/list` shows it as required, as PostHog's own SDK does, since agents
 * leave optional arguments out. A call never fails over it all the same: a value that is missing,
 * not text or too long is read as none. Zod has no type for a key that is required in the schema
 * but not in the input, so the catch claims to give a string (`noContext`).
 */
const context = z
  .string()
  .max(LIMITS.maxContextChars)
  .catch(noContext)
  .describe(
    'A few words on what you are trying to do with this call, such as "re-check the title fixes" or "first audit before a redesign". Recorded, without URLs, hostnames or emails, in the hosted server\'s anonymous usage analytics. Describe people and businesses by role, never by name, and do not quote the user. The audit is the same with or without it.'
  );

/** The model the agent runs as, for the analytics alone (issue #101): a wrong value is read as none. */
const llmModel = z
  .string()
  .max(LIMITS.maxModelChars)
  .optional()
  .catch(none)
  .describe(
    'The model you are running as, such as "claude-opus-4-8" or "gpt-5.2"; "unknown" if you are not sure. Recorded in the hosted server\'s anonymous usage analytics. The audit is the same with or without it.'
  );

/**
 * The conversation the call is part of (issue #101): the id the last answer ended with, which the
 * call's event is in the session of. A wrong value is read as none, and the answer issues a new id.
 */
const conversationId = z
  .string()
  .max(LIMITS.maxConversationIdChars)
  .optional()
  .catch(none)
  .describe(
    "The conversation_id this server returned earlier in this conversation, unchanged, including after later user messages. Omit it if you have none. Recorded in the hosted server's anonymous usage analytics."
  );

/** The arguments every audit tool takes for its analytics alone. */
const agentArguments = {
  context,
  llm_model: llmModel,
  conversation_id: conversationId,
};

const url = z.string().url().max(2048);

const html = z
  .string()
  .max(LIMITS.maxHtmlChars)
  .optional()
  .describe(
    `Raw HTML to audit instead of fetching a URL, up to ${LIMITS.maxHtmlChars.toLocaleString("en")} characters.`
  );

const patterns = (what: string) =>
  z
    .array(z.string().max(LIMITS.maxPatternChars))
    .max(LIMITS.maxPatterns)
    .optional()
    .describe(
      `${what} (at most ${LIMITS.maxPatterns}, of ${LIMITS.maxPatternChars} characters each).`
    );

const crawlLimits = {
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(LIMITS.maxDepth)
    .default(LIMITS.maxDepth)
    .describe(
      `Maximum link depth from the start URL (at most ${LIMITS.maxDepth}).`
    ),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.concurrency)
    .default(LIMITS.concurrency)
    .describe(`Parallel requests (at most ${LIMITS.concurrency}).`),
};

/** `fieldData` on the hosted server: its own key, so the caller needs none. */
const fieldData = fieldDataOption(
  "This server asks with RIVI Software's own key, so you need none, and keeps each answer for a day, as the report changes daily. The URL goes to Google's Chrome UX Report API, never to the site itself; inline `html` is never sent."
);

/** The arguments of seo_audit_page. */
const AUDIT_PAGE_INPUT = {
  url: url.optional().describe("Absolute http(s) URL to fetch and audit."),
  html,
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "With `html`: the URL the HTML would be served at (used to resolve links and classify them as internal/external)."
    ),
  fieldData,
  ...hostedOptions,
  ...agentArguments,
};

/** The arguments of seo_crawl_site. */
const CRAWL_SITE_INPUT = {
  url: url.describe("Start URL (usually the homepage)."),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxPages)
    .default(LIMITS.maxPages)
    .describe(`Maximum pages to fetch (at most ${LIMITS.maxPages}).`),
  ...crawlLimits,
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(0)
    .describe("Delay between requests per worker (politeness)."),
  includeSubdomains: z
    .boolean()
    .default(false)
    .describe("Treat subdomains of the start host as internal."),
  checkExternalLinks: z
    .boolean()
    .default(false)
    .describe(
      `Also probe external link targets for 4xx/5xx (at most ${LIMITS.maxLinkChecks}; slower).`
    ),
  includePatterns: patterns(
    "Only crawl URLs matching one of these regular expressions"
  ),
  excludePatterns: patterns(
    "Skip URLs matching any of these regular expressions"
  ),
  pageDetail: z
    .enum(["summary", "full"])
    .default("summary")
    .describe(
      "summary: per-page scores/counts only (findings are rolled up in `issues`); full: every finding on every page."
    ),
  fieldData,
  ...hostedOptions,
  ...agentArguments,
};

/** The arguments of seo_aeo_audit. */
const AEO_AUDIT_INPUT = {
  url: url
    .optional()
    .describe("Absolute http(s) URL to audit (the start URL with `crawl`)."),
  html: z
    .string()
    .max(LIMITS.maxHtmlChars)
    .optional()
    .describe(
      `Raw HTML to audit instead of fetching a URL, up to ${LIMITS.maxHtmlChars.toLocaleString("en")} characters. Page checks only: there is no site to read robots.txt or llms.txt from.`
    ),
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "With `html`: the origin the HTML is served from (default http://localhost/)."
    ),
  crawl: z
    .boolean()
    .default(false)
    .describe("With `url`: crawl internal links and audit every page."),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxPages)
    .default(LIMITS.maxPages)
    .describe(`Crawl: maximum pages to audit (at most ${LIMITS.maxPages}).`),
  ...crawlLimits,
  includeSubdomains: z
    .boolean()
    .default(false)
    .describe("Crawl: treat subdomains of the start host as internal."),
  pageDetail: z
    .enum(["summary", "full"])
    .default("summary")
    .describe(
      "Crawl: summary keeps page findings rolled up in `issues`; full lists every page finding in `findings`."
    ),
  includeInfo: hostedOptions.includeInfo,
  disableRules: hostedOptions.disableRules,
  rules: hostedOptions.rules,
  baseline: hostedOptions.baseline,
  timeoutMs: hostedOptions.timeoutMs,
  format,
  detail,
  ...agentArguments,
};

/** The arguments of seo_compare_pages (issue #129). */
const COMPARE_PAGES_INPUT = {
  url: url.describe("The page to compare: an absolute, public http(s) URL."),
  competitors: competitorsOption(url),
  keyword: z
    .string()
    .max(LIMITS.maxKeywordChars)
    .optional()
    .describe(COMPARE_KEYWORD),
  fieldData: compareFieldDataOption(
    "This server asks with RIVI Software's own key, so you need none, and keeps each answer for a day. The URLs go to Google's Chrome UX Report API, never to the sites themselves."
  ),
  timeoutMs: hostedOptions.timeoutMs,
  format,
  detail,
  ...agentArguments,
};

/** The arguments of seo_list_rules: the local server's, and those for the analytics. */
const LIST_RULES_INPUT = { ...LIST_RULES.inputSchema, ...agentArguments };

/** The kinds of feedback, as PostHog's MCP Analytics groups them (`$mcp_feedback_type`). */
const FEEDBACK_TYPES = [
  "missing_capability",
  "issue",
  "praise",
  "other",
] as const;

const feedbackText = (what: string) =>
  z.string().max(LIMITS.maxFeedbackChars).optional().describe(what);

/** The arguments of send_feedback, as PostHog's SDK defines the tool (issue #101). */
const FEEDBACK_INPUT = {
  feedback_type: z
    .enum(FEEDBACK_TYPES)
    .describe(
      "What kind of feedback this is. missing_capability: a tool or option you needed does not exist here; nothing failed. issue: a tool failed, returned a confusing error, or its description or schema misled you. praise: something worked notably well. other: anything else."
    ),
  summary: z
    .string()
    .min(1)
    .max(LIMITS.maxFeedbackChars)
    .describe(
      'One self-contained sentence. For missing_capability, the capability you needed, such as "No tool to audit a page behind a login." For issue, the tool and the problem.'
    ),
  details: feedbackText(
    "Optional: what you tried, the options you used and the error you saw."
  ),
  friction_points: feedbackText(
    "Optional: the moments that slowed you down, as short sentences."
  ),
  suggested_improvement: feedbackText(
    "Optional: the change that would have helped, such as a tool or option to add, or a description to reword."
  ),
  tool_name: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Optional: the tool of this server that this feedback is about, for issue or praise. Leave it out for missing_capability."
    ),
  sentiment: z
    .enum(["positive", "neutral", "negative", "mixed"])
    .optional()
    .describe("Optional: how the experience felt overall."),
  task_completed: z
    .boolean()
    .optional()
    .describe("Optional: whether you still completed the user's task."),
  llm_model: llmModel,
  conversation_id: conversationId,
};

/** The page count of an answer, for the record of the call. */
const pagesOf = (audit: Audit | AeoAudit): number =>
  audit.kind === "page" ? 1 : (audit.pages?.length ?? 1);

/** The host of a URL to audit, once the address rules allow it; throws their answer otherwise. */
const allowedHost = (target: string): string => {
  const parsed = new URL(target);
  const problem = hostedUrlProblem(parsed);

  if (problem) {
    throw new InputError(problem, { reason: "address" });
  }

  return parsed.hostname;
};

/** The options a call runs with, for its event: choices from fixed lists, never a value typed in. */
const noteOptions = (
  input: {
    format: "json" | "markdown";
    detail: "full" | "compact";
    baseline?: string[];
  },
  pageDetail?: "summary" | "full"
): void => {
  noteCall({
    format: input.format,
    detail: input.detail,
    page_detail: pageDetail,
    recheck: input.baseline !== undefined,
  });
};

/** What an audit found, for its call's event: the score, the counts, the rules, and a re-check's. */
const auditProperties = (
  audit: Audit | AeoAudit,
  target: "url" | "html"
): CallProperties => {
  const { counts, rules } = runReport(audit);

  return {
    target,
    score: audit.score,
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    rules,
    baseline_fixed: audit.baseline?.fixed.length,
    baseline_open: audit.baseline?.open.length,
    baseline_new: audit.baseline?.new.length,
  };
};

/**
 * What a tool's work gives back: its answer, the pages it audited for the record of the call, and
 * the audit, for the call's event.
 */
interface Answer {
  result: CallToolResult;
  pages: number;
  audit?: Audit | AeoAudit;
  /** What a call that is no audit found, for its event: a comparison's. */
  properties?: CallProperties;
}

/** The answer of a tool's work, or its error as a tool error, and how the call ended. */
const settle = async (
  work: () => Promise<Answer> | Answer
): Promise<{
  result: CallToolResult;
  end: HostedCallEnd;
  audit?: Audit | AeoAudit;
  properties?: CallProperties;
}> => {
  try {
    const { result, pages, audit, properties } = await work();

    return { result, end: { outcome: "ok", pages }, audit, properties };
  } catch (error) {
    return {
      result: fail(error),
      end: {
        outcome: error instanceof RequestRefusedError ? "refused" : "error",
        pages: 0,
      },
    };
  }
};

/**
 * Runs one tool call through the hosted profile: `startCall` may refuse it, every request goes
 * through the hosted gate, and `end` hears how it went, once the answer is ready.
 */
const runCall = async (
  profile: HostedProfile,
  info: HostedCallInfo,
  work: (fetch: FetchOptions) => Promise<Answer> | Answer
): Promise<CallToolResult> => {
  let call: HostedCall;

  try {
    call = await profile.startCall(info);
  } catch (error) {
    // A limit, or the server paused: the server's refusal, not the site's.
    if (error instanceof CallLimitError) {
      return fail(error, "rate_limited");
    }

    // The server could not tell whether the call may start: its own failure, not a limit.
    return fail(error);
  }

  const fetch = hostedFetch({
    userAgent: profile.userAgent,
    sign: profile.sign,
    limits: call.gate,
    crawl: info.crawl,
  });

  // A crawl that a refusal stops partway still answers with the pages it read, so `settle` never
  // sees that refusal: the crawl tells the gate, and the call's event gets its reason.
  const gate: RequestGate | undefined = fetch.gate && {
    ...fetch.gate,
    crawlStopped: (refusal) => noteCall({ reason: refusal.reason }),
  };

  const { result, end, audit, properties } = await settle(() =>
    work({ ...fetch, gate })
  );

  if (audit) {
    noteCall(auditProperties(audit, info.fetches ? "url" : "html"));
  }

  if (properties) {
    noteCall(properties);
  }

  try {
    call.end?.(end);
  } catch (error) {
    // The record of a call is the server's to keep; failing to keep it never costs the caller
    // the answer, and error tracking hears it with the call (issue #93).
    caughtError(error, { task: "call_record" });
  }

  return result;
};

/**
 * A tool's answer, with what its work throws answered as the server's own failure (issue #93). The
 * SDK would answer it with the bare message, and the analytics would read that as arguments the
 * schema refused: the SDK checks the arguments before a tool's callback runs, so what the callback
 * throws is never the caller's. Every hosted tool answers through it, in `inConversation`.
 */
export const guarded = async (
  answer: () => CallToolResult | Promise<CallToolResult>
): Promise<CallToolResult> => {
  try {
    return await answer();
  } catch (error) {
    return fail(error);
  }
};

/**
 * Answers a call in its conversation (issue #101): the one the call sent back, when the server
 * issued it; else the session of the call's connection; else a new one. The answer ends with the
 * conversation's id, as data the agent sends back with its next call, whether the analytics are on
 * or off, so an answer is the same in every deployment, a failure of the server's own included.
 */
const inConversation = async (
  profile: HostedProfile,
  given: string | undefined,
  answer: () => CallToolResult | Promise<CallToolResult>
): Promise<CallToolResult> => {
  const conversation =
    conversationIdOf(given) ?? conversationIdOf(profile.connection) ?? uuidv7();

  noteConversation(conversation);

  const result = await guarded(answer);

  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: JSON.stringify({ conversation_id: conversation }),
      },
    ],
  };
};

/** The options of an audit on the hosted server: the caller's, with the hosted fetch. */
const auditOptions = (
  input: Parameters<typeof toOptions>[0],
  fetch: FetchOptions
) => ({
  ...toOptions(input),
  fetch: { ...fetch, timeoutMs: input.timeoutMs },
});

/**
 * The server's key and cache when the call asks for field data; a server without a key says so
 * before the call counts, rather than audit without what was asked for.
 */
const fieldDataOf = (
  profile: HostedProfile,
  asked: boolean
): FieldDataOptions | undefined => {
  if (!asked) {
    return undefined;
  }

  if (!profile.fieldData) {
    throw new ExpectedError(
      "This server cannot read the Chrome UX Report yet: it has no API key. Leave out `fieldData`, or ask the local server with a key of your own (CRUX_API_KEY).",
      { reason: "field_data" }
    );
  }

  return profile.fieldData;
};

/** seo_audit_page: one page, by URL or as HTML. */
const AUDIT_PAGE = {
  ...readOnlyTool("Audit one page for SEO", { openWorld: true }),
  description:
    `Audit a single page and return prioritised, actionable findings (rule id, severity, message, recommendation, CSS selector, evidence) with a \`fix\` for each: the exact edits that resolve it, quoting the code to replace (\`{{…}}\` marks words the author writes). ` +
    `Checks title, meta description, headings, canonical, robots/noindex, viewport/lang, Open Graph/Twitter cards, images, links, hreflang, structured data (JSON-LD/microdata), content quality and the HTTP response. ` +
    `Provide either \`url\` (a public http(s) URL) or \`html\` (raw HTML string, e.g. from a template or test render). ` +
    `Set \`fieldData: true\` for the Core Web Vitals of real visits (LCP, INP, CLS) from the Chrome UX Report, which Google ranks on. ${
      HOSTED_NOTE
    }Typical workflow: audit, apply the \`fix\` of each error and warning in the source code, then re-check with \`rules\` (the rules you fixed) and \`baseline\` (the finding ids) to confirm they are fixed and nothing new appeared. ${docsNote(
      "hosted"
    )}`,
  inputSchema: AUDIT_PAGE_INPUT,
};

/** seo_crawl_site: a site, up to the hosted crawl's limits. */
const CRAWL_SITE = {
  ...readOnlyTool("Crawl a site and audit every page", { openWorld: true }),
  description:
    `Crawl internal links from a start URL (at most ${LIMITS.maxPages} pages, depth ${LIMITS.maxDepth}), audit every HTML page, and run site-wide checks: robots.txt, XML sitemap coverage (missing/noindex/non-canonical/broken URLs), broken internal links with their sources, redirect chains, duplicate titles/descriptions/H1s/content, orphan and deep pages, soft-404 behaviour, http→https and www redirects, hreflang return links. ` +
    `Returns site findings plus \`issues\` (page findings rolled up by rule with example URLs) and per-page scores. Use seo_audit_page on a specific URL for full per-page detail. ` +
    `The crawl checks at most ${LIMITS.maxLinkChecks} link targets and reads at most ${LIMITS.maxSitemaps} sitemaps. ${
      HOSTED_NOTE
    }${docsNote("hosted")}`,
  inputSchema: CRAWL_SITE_INPUT,
};

/** seo_aeo_audit: a page or a site, for answer engines. */
const AEO_AUDIT = {
  ...readOnlyTool("Audit a page or site for answer engines (AEO)", {
    openWorld: true,
  }),
  description:
    `Answer engine optimization audit: can AI answer engines (ChatGPT search, Claude, Perplexity, Google AI Overviews and AI Mode, Copilot, Gemini) reach, quote and trust the content? ` +
    `Checks robots.txt for each AI crawler (search crawlers, answer bots, training bots), Content-Signal lines and the shared \`__usage_ai-training\` opt-out, /llms.txt, nosnippet/max-snippet/data-nosnippet, Bing's noarchive/nocache for Copilot, noai, content that needs JavaScript, question headings without a direct answer, FAQPage/HowTo markup that the page does not show, article author and dates, and Organization/Person entities with sameAs. ` +
    `Returns its own AEO score, a per-bot \`crawlers\` table and findings with rule ids (aeo.*). ` +
    `Provide one of \`url\` (one page, or a site with \`crawl: true\`) or \`html\`. ${
      HOSTED_NOTE
    }The local server can also request the page with each AI bot's User-Agent (\`aiBots\`). ${docsNote(
      "hosted"
    )}`,
  inputSchema: AEO_AUDIT_INPUT,
};

/** seo_compare_pages: a page beside its competitors' pages (issue #129). */
const COMPARE_PAGES = {
  ...readOnlyTool("Compare a page with competitors' pages", {
    openWorld: true,
  }),
  description: compareDescription(
    "hosted",
    `${HOSTED_NOTE}It obeys each competitor's robots.txt as any page's, and lists a competitor that robots.txt, its site or a limit keeps out with that answer. Each competitor's site counts toward the different sites a caller may audit in a day; a comparison counts as one tool call. `
  ),
  inputSchema: COMPARE_PAGES_INPUT,
};

/** What send_feedback answers: the feedback was kept, and nothing else changed. */
const FEEDBACK_ANSWER = `Your feedback was recorded for the developers of ${PRODUCT_NAME}. It adds or changes no tools: continue with the tools listed.`;

/**
 * send_feedback (issue #101): what an agent tells the developers, as PostHog's SDK defines the
 * tool. It records something, so it is the one tool that does not say it is read-only.
 */
const FEEDBACK = {
  title: "Send feedback to the developers",
  description: `Send feedback about this server to the developers of ${PRODUCT_NAME}: a capability you needed that no tool or option provides, a tool that failed or misled you, or something that worked well. It records the feedback in the hosted server's anonymous usage analytics, without URLs, hostnames or emails, and does not add or change tools. Leave out personal or sensitive details.`,
  inputSchema: FEEDBACK_INPUT,
  annotations: {
    title: "Send feedback to the developers",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

const registerAuditPage = (server: McpServer, profile: HostedProfile): void => {
  server.registerTool("seo_audit_page", AUDIT_PAGE, (input) =>
    inConversation(profile, input.conversation_id, () => {
      noteOptions(input);

      const { html: source, url: target } = input;
      // `html` wins over `url`; an empty `html` counts only when a `url` came with it.
      const inline = source !== undefined && Boolean(source || target);

      if (!inline && !target) {
        // `target` tells the tool's own refusal from the schema's, which has no reason (issue #121).
        return fail(
          new InputError("Provide `url` or `html`.", { reason: "target" })
        );
      }

      let host: string | null = null;
      let field: FieldDataOptions | undefined;

      try {
        host = inline || !target ? null : allowedHost(target);
        // Inline HTML is no URL the Chrome UX Report could have.
        field = fieldDataOf(profile, input.fieldData && host !== null);
      } catch (error) {
        return fail(error);
      }

      return runCall(
        profile,
        { tool: "seo_audit_page", fetches: !inline, crawl: false, host },
        async (fetch) => {
          const options = {
            ...auditOptions(input, fetch),
            baseUrl: input.baseUrl,
            // Inline HTML asks for no key: the audit answers that it has no URL to ask for.
            fieldData: inline ? input.fieldData : field,
          };

          const audit =
            inline || !target
              ? await auditHtml(
                  source ?? "",
                  { url: input.baseUrl, source: "html", target: "inline-html" },
                  options
                )
              : await auditUrl(target, options);

          return {
            result: respond(audit, input.format, input.detail),
            pages: 1,
            audit,
          };
        }
      );
    })
  );
};

const registerCrawlSite = (server: McpServer, profile: HostedProfile): void => {
  server.registerTool("seo_crawl_site", CRAWL_SITE, (input) =>
    inConversation(profile, input.conversation_id, () => {
      noteOptions(input, input.pageDetail);

      let host: string;
      let field: FieldDataOptions | undefined;

      try {
        host = allowedHost(input.url);
        field = fieldDataOf(profile, input.fieldData);
      } catch (error) {
        return fail(error);
      }

      return runCall(
        profile,
        { tool: "seo_crawl_site", fetches: true, crawl: true, host },
        async (fetch) => {
          const audit = await auditSite(input.url, {
            ...auditOptions(input, fetch),
            fieldData: field,
            maxPages: input.maxPages,
            maxDepth: input.maxDepth,
            concurrency: input.concurrency,
            delayMs: input.delayMs,
            respectRobots: true,
            includeSubdomains: input.includeSubdomains,
            checkExternalLinks: input.checkExternalLinks,
            maxLinkChecks: LIMITS.maxLinkChecks,
            includePatterns: input.includePatterns,
            excludePatterns: input.excludePatterns,
            pageDetail: input.pageDetail,
            maxSitemaps: LIMITS.maxSitemaps,
            maxSitemapBytes: LIMITS.maxSitemapBytes,
          });

          return {
            result: respond(audit, input.format, input.detail),
            pages: pagesOf(audit),
            audit,
          };
        }
      );
    })
  );
};

const registerAeoAudit = (server: McpServer, profile: HostedProfile): void => {
  server.registerTool("seo_aeo_audit", AEO_AUDIT, (input) =>
    inConversation(profile, input.conversation_id, () => {
      noteOptions(
        input,
        input.url !== undefined && input.crawl ? input.pageDetail : undefined
      );

      if ((input.url === undefined) === (input.html === undefined)) {
        return fail(
          new InputError("Provide exactly one of `url` or `html`.", {
            reason: "target",
          })
        );
      }

      let host: string | null = null;

      try {
        host = input.url === undefined ? null : allowedHost(input.url);
      } catch (error) {
        return fail(error);
      }

      const crawl = input.url !== undefined && input.crawl;

      return runCall(
        profile,
        { tool: "seo_aeo_audit", fetches: host !== null, crawl, host },
        async (fetch) => {
          const options: AeoOptions = {
            ...auditOptions(input, fetch),
            baseUrl: input.baseUrl,
            maxPages: input.maxPages,
            maxDepth: input.maxDepth,
            concurrency: input.concurrency,
            respectRobots: true,
            includeSubdomains: input.includeSubdomains,
            pageDetail: input.pageDetail,
          };

          let audit: AeoAudit;

          if (input.url === undefined) {
            audit = await auditAeoHtml(
              input.html ?? "",
              { url: input.baseUrl, target: "inline-html" },
              options
            );
          } else if (crawl) {
            audit = await auditAeoSite(input.url, options);
          } else {
            audit = await auditAeoUrl(input.url, options);
          }

          return {
            result: respondAeo(audit, input.format, input.detail),
            pages: pagesOf(audit),
            audit,
          };
        }
      );
    })
  );
};

/**
 * What a comparison found, for its call's event (issue #129): the pages it compared and skipped,
 * its gaps and leads, and the rules whose fix closes a gap.
 */
const comparisonProperties = (comparison: Comparison): CallProperties => {
  const { of, read } = competitorCounts(comparison);

  return {
    target: "url",
    competitors: of,
    skipped: of - read,
    gaps: comparison.gaps.length,
    leads: comparison.leads.length,
    rules: comparisonReport(comparison).rules,
  };
};

const registerComparePages = (
  server: McpServer,
  profile: HostedProfile
): void => {
  server.registerTool("seo_compare_pages", COMPARE_PAGES, (input) =>
    inConversation(profile, input.conversation_id, () => {
      noteOptions(input);

      let host: string;
      let competitors: string[];
      let field: FieldDataOptions | undefined;

      try {
        host = allowedHost(input.url);
        // A list with only the page itself in it fails here, before the call counts.
        competitors = [
          ...new Set(
            competitorsOf(input.url, input.competitors).map(allowedHost)
          ),
        ].filter((h) => h !== host);
        field = fieldDataOf(profile, input.fieldData);
      } catch (error) {
        return fail(error);
      }

      return runCall(
        profile,
        {
          tool: "seo_compare_pages",
          fetches: true,
          crawl: false,
          host,
          competitors,
        },
        async (fetch) => {
          const comparison = await comparePages(input.url, input.competitors, {
            keyword: input.keyword,
            fieldData: field,
            fetch: { ...fetch, timeoutMs: input.timeoutMs },
          });

          return {
            result: respondComparison(comparison, input.format, input.detail),
            pages: comparisonReport(comparison).pages,
            properties: comparisonProperties(comparison),
          };
        }
      );
    })
  );
};

/** seo_list_rules: the local server's tool, with the arguments for the analytics. */
const LIST_RULES_TOOL = { ...LIST_RULES, inputSchema: LIST_RULES_INPUT };

/**
 * The hosted server's tools, with the names of their arguments and their descriptions, for its
 * analytics: a call to any other tool is an unknown tool's event, and a call's event lists only the
 * arguments its tool has (issues #84 and #101).
 */
export const HOSTED_TOOLS: ReadonlyMap<string, CountedTool> = new Map(
  Object.entries({
    seo_audit_page: AUDIT_PAGE,
    seo_crawl_site: CRAWL_SITE,
    seo_aeo_audit: AEO_AUDIT,
    seo_compare_pages: COMPARE_PAGES,
    seo_list_rules: LIST_RULES_TOOL,
    send_feedback: FEEDBACK,
  }).map(([tool, listed]) => [
    tool,
    {
      arguments: new Set(Object.keys(listed.inputSchema)),
      description: listed.description,
    },
  ])
);

/**
 * The tool a feedback names, as its event keeps it: one of this server's, or `other`. The agent
 * writes the name, and a word in a tool name's shape can still name a person or a business.
 */
const knownTool = (name: string): string =>
  HOSTED_TOOLS.has(name) ? name : "other";

/** The hosted server's tools: as the local server's, less what needs the user's machine. */
export const registerHostedTools = (
  server: McpServer,
  profile: HostedProfile
): void => {
  registerAuditPage(server, profile);
  registerCrawlSite(server, profile);
  registerAeoAudit(server, profile);
  registerComparePages(server, profile);

  server.registerTool("seo_list_rules", LIST_RULES_TOOL, (input) =>
    inConversation(profile, input.conversation_id, () =>
      runCall(
        profile,
        { tool: "seo_list_rules", fetches: false, crawl: false, host: null },
        () => ({ result: listRules(input), pages: 0 })
      )
    )
  );

  // Unlike seo_list_rules, it counts against the caller's calls a minute: it sends free text.
  server.registerTool("send_feedback", FEEDBACK, (input) =>
    inConversation(profile, input.conversation_id, () =>
      runCall(
        profile,
        { tool: "send_feedback", fetches: false, crawl: false, host: null },
        () => {
          noteFeedback({
            type: input.feedback_type,
            summary: input.summary,
            details: input.details,
            frictionPoints: input.friction_points,
            suggestedImprovement: input.suggested_improvement,
            tool: input.tool_name && knownTool(input.tool_name),
            sentiment: input.sentiment,
            taskCompleted: input.task_completed,
          });

          return {
            result: { content: [{ type: "text", text: FEEDBACK_ANSWER }] },
            pages: 0,
          };
        }
      )
    )
  );
};
