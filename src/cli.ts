#!/usr/bin/env node
import { promises as fs } from "node:fs";

import { Command, InvalidArgumentError, Option } from "commander";

import { MAKER, MAKER_URL, REPOSITORY_URL } from "./brand.js";
import { auditAeoTarget, compactAeoAudit } from "./core/aeo/audit.js";
import { auditTarget, compactAudit } from "./core/audit.js";
import type { CrawlOptions, ProgressEvent } from "./core/audit.js";
import type { FetchOptions } from "./core/fetch.js";
import { baselineFromAudit } from "./core/recheck.js";
import type { BaselineEntry } from "./core/recheck.js";
import { installBrowser } from "./core/render.js";
import { renderAeoMarkdown, renderMarkdown } from "./core/report/markdown.js";
import { ALL_RULES } from "./core/rules/index.js";
import { SEVERITY_RANK } from "./core/types.js";
import type { AeoAudit, Audit, Severity } from "./core/types.js";
import { startMcpServer } from "./mcp.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("agentic-seo-check")
  .description(
    "SEO and AEO analysis for coding agents. Audits URLs, static build output or raw HTML for search engines (audit, crawl) and AI answer engines (aeo), and prints machine-readable findings."
  )
  .version(VERSION)
  .addHelpText(
    "afterAll",
    `\nMade by ${MAKER} (${MAKER_URL}). Docs and issues: ${REPOSITORY_URL}`
  )
  .showHelpAfterError();

const intArg = (value: string): number => {
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- parseInt reads the leading digits ("10.5" is 10), where Number would refuse what users have always passed
  const n = Number.parseInt(value, 10);

  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }

  return n;
};

/** Which command the options are for: the SEO audit of a target, of a whole site, or the AEO audit. */
type Mode = "audit" | "crawl" | "aeo";

const addAuditOptions = (cmd: Command, mode: Mode): Command => {
  if (mode !== "crawl") {
    cmd.option(
      "--crawl",
      "Crawl the whole site starting at the URL instead of auditing one page"
    );
  }

  cmd
    .option("--max-pages <n>", "Maximum pages to crawl", intArg, 50)
    .option(
      "--max-depth <n>",
      "Maximum link depth from the start URL",
      intArg,
      3
    )
    .option("--concurrency <n>", "Parallel requests while crawling", intArg, 5)
    .option("--delay <ms>", "Delay between requests per worker", intArg, 0);

  if (mode === "aeo") {
    cmd.option(
      "--ai-bots",
      "Also request the page with each AI bot's User-Agent to catch CDN or firewall blocks"
    );
  } else {
    cmd
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
      );
  }

  cmd
    .option(
      "--base-url <url>",
      "Origin used for directories, files and stdin HTML (default http://localhost/)"
    )
    .option("--ignore-robots", "Do not obey robots.txt while crawling")
    .option(
      "--include-subdomains",
      "Treat subdomains as internal when crawling"
    );

  if (mode !== "aeo") {
    cmd.option(
      "--check-external",
      "Probe external links for 4xx/5xx while crawling"
    );
  }

  return cmd
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
    .option(
      "--rule <id...>",
      "Run only these rule ids (space- or comma-separated): re-check the findings a fix was for"
    )
    .option(
      "--baseline <file>",
      "Compare with an earlier audit saved as JSON: lists the findings since fixed, still open and new"
    )
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
  formFactor?: "mobile" | "desktop";
  aiBots?: boolean;
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
  rule?: string[];
  baseline?: string;
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

/** Rule ids from `--rule a b` and `--rule a,b`. */
const ruleIds = (values: string[] | undefined): string[] | undefined =>
  values
    ?.flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

/** The findings of the audit `--baseline` names. */
const readBaseline = async (
  file: string | undefined
): Promise<BaselineEntry[] | undefined> => {
  if (file === undefined) {
    return;
  }

  const json = await fs.readFile(file, "utf-8").catch((error: Error) => {
    throw new Error(`Cannot read the baseline ${file}: ${error.message}`);
  });

  return baselineFromAudit(json);
};

