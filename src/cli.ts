#!/usr/bin/env node
import { promises as fs } from "node:fs";

import { Argument, Command, InvalidArgumentError, Option } from "commander";

import { auditAeoTarget, compactAeoAudit } from "./core/aeo/audit.js";
import { auditTarget, compactAudit } from "./core/audit.js";
import type { CrawlOptions, ProgressEvent } from "./core/audit.js";
import { ExpectedError, onCaughtError } from "./core/errors.js";
import type { FetchOptions } from "./core/fetch.js";
import { baselineFromAudit } from "./core/recheck.js";
import type { BaselineEntry } from "./core/recheck.js";
import { installBrowser } from "./core/render.js";
import { plural } from "./core/report/labels.js";
import { renderAeoMarkdown, renderMarkdown } from "./core/report/markdown.js";
import {
  renderAeoText,
  renderRulesText,
  renderText,
  paint,
  renderVerdict,
  terminalSafe,
} from "./core/report/text.js";
import type { TextOptions } from "./core/report/text.js";
import { ALL_RULES } from "./core/rules/index.js";
import { SEVERITY_RANK } from "./core/types.js";
import type { AeoAudit, Audit, Severity } from "./core/types.js";
import { errorText, formatHelp, usageHint, withExamples } from "./help.js";
import { startMcpServer } from "./mcp.js";
import {
  announceMcpServer,
  CLAUDE_CODE_ADD,
  INSTALLING,
  installProgress,
  noRuleMatches,
} from "./screens.js";
import {
  localMcpTelemetry,
  noteCliError,
  prepareTelemetry,
  reportCrashes,
  sendCliRun,
  startCliRun,
  targetKind,
  telemetryCommand,
} from "./telemetry/local.js";
import type { CliRun } from "./telemetry/local.js";
import { runReport } from "./telemetry/report.js";
import {
  colorFor,
  endQuietlyOnClosedPipe,
  formatFor,
  statusLine,
  textOptionsFor,
} from "./terminal.js";
import type { OutputFormat } from "./terminal.js";
import { VERSION } from "./version.js";

const program = new Command();

/** Whether stderr shows colour, for the CLI's own lines there. */
const stderrColor = colorFor(process.stderr);

/** Runs of the CLI, for a command's examples. */
const runs = (lines: readonly string[]): string[] =>
  lines.map((line) => `agentic-seo-check ${line}`);

const OVERVIEW_EXAMPLES = [
  "audit https://www.example.com/pricing",
  "crawl https://www.example.com",
  "aeo https://www.example.com",
  "audit ./dist --base-url https://www.example.com",
  "audit https://www.example.com -o report.md",
];

const AUDIT_EXAMPLES = [
  "audit https://www.example.com/pricing",
  "audit https://www.example.com/pricing --field-data",
  "audit http://localhost:3000 --crawl --ignore-robots",
  "audit ./dist --base-url https://www.example.com",
  "audit https://www.example.com -o report.md",
  "audit https://www.example.com --format json > audit.json",
];

const CRAWL_EXAMPLES = [
  "crawl https://www.example.com",
  "crawl https://www.example.com --max-pages 100 --max-depth 4",
  "crawl https://staging.example.com --fail-on error --no-info",
];

const AEO_EXAMPLES = [
  "aeo https://www.example.com/guide",
  "aeo https://www.example.com --crawl --max-pages 50",
  "aeo https://www.example.com --ai-bots",
  "aeo ./dist --base-url https://www.example.com",
];

const RULES_EXAMPLES = [
  "rules",
  "rules --category structured-data",
  "rules --rule canonical.multiple",
];

const INSTALL_BROWSER_EXAMPLES = [
  ...runs(["install-browser", "install-browser --with-deps"]),
  "npx @rivi-software/agentic-seo-check install-browser",
];

const TELEMETRY_EXAMPLES = ["telemetry", "telemetry disable"];

/** The commands that send a `cli_command` event (issue #57); `mcp` reports its tool calls instead. */
const TRACKED = new Set(["audit", "crawl", "aeo", "rules"]);

/** This run, while telemetry is on and the command is one of TRACKED. */
let run: CliRun | null = null;

/** The progress line on stderr, cleared before anything else is written there or to stdout. */
const status = statusLine(process.stderr);

// An error nothing caught prints its stack on stderr: on a line of its own, not after the spinner.
process.on("uncaughtExceptionMonitor", () => {
  status.clear();
});

/** The names of the flags the user typed, such as `--crawl`; never their values. */
const flagsGiven = (command: Command): string[] =>
  command.options
    .filter(
      (option) => command.getOptionValueSource(option.attributeName()) === "cli"
    )
    .map((option) => option.long ?? option.short ?? option.flags);

