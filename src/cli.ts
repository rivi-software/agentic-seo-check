#!/usr/bin/env node
import { promises as fs } from "node:fs";

import { Command, InvalidArgumentError, Option } from "commander";

import { auditTarget, compactAudit } from "./core/audit.js";
import type { CrawlOptions, ProgressEvent } from "./core/audit.js";
import { renderMarkdown } from "./core/report/markdown.js";
import { ALL_RULES } from "./core/rules/index.js";
import { SEVERITY_RANK } from "./core/types.js";
import type { Audit, Severity } from "./core/types.js";
import { startMcpServer } from "./mcp.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("agentic-seo-check")
  .description(
    "SEO analysis for coding agents. Audits URLs, static build output or raw HTML and prints machine-readable findings."
  )
  .version(VERSION)
  .showHelpAfterError();

const intArg = (value: string): number => {
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- parseInt reads the leading digits ("10.5" is 10), where Number would refuse what users have always passed
  const n = Number.parseInt(value, 10);

  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }

  return n;
};

const addAuditOptions = (cmd: Command, crawlDefault: boolean): Command => {
  if (!crawlDefault) {
    cmd.option(
      "--crawl",
      "Crawl the whole site starting at the URL instead of auditing one page"
    );
  }

  return cmd
    .option("--max-pages <n>", "Maximum pages to crawl", intArg, 50)
    .option(
      "--max-depth <n>",
      "Maximum link depth from the start URL",
      intArg,
      3
    )
    .option("--concurrency <n>", "Parallel requests while crawling", intArg, 5)
    .option("--delay <ms>", "Delay between requests per worker", intArg, 0)
    .option("-k, --keyword <keyword>", "Target keyword for keyword.* checks")
    .option(
      "--render",
      "Render with headless Chromium (Playwright) and compare with the server HTML"
    )
    .option(
      "--lighthouse",
      "Run Lighthouse for Core Web Vitals and Lighthouse SEO audits (slow)"
    )
    .addOption(
      new Option("--form-factor <type>", "Lighthouse device emulation")
        .choices(["mobile", "desktop"])
        .default("mobile")
    )
    .option(
      "--base-url <url>",
      "Origin used for directories, files and stdin HTML (default http://localhost/)"
    )
    .option("--ignore-robots", "Do not obey robots.txt while crawling")
    .option(
      "--include-subdomains",
      "Treat subdomains as internal when crawling"
    )
    .option(
      "--check-external",
      "Probe external links for 4xx/5xx while crawling"
    )
    .option("--include <regex...>", "Only crawl URLs matching these patterns")
    .option("--exclude <regex...>", "Skip URLs matching these patterns")
    .addOption(
      new Option(
        "-f, --format <format>",
        "Output format (default: json when piped, md on a terminal)"
      ).choices(["json", "md"])
    )
    .option("-o, --out <file>", "Write the report to a file instead of stdout")
    .addOption(
      new Option(
        "--fail-on <severity>",
        "Exit with code 1 when findings at or above this severity exist"
      )
        .choices(["error", "warning", "info", "none"])
        .default("none")
    )
    .option("--no-info", "Omit info-level findings")
    .option(
      "--compact",
      "Trim evidence lists and bulky fields (smaller output for LLM consumption)"
    )
    .addOption(
      new Option("--page-detail <level>", "Per-page detail in site reports")
        .choices(["full", "summary"])
        .default("full")
    )
    .option("--disable <rule...>", "Rule ids to skip")
    .option("--timeout <ms>", "Per-request timeout", intArg, 15_000)
    .option("--user-agent <ua>", "Custom User-Agent header")
    .option(
      "-H, --header <header...>",
      'Extra request header "Name: value" (repeatable)'
    )
    .option("-q, --quiet", "Suppress progress output on stderr");
};

interface CliOptions {
  crawl?: boolean;
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  delay: number;
  keyword?: string;
  render?: boolean;
  lighthouse?: boolean;
  formFactor: "mobile" | "desktop";
  baseUrl?: string;
  ignoreRobots?: boolean;
  includeSubdomains?: boolean;
  checkExternal?: boolean;
  include?: string[];
  exclude?: string[];
  format?: "json" | "md";
  out?: string;
  failOn: Severity | "none";
  info: boolean;
  compact?: boolean;
  pageDetail: "full" | "summary";
  disable?: string[];
  timeout: number;
  userAgent?: string;
  header?: string[];
  quiet?: boolean;
}

/** The report format: as asked, else by the output file's extension, else Markdown on a terminal. */
const formatOf = (opts: CliOptions): "json" | "md" => {
  if (opts.format !== undefined) {
    return opts.format;
  }

  if (opts.out) {
    return opts.out.endsWith(".md") ? "md" : "json";
  }

  return process.stdout.isTTY ? "md" : "json";
};

