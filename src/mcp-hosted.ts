/**
 * The tools of the hosted MCP server (hosted/, issue #35): the local server's names and options,
 * less what cannot work on Cloudflare's network (files on disk, rendering, Lighthouse, a caller's
 * headers or User-Agent, AI bot probes), with every input capped and every request through the
 * hosted gate, which obeys robots.txt (issue #41). Once published, these schemas are a contract of their own.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { auditAeoHtml, auditAeoSite, auditAeoUrl } from "./core/aeo/audit.js";
import type { AeoOptions } from "./core/aeo/audit.js";
import { auditHtml, auditSite, auditUrl } from "./core/audit.js";
import { RequestRefusedError } from "./core/fetch.js";
import type { FetchOptions, RequestGate } from "./core/fetch.js";
import {
  HOSTED_LIMITS,
  hostedFetch,
  hostedUrlProblem,
  LOCAL_SERVER,
} from "./core/hosted.js";
import type { AeoAudit, Audit } from "./core/types.js";
import {
  commonOptions,
  detail,
  docsNote,
  fail,
  format,
  LIST_RULES,
  listRules,
  respond,
  respondAeo,
  toOptions,
} from "./mcp-shared.js";

/** One tool call, as the hosted server's `startCall` is told it. */
export interface HostedCallInfo {
  tool: string;
  /** The call requests a site: a `url` to audit or crawl, not inline HTML or the rule list. */
  fetches: boolean;
  /** The call crawls a site: seo_crawl_site, or seo_aeo_audit with `crawl`. */
  crawl: boolean;
  /** The host of the `url` the call audits, or null. */
  host: string | null;
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
  /** Told once, when the call's answer is ready. What it throws is ignored: the answer stands. */
  end?: (end: HostedCallEnd) => void;
}

/** What the hosted server (hosted/src/index.ts) adds to the tools. */
export interface HostedProfile {
  /** The User-Agent of every request the tools send; it keeps the agentic-seo-check product token. */
  userAgent: string;
  /** Signs each request the tools send (Web Bot Auth, issue #41); without it they go unsigned. */
  sign?: FetchOptions["sign"];
  /**
   * Starts a tool call. Throws to refuse it (a limit reached, the server paused), and the error's
   * message is the tool error the caller gets.
   */
  startCall: (call: HostedCallInfo) => Promise<HostedCall>;
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

/** The page count of an answer, for the record of the call. */
const pagesOf = (audit: Audit | AeoAudit): number =>
  audit.kind === "page" ? 1 : (audit.pages?.length ?? 1);

/** The host of a URL to audit, once the address rules allow it; throws their answer otherwise. */
const allowedHost = (target: string): string => {
  const parsed = new URL(target);
  const problem = hostedUrlProblem(parsed);

  if (problem) {
    throw new Error(problem);
  }

  return parsed.hostname;
};

/** What a tool's work gives back: its answer, and the pages it audited for the record of the call. */
interface Answer {
  result: CallToolResult;
  pages: number;
}

/** The answer of a tool's work, or its error as a tool error, and how the call ended. */
const settle = async (
  work: () => Promise<Answer> | Answer
): Promise<{ result: CallToolResult; end: HostedCallEnd }> => {
  try {
    const { result, pages } = await work();

    return { result, end: { outcome: "ok", pages } };
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
    return fail(error);
  }

  const { result, end } = await settle(() =>
    work(
      hostedFetch({
        userAgent: profile.userAgent,
        sign: profile.sign,
        limits: call.gate,
        crawl: info.crawl,
      })
    )
  );

  try {
    call.end?.(end);
  } catch {
    // The record of a call is the server's to keep; failing to keep it never costs the caller
    // the answer.
  }

  return result;
};

/** The options of an audit on the hosted server: the caller's, with the hosted fetch. */
const auditOptions = (
  input: Parameters<typeof toOptions>[0],
  fetch: FetchOptions
) => ({
  ...toOptions(input),
  fetch: { ...fetch, timeoutMs: input.timeoutMs },
});

const registerAuditPage = (server: McpServer, profile: HostedProfile): void => {
  server.registerTool(
    "seo_audit_page",
    {
      title: "Audit one page for SEO",
      description:
        `Audit a single page and return prioritised, actionable findings (rule id, severity, message, recommendation, CSS selector, evidence) with a \`fix\` for each: the exact edits that resolve it, quoting the code to replace (\`{{…}}\` marks words the author writes). ` +
        `Checks title, meta description, headings, canonical, robots/noindex, viewport/lang, Open Graph/Twitter cards, images, links, hreflang, structured data (JSON-LD/microdata), content quality and the HTTP response. ` +
        `Provide either \`url\` (a public http(s) URL) or \`html\` (raw HTML string, e.g. from a template or test render). ${
          HOSTED_NOTE
        }Typical workflow: audit, apply the \`fix\` of each error and warning in the source code, then re-check with \`rules\` (the rules you fixed) and \`baseline\` (the finding ids) to confirm they are fixed and nothing new appeared. ${docsNote(
          "hosted"
        )}`,
      inputSchema: {
        url: url
          .optional()
          .describe("Absolute http(s) URL to fetch and audit."),
        html,
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "With `html`: the URL the HTML would be served at (used to resolve links and classify them as internal/external)."
          ),
        ...hostedOptions,
      },
      annotations: {
        title: "Audit one page for SEO",
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (input) => {
      const { html: source, url: target } = input;
      // `html` wins over `url`; an empty `html` counts only when a `url` came with it.
      const inline = source !== undefined && Boolean(source || target);

      if (!inline && !target) {
        return fail(new Error("Provide `url` or `html`."));
      }

      let host: string | null = null;

      try {
        host = inline || !target ? null : allowedHost(target);
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
          };
        }
      );
    }
  );
};