/** Sends this run's events, once its output is written; it waits a second at most. */
const finishRun = async (exitCode: number): Promise<void> => {
  const done = run;
  run = null;

  if (done) {
    await sendCliRun(done, exitCode);
  }
};

/**
 * Notes this run's unexpected errors for error tracking (issue #60): those the core caught and
 * turned into a finding, and one nothing caught, which ends the run as Node would.
 */
const watchErrors = (): void => {
  onCaughtError((caught, context) => {
    if (run) {
      noteCliError(run, caught, true, context);
    }
  });

  reportCrashes(async (thrown) => {
    if (run) {
      noteCliError(run, thrown, false);
    }

    await finishRun(1);
  });
};

withExamples(program, runs(OVERVIEW_EXAMPLES))
  .name("agentic-seo-check")
  .summary("SEO and AEO analysis for coding agents")
  .description(
    "Audits URLs, static build output or raw HTML for search engines (audit, crawl) and AI answer engines (aeo), and prints machine-readable findings."
  )
  .version(VERSION, "-V, --version", "Show the version")
  // Set before the commands are added, which take these from the program.
  .helpOption("-h, --help", "Show this help")
  .configureHelp({ formatHelp })
  .configureOutput({
    outputError: (text, write) => {
      write(errorText(text, stderrColor));
    },
  })
  .hook("preAction", async (_program, action) => {
    // The MCP server's stdout is its connection to the client, whose end is the transport's to handle.
    if (action.name() !== "mcp") {
      endQuietlyOnClosedPipe(process.stdout);
      endQuietlyOnClosedPipe(process.stderr);
    }

    if (TRACKED.has(action.name()) && (await prepareTelemetry())) {
      run = startCliRun(action.name(), flagsGiven(action));
      watchErrors();
    }
  });

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

/**
 * The options of `audit`, `crawl` and `aeo`, in the groups their help shows: what to crawl, what to
 * check, what to print, and how to send requests.
 */
const addAuditOptions = (cmd: Command, mode: Mode): Command => {
  cmd.optionsGroup("Crawling");

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
    .option("--delay <ms>", "Delay between requests per worker", intArg, 0)
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

  cmd
    .option("--include <regex...>", "Only crawl URLs matching these patterns")
    .option("--exclude <regex...>", "Skip URLs matching these patterns")
    .optionsGroup("Checks");

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
      )
      .option(
        "--field-data",
        "Real-user Core Web Vitals from the Chrome UX Report, for a URL and the first pages of a crawl (needs a free API key in CRUX_API_KEY)"
      );
  }

  return cmd
    .option(
      "--base-url <url>",
      "Origin used for directories, files and stdin HTML (default http://localhost/)"
    )
    .option(
      "--rule <id...>",
      "Run only these rule ids or categories (space- or comma-separated): re-check the findings a fix was for, or check one category"
    )
    .option("--disable <rule...>", "Rule ids or categories to skip")
    .option(
      "--baseline <file>",
      "Compare with an earlier audit saved as JSON: lists the findings since fixed, still open and new"
    )
    .optionsGroup("Output")
    .addOption(
      new Option(
        "-f, --format <format>",
        "Output format: text for people, md, or json for scripts and agents (default: text on a terminal, json when piped; with -o, by the file's extension)"
      ).choices(["text", "md", "json"])
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
    .option("-q, --quiet", "Suppress progress output on stderr")
    .optionsGroup("Requests")
    .option("--timeout <ms>", "Per-request timeout", intArg, 15_000)
    .option("--user-agent <ua>", "Custom User-Agent header")
    .option(
      "-H, --header <header...>",
      'Extra request header "Name: value" (repeatable), sent to the audited origin only'
    );
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
  fieldData?: boolean;
  aiBots?: boolean;
  baseUrl?: string;
  ignoreRobots?: boolean;
  includeSubdomains?: boolean;
  checkExternal?: boolean;
  include?: string[];
  exclude?: string[];
  format?: OutputFormat;
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

/** The text report's options: the terminal's, or plain text for a file. */
const textOptions = (opts: CliOptions): TextOptions =>
  opts.out ? { nextSteps: true } : textOptionsFor(process.stdout);

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
    throw new ExpectedError(
      `Cannot read the baseline ${file}: ${error.message}`
    );
  });

  return baselineFromAudit(json);
};

