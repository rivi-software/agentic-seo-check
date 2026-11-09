import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { MAKER, MCP_ICONS, REPOSITORY_URL } from "./brand.js";
import {
  auditAeoDirectory,
  auditAeoHtml,
  auditAeoSite,
  auditAeoUrl,
  compactAeoAudit,
} from "./core/aeo/audit.js";
import type { AeoOptions } from "./core/aeo/audit.js";
import {
  auditDirectory,
  auditHtml,
  auditSite,
  auditUrl,
  compactAudit,
} from "./core/audit.js";
import type { CrawlOptions } from "./core/audit.js";
import { runLighthouse } from "./core/lighthouse.js";
import { performanceFindings } from "./core/performance-rules.js";
import { renderAeoMarkdown, renderMarkdown } from "./core/report/markdown.js";
import { ALL_RULES } from "./core/rules/index.js";
import type {
  AeoAudit,
  Audit,
  Finding,
  PerformanceResult,
} from "./core/types.js";
import { VERSION } from "./version.js";

export const MCP_SERVER_NAME = "agentic-seo-check";
export const MCP_SERVER_VERSION = VERSION;

const format = z
  .enum(["json", "markdown"])
  .default("json")
  .describe(
    "json (default) returns the structured audit; markdown returns a human-readable report."
  );

const detail = z
  .enum(["full", "compact"])
  .default("compact")
  .describe(
    "compact trims evidence lists and bulky fields to save tokens (default); full returns everything."
  );