const runAudit = async (
  target: string,
  opts: CliOptions,
  forceCrawl: boolean
): Promise<void> => {
  const headers: Record<string, string> = {};

  for (const h of opts.header ?? []) {
    const idx = h.indexOf(":");

    if (idx === -1) {
      throw new InvalidArgumentError(`Header "${h}" must be "Name: value".`);
    }

    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  const showProgress = !opts.quiet && process.stderr.isTTY;

  const onProgress = (e: ProgressEvent): void => {
    if (!showProgress) {
      return;
    }

    const counter =
      e.crawled === undefined ? "" : ` [${e.crawled}/${e.discovered}]`;

    process.stderr.write(
      `\u001B[2m${e.phase}${counter}: ${e.message}\u001B[0m\n`
    );
  };

  const options: CrawlOptions & { crawl?: boolean } = {
    crawl: forceCrawl || Boolean(opts.crawl),
    maxPages: opts.maxPages,
    maxDepth: opts.maxDepth,
    concurrency: opts.concurrency,
    delayMs: opts.delay,
    keyword: opts.keyword,
    render: opts.render,
    lighthouse: opts.lighthouse,
    formFactor: opts.formFactor,
    baseUrl: opts.baseUrl,
    respectRobots: !opts.ignoreRobots,
    includeSubdomains: opts.includeSubdomains,
    checkExternalLinks: opts.checkExternal,
    includePatterns: opts.include,
    excludePatterns: opts.exclude,
    includeInfo: opts.info,
    disableRules: opts.disable,
    pageDetail: opts.pageDetail,
    fetch: {
      timeoutMs: opts.timeout,
      userAgent: opts.userAgent,
      headers: Object.keys(headers).length ? headers : undefined,
    },
    onProgress,
  };

  let audit: Audit = await auditTarget(target, options);

  if (opts.compact) {
    audit = compactAudit(audit);
  }

  const format = formatOf(opts);

  const output =
    format === "md" ? renderMarkdown(audit) : JSON.stringify(audit, null, 2);

  if (opts.out) {
    await fs.writeFile(opts.out, `${output}\n`, "utf-8");

    if (!opts.quiet) {
      process.stderr.write(`Report written to ${opts.out}\n`);
    }
  } else {
    process.stdout.write(`${output}\n`);
  }

  if (opts.failOn !== "none") {
    const threshold = SEVERITY_RANK[opts.failOn];
    const { counts } = audit;

    const hits = (["error", "warning", "info"] as const)
      .filter((s) => SEVERITY_RANK[s] >= threshold)
      .reduce((n, s) => n + counts[s], 0);

    if (hits > 0) {
      if (!opts.quiet) {
        process.stderr.write(
          `${hits} finding(s) at or above "${opts.failOn}" severity.\n`
        );
      }

      process.exitCode = 1;
    }
  }
};

addAuditOptions(
  program
    .command("audit")
    .argument(
      "<target>",
      'URL, directory of HTML files, .html file, or "-" for HTML on stdin'
    )
    .description(
      "Audit a page, a site (--crawl), a build directory or raw HTML"
    ),
  false
).action(async (target: string, opts: CliOptions) => {
  await runAudit(target, opts, false);
});

addAuditOptions(
  program
    .command("crawl")
    .argument("<url>", "Start URL")
    .description('Crawl a site and audit every page (same as "audit --crawl")'),
  true
).action(async (url: string, opts: CliOptions) => {
  await runAudit(url, opts, true);
});

program
  .command("rules")
  .description("List the rules this tool can report")
  .option("--category <category>", "Filter by category")
  .option("--rule <id>", "Show one rule")
  .addOption(
    new Option("-f, --format <format>", "Output format")
      .choices(["json", "md"])
      .default(process.stdout.isTTY ? "md" : "json")
  )
  .action(
    (opts: { category?: string; rule?: string; format: "json" | "md" }) => {
      const rules = ALL_RULES.filter(
        (r) =>
          (!opts.category || r.category === opts.category) &&
          (!opts.rule || r.id === opts.rule)
      );

      if (opts.format === "json") {
        process.stdout.write(
          `${JSON.stringify({ count: rules.length, rules }, null, 2)}\n`
        );

        return;
      }

      const lines = [
        "| Rule | Severity | Category | Checks |",
        "| --- | --- | --- | --- |",
      ];

      for (const r of rules) {
        lines.push(
          `| \`${r.id}\` | ${r.severity} | ${r.category} | ${r.description.replaceAll("|", "\\|")}${r.requires ? ` _(requires ${r.requires})_` : ""} |`
        );
      }

      process.stdout.write(`${lines.join("\n")}\n`);
    }
  );

program
  .command("mcp")
  .description(
    "Start the MCP server on stdio (for Claude Code, Cursor, Codex, etc.)"
  )
  .action(async () => {
    await startMcpServer();
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `agentic-seo-check: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(2);
}