/** `-H "Name: value"` flags as request headers. */
const parseHeaders = (values: string[] = []) => {
  const headers: NonNullable<FetchOptions["headers"]> = {};

  for (const h of values) {
    const idx = h.indexOf(":");

    if (idx === -1) {
      // Thrown inside the action, where commander does not handle InvalidArgumentError: the
      // top-level catch prints it, and error tracking leaves it out (issue #60).
      throw new ExpectedError(`Header "${h}" must be "Name: value".`);
    }

    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  return headers;
};

/** Whether progress shows: on a terminal's stderr, unless `--quiet`. */
const showsProgress = (opts: CliOptions): boolean =>
  !opts.quiet && process.stderr.isTTY;

/**
 * Progress on one line of a terminal's stderr, which each step rewrites; none elsewhere. A step's
 * message says what it does, so only the crawl's pages get a word and a count before it.
 */
const progressPrinter =
  (opts: CliOptions) =>
  (e: ProgressEvent): void => {
    if (!showsProgress(opts)) {
      return;
    }

    status.show(
      e.crawled === undefined
        ? e.message
        : `Crawling ${e.crawled}/${e.discovered} · ${e.message}`
    );
  };

/** Runs the audit the command asks for, and renders it in the format asked for. */
const auditFor = async (
  target: string,
  opts: CliOptions,
  mode: Mode
): Promise<{ report: Audit | AeoAudit; output: string }> => {
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
    fieldData: opts.fieldData,
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

  const format = formatFor(opts.format, opts.out, process.stdout.isTTY);

  if (run) {
    run.format = format;
  }

  if (mode === "aeo") {
    let aeo: AeoAudit = await auditAeoTarget(target, {
      ...options,
      aiBots: opts.aiBots,
    });

    if (opts.compact) {
      aeo = compactAeoAudit(aeo);
    }

    const render = {
      text: () => renderAeoText(aeo, textOptions(opts)).trimEnd(),
      md: () => renderAeoMarkdown(aeo),
      json: () => JSON.stringify(aeo, null, 2),
    };

    return { report: aeo, output: render[format]() };
  }

  let audit: Audit = await auditTarget(target, options);

  if (opts.compact) {
    audit = compactAudit(audit);
  }

  const render = {
    text: () => renderText(audit, textOptions(opts)).trimEnd(),
    md: () => renderMarkdown(audit),
    json: () => JSON.stringify(audit, null, 2),
  };

  return { report: audit, output: render[format]() };
};

/** Writes the report to `-o`'s file; a file that cannot be written is the user's to fix, not a bug. */
const writeReport = async (file: string, output: string): Promise<void> => {
  await fs.writeFile(file, `${output}\n`, "utf-8").catch((error: Error) => {
    throw new ExpectedError(
      `Cannot write the report to ${file}: ${error.message}`
    );
  });
};

const runAudit = async (
  target: string,
  opts: CliOptions,
  mode: Mode
): Promise<void> => {
  // Before the audit, so an error that ends it says what kind of target it was (issue #85).
  if (run) {
    run.target = await targetKind(target);
  }

  // A single page sends no progress of its own while it is fetched: the spinner turns from the start.
  if (showsProgress(opts)) {
    status.show(
      `${mode === "crawl" || opts.crawl ? "Crawling" : "Auditing"} ${target}`
    );
  }

  const { report, output } = await auditFor(target, opts, mode);
  const { counts } = report;

  status.clear();

  if (run) {
    run.report = runReport(report);
  }

  if (opts.out) {
    await writeReport(opts.out, output);

    if (!opts.quiet) {
      process.stderr.write(
        `${paint(stderrColor, "green", "✓")} Report written to ${terminalSafe(opts.out)}${paint(stderrColor, "dim", " · ")}${renderVerdict(report, { color: stderrColor })}\n`
      );
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
          `${paint(stderrColor, "red", "✖")} ${plural(hits, "finding")} at or above "${opts.failOn}" severity: exit code 1.\n`
        );
      }

      process.exitCode = 1;
    }
  }
};

program.commandsGroup("Audit commands");

addAuditOptions(
  withExamples(
    program
      .command("audit")
      .argument(
        "<target>",
        'URL, directory of HTML files, .html file, or "-" for HTML on stdin'
      )
      .description(
        "Audit a page, a site (--crawl), a build directory or raw HTML"
      ),
    runs(AUDIT_EXAMPLES)
  ),
  "audit"
).action(async (target: string, opts: CliOptions) => {
  await runAudit(target, opts, "audit");
});

addAuditOptions(
  withExamples(
    program
      .command("crawl")
      .argument("<url>", "Start URL")
      .description(
        'Crawl a site and audit every page (same as "audit --crawl")'
      ),
    runs(CRAWL_EXAMPLES)
  ),
  "crawl"
).action(async (url: string, opts: CliOptions) => {
  await runAudit(url, opts, "crawl");
});