const registerCrawlSite = (server: McpServer, profile: HostedProfile): void => {
  server.registerTool(
    "seo_crawl_site",
    {
      title: "Crawl a site and audit every page",
      description:
        `Crawl internal links from a start URL (at most ${LIMITS.maxPages} pages, depth ${LIMITS.maxDepth}), audit every HTML page, and run site-wide checks: robots.txt, XML sitemap coverage (missing/noindex/non-canonical/broken URLs), broken internal links with their sources, redirect chains, duplicate titles/descriptions/H1s/content, orphan and deep pages, soft-404 behaviour, http→https and www redirects, hreflang return links. ` +
        `Returns site findings plus \`issues\` (page findings rolled up by rule with example URLs) and per-page scores. Use seo_audit_page on a specific URL for full per-page detail. ` +
        `The crawl checks at most ${LIMITS.maxLinkChecks} link targets and reads at most ${LIMITS.maxSitemaps} sitemaps. ${
          HOSTED_NOTE
        }${docsNote("hosted")}`,
      inputSchema: {
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
        ...hostedOptions,
      },
      annotations: {
        title: "Crawl a site and audit every page",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    (input) => {
      let host: string;

      try {
        host = allowedHost(input.url);
      } catch (error) {
        return fail(error);
      }

      return runCall(
        profile,
        { tool: "seo_crawl_site", fetches: true, crawl: true, host },
        async (fetch) => {
          const audit = await auditSite(input.url, {
            ...auditOptions(input, fetch),
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
          };
        }
      );
    }
  );
};

const registerAeoAudit = (server: McpServer, profile: HostedProfile): void => {
  server.registerTool(
    "seo_aeo_audit",
    {
      title: "Audit a page or site for answer engines (AEO)",
      description:
        `Answer engine optimization audit: can AI answer engines (ChatGPT search, Claude, Perplexity, Google AI Overviews and AI Mode, Copilot, Gemini) reach, quote and trust the content? ` +
        `Checks robots.txt for each AI crawler (search crawlers, answer bots, training bots), Content-Signal lines and the shared \`__usage_ai-training\` opt-out, /llms.txt, nosnippet/max-snippet/data-nosnippet, Bing's noarchive/nocache for Copilot, noai, content that needs JavaScript, question headings without a direct answer, FAQPage/HowTo markup that the page does not show, article author and dates, and Organization/Person entities with sameAs. ` +
        `Returns its own AEO score, a per-bot \`crawlers\` table and findings with rule ids (aeo.*). ` +
        `Provide one of \`url\` (one page, or a site with \`crawl: true\`) or \`html\`. ${
          HOSTED_NOTE
        }The local server can also request the page with each AI bot's User-Agent (\`aiBots\`). ${docsNote(
          "hosted"
        )}`,
      inputSchema: {
        url: url
          .optional()
          .describe(
            "Absolute http(s) URL to audit (the start URL with `crawl`)."
          ),
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
          .describe(
            `Crawl: maximum pages to audit (at most ${LIMITS.maxPages}).`
          ),
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
      },
      annotations: {
        title: "Audit a page or site for answer engines (AEO)",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    (input) => {
      if ((input.url === undefined) === (input.html === undefined)) {
        return fail(new Error("Provide exactly one of `url` or `html`."));
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
          };
        }
      );
    }
  );
};

/** The hosted server's tools: as the local server's, less what needs the user's machine. */
export const registerHostedTools = (
  server: McpServer,
  profile: HostedProfile
): void => {
  registerAuditPage(server, profile);
  registerCrawlSite(server, profile);
  registerAeoAudit(server, profile);

  server.registerTool("seo_list_rules", LIST_RULES, (input) =>
    runCall(
      profile,
      { tool: "seo_list_rules", fetches: false, crawl: false, host: null },
      () => ({ result: listRules(input), pages: 0 })
    )
  );
};