const commonOptions = {
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

const toOptions = (input: {
  keyword?: string;
  includeInfo?: boolean;
  disableRules?: string[];
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
}): CrawlOptions => ({
  keyword: input.keyword,
  includeInfo: input.includeInfo,
  disableRules: input.disableRules,
  fetch: {
    timeoutMs: input.timeoutMs,
    userAgent: input.userAgent,
    headers: input.headers,
  },
});

const respond = (
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

const respondAeo = (
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
const fail = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  return {
    isError: true,
    content: [
      { type: "text" as const, text: `agentic-seo-check error: ${message}` },
    ],
  };
};

const metricCell = (name: string, value: number | null): string => {
  if (value === null) {
    return "—";
  }

  return name.endsWith("Ms") ? `${Math.round(value)} ms` : String(value);
};

const lighthouseMarkdown = (
  payload: PerformanceResult & { findings: Finding[] }
): string => {
  const lines = [
    `# Lighthouse (${payload.formFactor}): ${payload.finalUrl}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
  ];

  for (const [name, value] of Object.entries(payload.metrics)) {
    lines.push(`| ${name} | ${metricCell(name, value)} |`);
  }

  lines.push("", "## Opportunities", "");

  for (const o of payload.opportunities.slice(0, 10)) {
    lines.push(
      `- ${o.title}${o.savingsMs ? ` (~${Math.round(o.savingsMs)} ms)` : ""}${o.savingsBytes ? ` (~${Math.round(o.savingsBytes / 1024)} KiB)` : ""}`
    );
  }

  lines.push("", "## Findings", "");

  for (const f of payload.findings) {
    lines.push(
      `- **\`${f.rule}\`** ${f.message}`,
      `  - Fix: ${f.recommendation}`
    );
  }

  return lines.join("\n");
};

export const createMcpServer = (): McpServer => {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    title: `agentic-seo-check by ${MAKER}`,
    version: MCP_SERVER_VERSION,
    description:
      "SEO and AEO audits for coding agents: pages, sites, build output and raw HTML, checked for search engines and AI answer engines, with findings an agent can act on.",
    websiteUrl: REPOSITORY_URL,
    icons: MCP_ICONS,
  });

  server.registerTool(
    "seo_audit_page",
    {
      title: "Audit one page for SEO",
      description:
        "Audit a single page and return prioritised, actionable findings (rule id, severity, message, recommendation, CSS selector, evidence). " +
        "Checks title, meta description, headings, canonical, robots/noindex, viewport/lang, Open Graph/Twitter cards, images, links, hreflang, structured data (JSON-LD/microdata), content quality and the HTTP response. " +
        "Provide either `url` (live site, staging or http://localhost dev server) or `html` (raw HTML string, e.g. from a template or test render). " +
        "Set `render: true` to also load the page in headless Chromium and report content that only exists after JavaScript runs (SPA/CSR problems). " +
        "Set `lighthouse: true` for Core Web Vitals (LCP, CLS, TBT) and Lighthouse SEO audits; this takes 20-60 seconds. " +
        "Typical workflow: audit, fix the errors and warnings in the source code, re-audit to confirm.",
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe("Absolute http(s) URL to fetch and audit."),
        html: z
          .string()
          .optional()
          .describe("Raw HTML to audit instead of fetching a URL."),
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "With `html`: the URL the HTML would be served at (used to resolve links and classify them as internal/external)."
          ),
        render: z
          .boolean()
          .default(false)
          .describe(
            "Also render with headless Chromium (Playwright) and compare against the server HTML."
          ),
        lighthouse: z
          .boolean()
          .default(false)
          .describe(
            "Also run Lighthouse (performance, SEO, agentic-browsing categories). Slow."
          ),
        formFactor: z
          .enum(["mobile", "desktop"])
          .default("mobile")
          .describe("Lighthouse device emulation."),
        ...commonOptions,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const options = {
          ...toOptions(input),
          render: input.render,
          lighthouse: input.lighthouse,
          formFactor: input.formFactor,
          baseUrl: input.baseUrl,
        };

        const { html, url } = input;
        let audit: Audit;

        // `html` wins over `url`; an empty `html` counts only when a `url` came with it.
        if (html !== undefined && (html || url)) {
          audit = await auditHtml(
            html,
            { url: input.baseUrl, source: "html", target: "inline-html" },
            options
          );
        } else if (url) {
          audit = await auditUrl(url, options);
        } else {
          throw new Error("Provide `url` or `html`.");
        }

        return respond(audit, input.format, input.detail);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "seo_crawl_site",
    {
      title: "Crawl a site and audit every page",
      description:
        "Crawl internal links from a start URL (default 25 pages, depth 3), audit every HTML page, and run site-wide checks: robots.txt, XML sitemap coverage (missing/noindex/non-canonical/broken URLs), broken internal links with their sources, redirect chains, duplicate titles/descriptions/H1s/content, orphan and deep pages, soft-404 behaviour, http→https and www redirects, hreflang return links. " +
        "Returns site findings plus `issues` (page findings rolled up by rule with example URLs) and per-page scores. Use seo_audit_page on a specific URL for full per-page detail. " +
        "Works on http://localhost dev servers; for those set `respectRobots: false` if the dev server serves a blocking robots.txt.",
      inputSchema: {
        url: z.string().url().describe("Start URL (usually the homepage)."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(25)
          .describe("Maximum pages to fetch."),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(3)
          .describe("Maximum link depth from the start URL."),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(4)
          .describe("Parallel requests."),
        delayMs: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .default(0)
          .describe("Delay between requests per worker (politeness)."),
        respectRobots: z
          .boolean()
          .default(true)
          .describe("Obey robots.txt disallow rules while crawling."),
        includeSubdomains: z
          .boolean()
          .default(false)
          .describe("Treat subdomains of the start host as internal."),
        checkExternalLinks: z
          .boolean()
          .default(false)
          .describe("Also probe external link targets for 4xx/5xx (slower)."),
        includePatterns: z
          .array(z.string())
          .optional()
          .describe(
            "Only crawl URLs matching one of these regular expressions."
          ),
        excludePatterns: z
          .array(z.string())
          .optional()
          .describe("Skip URLs matching any of these regular expressions."),
        pageDetail: z
          .enum(["summary", "full"])
          .default("summary")
          .describe(
            "summary: per-page scores/counts only (findings are rolled up in `issues`); full: every finding on every page."
          ),
        ...commonOptions,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const audit = await auditSite(input.url, {
          ...toOptions(input),
          maxPages: input.maxPages,
          maxDepth: input.maxDepth,
          concurrency: input.concurrency,
          delayMs: input.delayMs,
          respectRobots: input.respectRobots,
          includeSubdomains: input.includeSubdomains,
          checkExternalLinks: input.checkExternalLinks,
          includePatterns: input.includePatterns,
          excludePatterns: input.excludePatterns,
          pageDetail: input.pageDetail,
        });

        return respond(audit, input.format, input.detail);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "seo_audit_directory",
    {
      title: "Audit a static build output directory",
      description:
        "Audit every .html file in a build output directory (dist/, out/, build/, .output/public) without running a server. Runs all page checks plus directory-level checks: internal links that resolve to no file, sitemap.xml/robots.txt in the output, duplicate titles/descriptions/content, unlinked files. " +
        "Pass `baseUrl` as the production origin (e.g. https://www.example.com) so absolute links, canonicals and sitemap URLs are classified correctly.",
      inputSchema: {
        dir: z
          .string()
          .describe(
            "Absolute or relative path to the directory containing built HTML files."
          ),
        baseUrl: z
          .string()
          .url()
          .default("http://localhost/")
          .describe("Origin the files will be served from."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Maximum HTML files to audit."),
        pageDetail: z
          .enum(["summary", "full"])
          .default("summary")
          .describe(
            "summary: per-page scores/counts only; full: every finding on every page."
          ),
        ...commonOptions,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const audit = await auditDirectory(input.dir, {
          ...toOptions(input),
          baseUrl: input.baseUrl,
          maxPages: input.maxPages,
          pageDetail: input.pageDetail,
        });

        return respond(audit, input.format, input.detail);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "seo_lighthouse",
    {
      title: "Run Lighthouse on a URL",
      description:
        "Run Google Lighthouse (performance, SEO and agentic-browsing categories) against one URL using a local headless Chrome. Returns Core Web Vitals lab metrics (LCP, CLS, TBT, FCP, Speed Index, TTFB), the top opportunities with estimated savings, failed Lighthouse SEO audits, and findings with thresholds applied. Takes 20-60 seconds. Requires Chrome or Playwright Chromium on this machine.",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL."),
        formFactor: z
          .enum(["mobile", "desktop"])
          .default("mobile")
          .describe(
            "Device emulation. Mobile is what Google uses for ranking."
          ),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Extra request headers (e.g. auth for staging)."),
        format,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const result = await runLighthouse(input.url, {
          formFactor: input.formFactor,
          headers: input.headers,
        });

        const findings = performanceFindings(result);
        const payload = { ...result, findings };

        const text =
          input.format === "markdown"
            ? lighthouseMarkdown(payload)
            : JSON.stringify(payload, null, 2);

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: payload,
        };
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "seo_aeo_audit",
    {
      title: "Audit a page or site for answer engines (AEO)",
      description:
        "Answer engine optimization audit: can AI answer engines (ChatGPT search, Claude, Perplexity, Google AI Overviews and AI Mode, Copilot, Gemini) reach, quote and trust the content? " +
        "Checks robots.txt for each AI crawler (search crawlers, answer bots, training bots), Content-Signal lines and the shared `__usage_ai-training` opt-out, /llms.txt, nosnippet/max-snippet/data-nosnippet, Bing's noarchive/nocache for Copilot, noai, content that needs JavaScript, question headings without a direct answer, FAQPage/HowTo markup that the page does not show, article author and dates, and Organization/Person entities with sameAs. " +
        "Returns its own AEO score, a per-bot `crawlers` table and findings with rule ids (aeo.*). " +
        "Provide one of `url` (one page, or a site with `crawl: true`), `html` or `dir` (build output). " +
        "Set `aiBots: true` to also request the page with each AI bot's User-Agent and catch CDN or firewall blocks that robots.txt does not show.",
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe(
            "Absolute http(s) URL to audit (the start URL with `crawl`)."
          ),
        html: z
          .string()
          .optional()
          .describe(
            "Raw HTML to audit instead of fetching a URL. Page checks only: there is no site to read robots.txt or llms.txt from."
          ),
        dir: z
          .string()
          .optional()
          .describe(
            "Build output directory to audit, with the robots.txt and llms.txt in it."
          ),
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "With `html` or `dir`: the origin the HTML is served from (default http://localhost/)."
          ),
        crawl: z
          .boolean()
          .default(false)
          .describe("With `url`: crawl internal links and audit every page."),
        aiBots: z
          .boolean()
          .default(false)
          .describe(
            "With `url`: request the page with each AI bot's User-Agent (from this machine, not the bots' IPs) to find CDN or firewall blocks."
          ),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe(
            "Crawl or directory: maximum pages to audit (default 25 for a crawl, 500 for a directory)."
          ),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(3)
          .describe("Crawl: maximum link depth from the start URL."),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(4)
          .describe("Crawl: parallel requests."),
        respectRobots: z
          .boolean()
          .default(true)
          .describe("Crawl: obey robots.txt disallow rules."),
        includeSubdomains: z
          .boolean()
          .default(false)
          .describe("Crawl: treat subdomains of the start host as internal."),
        pageDetail: z
          .enum(["summary", "full"])
          .default("summary")
          .describe(
            "Crawl or directory: summary keeps page findings rolled up in `issues`; full lists every page finding in `findings`."
          ),
        includeInfo: commonOptions.includeInfo,
        disableRules: commonOptions.disableRules,
        timeoutMs: commonOptions.timeoutMs,
        userAgent: commonOptions.userAgent,
        headers: commonOptions.headers,
        format,
        detail,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const options: AeoOptions = {
          ...toOptions(input),
          baseUrl: input.baseUrl,
          aiBots: input.aiBots,
          maxPages: input.maxPages ?? (input.dir === undefined ? 25 : 500),
          maxDepth: input.maxDepth,
          concurrency: input.concurrency,
          respectRobots: input.respectRobots,
          includeSubdomains: input.includeSubdomains,
          pageDetail: input.pageDetail,
        };

        const given = [input.url, input.html, input.dir].filter(
          (v) => v !== undefined
        );

        if (given.length !== 1) {
          throw new Error("Provide exactly one of `url`, `html` or `dir`.");
        }

        let audit: AeoAudit;

        if (input.html !== undefined) {
          audit = await auditAeoHtml(
            input.html,
            { url: input.baseUrl, target: "inline-html" },
            options
          );
        } else if (input.dir !== undefined) {
          audit = await auditAeoDirectory(input.dir, options);
        } else if (input.url && input.crawl) {
          audit = await auditAeoSite(input.url, options);
        } else if (input.url) {
          audit = await auditAeoUrl(input.url, options);
        } else {
          throw new Error("Provide `url`, `html` or `dir`.");
        }

        return respondAeo(audit, input.format, input.detail);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "seo_list_rules",
    {
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
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    (input) => {
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
    }
  );

  return server;
};

export const startMcpServer = async (): Promise<void> => {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};