/** `-H "Name: value"` flags as request headers. */
const parseHeaders = (values: string[] = []) => {
  const headers: NonNullable<FetchOptions["headers"]> = {};

  for (const h of values) {
    const idx = h.indexOf(":");

    if (idx === -1) {
      throw new InvalidArgumentError(`Header "${h}" must be "Name: value".`);
    }

    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  return headers;
};

const progressPrinter = (opts: CliOptions) => {
  const showProgress = !opts.quiet && process.stderr.isTTY;

  return (e: ProgressEvent): void => {
    if (!showProgress) {
      return;
    }

    const counter =
      e.crawled === undefined ? "" : ` [${e.crawled}/${e.discovered}]`;

    process.stderr.write(
      `\u001B[2m${e.phase}${counter}: ${e.message}\u001B[0m\n`
    );
  };
};

/** Runs the audit the command asks for, and renders it in the format asked for. */
const auditFor = async (
  target: string,
  opts: CliOptions,
  mode: Mode
): Promise<{ counts: Audit["counts"]; output: string }> => {
  const headers = parseHeaders(opts.header);

  const options: CrawlOptions & { crawl?: boolean } = {
    crawl: mode === "crawl" || Boolean(opts.crawl),
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
    onlyRules: ruleIds(opts.rule),
    baseline: await readBaseline(opts.baseline),
    pageDetail: opts.pageDetail,
    fetch: {
      timeoutMs: opts.timeout,
      userAgent: opts.userAgent,
      headers: Object.keys(headers).length ? headers : undefined,
    },
    onProgress: progressPrinter(opts),
  };

  const format = formatOf(opts);

  if (mode === "aeo") {
    let aeo: AeoAudit = await auditAeoTarget(target, {
      ...options,
      aiBots: opts.aiBots,
    });

    if (opts.compact) {
      aeo = compactAeoAudit(aeo);
    }

    return {
      counts: aeo.counts,
      output:
        format === "md" ? renderAeoMarkdown(aeo) : JSON.stringify(aeo, null, 2),
    };
  }

  let audit: Audit = await auditTarget(target, options);

  if (opts.compact) {
    audit = compactAudit(audit);
  }

  return {
    counts: audit.counts,
    output:
      format === "md" ? renderMarkdown(audit) : JSON.stringify(audit, null, 2),
  };
};

const runAudit = async (
  target: string,
  opts: CliOptions,
  mode: Mode
): Promise<void> => {
  const { counts, output } = await auditFor(target, opts, mode);

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
  "audit"
).action(async (target: string, opts: CliOptions) => {
  await runAudit(target, opts, "audit");
});

addAuditOptions(
  program
    .command("crawl")
    .argument("<url>", "Start URL")
    .description('Crawl a site and audit every page (same as "audit --crawl")'),
  "crawl"
).action(async (url: string, opts: CliOptions) => {
  await runAudit(url, opts, "crawl");
});

addAuditOptions(
  program
    .command("aeo")
    .argument(
      "<target>",
      'URL, directory of HTML files, .html file, or "-" for HTML on stdin'
    )
    .description(
      "Answer engine optimization audit: AI crawler access (robots.txt, llms.txt), snippet and AI opt-outs, answer-ready content, entities and freshness, with its own score"
    ),
  "aeo"
).action(async (target: string, opts: CliOptions) => {
  await runAudit(target, opts, "aeo");
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
  .command("install-browser")
  .description(
    "Download the Chromium build the installed Playwright expects, for --render and --lighthouse on a machine without Google Chrome"
  )
  .option(
    "--with-deps",
    "Also install the system libraries Chromium needs (Linux; may ask for sudo)"
  )
  .action(async (opts: { withDeps?: boolean }) => {
    await installBrowser(opts);
  });

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