addAuditOptions(
  withExamples(
    program
      .command("aeo")
      .argument(
        "<target>",
        'URL, directory of HTML files, .html file, or "-" for HTML on stdin'
      )
      .summary("Answer engine optimization (AEO) audit, with its own score")
      .description(
        "Answer engine optimization audit: AI crawler access (robots.txt, llms.txt), snippet and AI opt-outs, answer-ready content, entities and freshness, with its own score"
      ),
    runs(AEO_EXAMPLES)
  ),
  "aeo"
).action(async (target: string, opts: CliOptions) => {
  await runAudit(target, opts, "aeo");
});

program.commandsGroup("Other commands");

withExamples(
  program
    .command("rules")
    .description("List the rules this tool can report")
    .option("--category <category>", "Filter by category")
    .option("--rule <id>", "Show one rule")
    .addOption(
      new Option(
        "-f, --format <format>",
        "Output format: text for people, md, or json for scripts and agents (default: text on a terminal, json when piped)"
      ).choices(["text", "md", "json"])
    ),
  runs(RULES_EXAMPLES)
).action(
  (opts: { category?: string; rule?: string; format?: OutputFormat }) => {
    const rules = ALL_RULES.filter(
      (r) =>
        (!opts.category || r.category === opts.category) &&
        (!opts.rule || r.id === opts.rule)
    );

    const format = formatFor(opts.format, undefined, process.stdout.isTTY);

    if (run) {
      run.format = format;
    }

    if (format === "json") {
      process.stdout.write(
        `${JSON.stringify({ count: rules.length, rules }, null, 2)}\n`
      );

      return;
    }

    if (format === "text") {
      const options = textOptionsFor(process.stdout);

      process.stdout.write(
        rules.length === 0
          ? noRuleMatches(opts, ALL_RULES, options)
          : renderRulesText(rules, options)
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

withExamples(
  program
    .command("install-browser")
    .summary("Download Chromium for --render and --lighthouse")
    .description(
      "Download the Chromium build the installed Playwright expects, for --render and --lighthouse on a machine without Google Chrome"
    )
    .option(
      "--with-deps",
      "Also install the system libraries Chromium needs (Linux; may ask for sudo)"
    ),
  INSTALL_BROWSER_EXAMPLES
).action(async (opts: { withDeps?: boolean }) => {
  // On a terminal the download shows on the progress line. With --with-deps, sudo may ask for a
  // password, which the progress line would draw over; and a log keeps Playwright's own lines.
  const live = opts.withDeps !== true && process.stderr.isTTY === true;

  if (live) {
    status.show(INSTALLING);
  }

  await installBrowser({
    withDeps: opts.withDeps,
    onLine: live ? installProgress(status, stderrColor) : undefined,
  });

  status.clear();
  process.stderr.write(
    `${paint(stderrColor, "green", "✓")} The browser for --render and --lighthouse is installed.\n`
  );
});

withExamples(
  program
    .command("mcp")
    .description(
      "Start the MCP server on stdio (for Claude Code, Cursor, Codex, etc.)"
    ),
  [CLAUDE_CODE_ADD]
).action(async () => {
  const analytics = await localMcpTelemetry();

  try {
    await startMcpServer({ analytics });
  } catch (error) {
    await analytics?.crashed(error);
    throw error;
  }

  announceMcpServer();
});

withExamples(
  program
    .command("telemetry")
    .summary("Show, turn off or turn on the anonymous usage data")
    .description(
      "Show, turn off or turn on the anonymous usage data the CLI and the local MCP server send"
    )
    .addArgument(
      new Argument("[action]", "What to do")
        .choices(["status", "enable", "disable"])
        .default("status")
    ),
  runs(TELEMETRY_EXAMPLES)
).action(async (action: "status" | "enable" | "disable") => {
  process.stdout.write(
    await telemetryCommand(action, process.env, textOptionsFor(process.stdout))
  );
});

program.helpCommand("help [command]", "Show the help for a command");

// On a terminal, a usage error ends with the usage and the command for the help, so the error
// stays in view. Piped, it ends with the whole help, which an agent reads to correct its call.
for (const command of [program, ...program.commands]) {
  command.showHelpAfterError(
    process.stderr.isTTY ? usageHint(command, stderrColor) : true
  );
}

try {
  await program.parseAsync(process.argv);
  await finishRun(Number(process.exitCode ?? 0));
} catch (error) {
  status.clear();
  process.stderr.write(
    errorText(
      error instanceof Error ? error.message : String(error),
      stderrColor
    )
  );

  if (run) {
    noteCliError(run, error, false);
  }

  await finishRun(2);
  process.exit(2);
}
