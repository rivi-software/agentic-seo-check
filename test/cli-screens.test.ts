import { stripVTControlCharacters } from "node:util";

import { Argument, Command, Option } from "commander";
import { describe, expect, it } from "vitest";

import { ALL_RULES } from "../src/core/rules/index.js";
import { errorText, formatHelp, usageHint, withExamples } from "../src/help.js";
import {
  CLAUDE_CODE_ADD,
  INSTALLING,
  installProgress,
  mcpBanner,
  noRuleMatches,
} from "../src/screens.js";
import type { StatusLine } from "../src/terminal.js";
import { VERSION } from "../src/version.js";

const ESC = "\u001B";

/** Text with its line breaks and indents as single spaces, so a wrapped line reads whole. */
const flat = (text: string): string => text.replaceAll(/\s+/gu, " ");

/** The headings of a help, without their rules. */
const headings = (help: string): string[] =>
  help
    .split("\n")
    .filter((line) => / ─{3,}$/u.test(line))
    .map((line) => line.replace(/ ─+$/u, ""));

/** A small CLI laid out as the real one is, its help `width` columns wide, in colour or not. */
const testProgram = ({ width = 80, color = false } = {}) => {
  const program = new Command("agentic-seo-check")
    .summary("SEO and AEO analysis for coding agents")
    .description("Audits URLs, static build output or raw HTML.")
    .version("1.2.3", "-V, --version", "Show the version")
    .helpOption("-h, --help", "Show this help")
    .configureHelp({ formatHelp })
    .configureOutput({
      getOutHelpWidth: () => width,
      getOutHasColors: () => color,
    });

  withExamples(program, ["agentic-seo-check audit https://www.example.com"]);
  program.commandsGroup("Audit commands");

  const audit = withExamples(
    program
      .command("audit")
      .argument("<target>", "URL, directory of HTML files or .html file")
      .description("Audit a page, a site or a build directory"),
    ["agentic-seo-check audit ./dist"]
  );

  audit
    .optionsGroup("Crawling")
    .option("--max-pages <n>", "Maximum pages to crawl", Number, 50)
    .optionsGroup("Output")
    .addOption(
      new Option(
        "-f, --format <format>",
        "Output format: text for people, md, or json for scripts and agents"
      ).choices(["text", "md", "json"])
    )
    .addOption(
      new Option(
        "--fail-on <severity>",
        "Exit with code 1 when findings at or above this severity exist"
      )
        .choices(["error", "warning", "info", "none"])
        .default("none")
    )
    .option("--no-info", "Omit info-level findings");

  program.commandsGroup("Other commands");

  const telemetry = program
    .command("telemetry")
    .summary("Show, turn off or turn on the anonymous usage data")
    .description(
      "Show, turn off or turn on the anonymous usage data the CLI and the local MCP server send"
    )
    .addArgument(
      new Argument("[action]", "What to do")
        .choices(["status", "enable", "disable"])
        .default("status")
    );

  program.helpCommand("help [command]", "Show the help for a command");

  return { program, audit, telemetry };
};

describe("the help", () => {
  it("starts with the product, its version and what it does, and draws a rule after each heading", () => {
    const help = testProgram().program.helpInformation();
    const lines = help.split("\n");

    expect(lines.slice(0, 3)).toStrictEqual([
      `Agentic SEO Check ${VERSION} · SEO and AEO analysis for coding agents`,
      "",
      "  Audits URLs, static build output or raw HTML.",
    ]);
    expect(headings(help)).toStrictEqual([
      "Usage",
      "Audit commands",
      "Other commands",
      "Options",
      "Examples",
    ]);
    expect(
      lines.filter((line) => / ─{3,}$/u.test(line)).map((line) => line.length)
    ).toStrictEqual([80, 80, 80, 80, 80]);
    expect(lines.at(-2)).toMatch(/^Made by RIVI Software /u);
  });

  it("lists the commands by name and argument, with the summary, in their groups", () => {
    const help = testProgram().program.helpInformation();

    // The lines of the commands and options, with the space between the columns as one.
    const items = help
      .split("\n")
      .slice(3)
      .filter((line) => /^ {2}[\w-]/u.test(line))
      .map((line) => line.trim().replaceAll(/ {2,}/gu, " | "));

    expect(items).toStrictEqual([
      "agentic-seo-check <command> [options]",
      "audit <target> | Audit a page, a site or a build directory",
      "telemetry [action] | Show, turn off or turn on the anonymous usage data",
      "help [command] | Show the help for a command",
      "-V, --version | Show the version",
      "-h, --help | Show this help",
      "Each command's options: agentic-seo-check <command> --help",
    ]);
  });

  it("groups a command's options, and ends with its examples", () => {
    const help = testProgram().audit.helpInformation();

    expect(help.split("\n")[0]).toBe(`Agentic SEO Check ${VERSION} · audit`);
    expect(headings(help)).toStrictEqual([
      "Usage",
      "Arguments",
      "Crawling",
      "Output",
      "Options",
      "Examples",
    ]);
    expect(help).toContain("\n  agentic-seo-check audit <target> [options]\n");
    expect(help).toContain("\n  $ agentic-seo-check audit ./dist\n");
    expect(help).not.toContain("Each command's options");
  });

  it("dims the choices and default a description leaves out, and colours the flags", () => {
    const help = testProgram({ color: true }).audit.helpInformation();
    const plain = flat(stripVTControlCharacters(help));

    expect(
      [
        "this severity exist (error, warning, info or none; default: none)",
        "Maximum pages to crawl (default: 50)",
        // --format's description names its choices; --no-info takes no value, so its default is no use.
        "for scripts and agents --fail-on",
        "Omit info-level findings Options ─",
      ].filter((text) => !plain.includes(text))
    ).toStrictEqual([]);
    expect(help).toContain(`${ESC}[2m(error,`);
    expect(help).toContain(
      `${ESC}[36m-f${ESC}[39m, ${ESC}[36m--format${ESC}[39m <format>`
    );
  });

  it("lines up every description, and puts each under its term when the terminal is narrow", () => {
    const wide = testProgram().audit.helpInformation();
    const narrow = testProgram({ width: 40 }).audit.helpInformation();

    const columns = new Set(
      wide
        .split("\n")
        .filter((line) => /^ {2}[-<]/u.test(line))
        .map((line) => /^ {2}\S.*? {2,}(?=\S)/u.exec(line)?.[0].length)
    );

    expect(columns).toStrictEqual(new Set([25]));
    expect(narrow).toMatch(/^ {2}--fail-on <severity>\n {6}Exit with code 1/mu);
  });

  it("names an argument's choices and default", () => {
    const help = testProgram().telemetry.helpInformation();

    expect(flat(help)).toContain(
      "[action] What to do (status, enable or disable; default: status)"
    );
  });
});

describe("an error", () => {
  it("is a sentence after a red cross, with commander's suggestion under it", () => {
    expect([
      errorText(
        "error: unknown command 'audt'\n(Did you mean audit?)\n",
        false
      ),
      errorText(
        "error: option '--fail-on <severity>' argument 'foo' is invalid. Allowed choices are error, warning, info, none.\n",
        false
      ),
      errorText("fetch failed", true),
      errorText(
        "error: unknown option '--crawll'\n(Did you mean --crawl?)",
        true
      ),
    ]).toStrictEqual([
      "✖ Unknown command 'audt'.\n  Did you mean audit?\n",
      "✖ Option '--fail-on <severity>' argument 'foo' is invalid. Allowed choices are error, warning, info, none.\n",
      `${ESC}[31m✖ Fetch failed.${ESC}[39m\n`,
      `${ESC}[31m✖ Unknown option '--crawll'.${ESC}[39m\n  Did you mean ${ESC}[36m--crawl${ESC}[39m?\n`,
    ]);
  });

  it("cannot carry an escape sequence to the terminal", () => {
    expect(
      errorText(`Target "\u001B]0;owned\u0007/x" is not a URL.`, false)
    ).toBe(`✖ Target "]0;owned/x" is not a URL.\n`);
  });

  it("ends, on a terminal, with the usage and the command for the help", () => {
    const { program, audit } = testProgram();

    expect([usageHint(audit, false), usageHint(program, true)]).toStrictEqual([
      "\n  Usage  agentic-seo-check audit <target> [options]\n  Help   agentic-seo-check audit --help",
      `\n  Usage  agentic-seo-check <command> [options]\n  Help   ${ESC}[36magentic-seo-check --help${ESC}[39m`,
    ]);
  });
});

describe("the MCP server's banner", () => {
  it("says the server waits for a client, and how to add it to one", () => {
    const banner = mcpBanner({ width: 100 });

    expect(banner.split("\n")[0]).toBe(
      `Agentic SEO Check MCP server ${VERSION} · stdio`
    );
    expect(flat(banner)).toContain("waiting for an MCP client on stdin");
    expect(banner).toContain(`  Claude Code: ${CLAUDE_CODE_ADD}\n`);
    expect(banner).toContain(
      "  Other clients: https://github.com/rivi-software/agentic-seo-check#mcp-server\n"
    );
  });

  it("keeps the command whole on a line of its own when it does not fit beside its label", () => {
    expect(mcpBanner({ width: 60 })).toContain(
      `  Claude Code:\n    ${CLAUDE_CODE_ADD}\n`
    );
  });
});

describe("the browser install's progress", () => {
  it("shows each download and its percentage on the progress line, and keeps what Playwright says", () => {
    const shown: string[] = [];
    const printed: string[] = [];

    const status: StatusLine = {
      show: (text) => shown.push(text),
      print: (line) => printed.push(line),
      clear: () => shown.push("(cleared)"),
    };

    const onLine = installProgress(status, false);

    // What `playwright install chromium` 1.65 prints when its output is piped, its colour included.
    for (const line of [
      `Downloading Chrome for Testing 158.0.8127.18 (playwright build v1254)${ESC}[2m from https://cdn.playwright.dev/builds/cft/158.0.8127.18/mac-arm64/chrome-mac-arm64.zip${ESC}[22m`,
      `|${"■".repeat(8)}${" ".repeat(72)}|  10% of 190.4 MiB`,
      `|${"■".repeat(80)}| 100% of 190.4 MiB`,
      "Chrome for Testing 158.0.8127.18 (playwright build v1254) downloaded to /tmp/ms-playwright/chromium-1254",
      "",
      "BEWARE: your OS is not officially supported by Playwright; downloading fallback build.",
    ]) {
      onLine(line);
    }

    expect(shown).toStrictEqual([
      "Downloading Chrome for Testing 158.0.8127.18",
      "Downloading Chrome for Testing 158.0.8127.18 · 10% of 190.4 MiB",
      "Installing Chrome for Testing 158.0.8127.18",
      INSTALLING,
    ]);
    expect(printed).toStrictEqual([
      "✓ Chrome for Testing 158.0.8127.18 downloaded",
      "BEWARE: your OS is not officially supported by Playwright; downloading fallback build.",
    ]);
  });
});

/** What `rules` says when its filter matches nothing, without colour. */
const answer = (filter: { category?: string; rule?: string }) =>
  noRuleMatches(filter, ALL_RULES, {});

describe("rules when nothing matches", () => {
  it("names the categories there are", () => {
    const text = answer({ category: "bogus" });

    expect(text.split("\n")[0]).toBe("✖ There is no category bogus.");
    expect(flat(text)).toContain(
      "The categories: title, meta, headings, canonical,"
    );
  });

  it("suggests the rule id nearest to a mistyped one", () => {
    expect(answer({ rule: "canonical.mutliple" })).toBe(
      "✖ There is no rule canonical.mutliple.\n  Did you mean canonical.multiple?\n  Every rule: agentic-seo-check rules\n"
    );
    expect(answer({ rule: "nothing-like-a-rule-id" })).not.toContain(
      "Did you mean"
    );
  });

  it("points a category given as a rule, or a rule given as a category, to the other flag", () => {
    expect([
      answer({ rule: "canonical" }),
      answer({ category: "canonical.multiple" }),
      answer({ category: "title", rule: "canonical.multiple" }),
    ]).toStrictEqual([
      "✖ canonical is a category, not a rule id.\n  Its rules: agentic-seo-check rules --category canonical\n",
      "✖ canonical.multiple is a rule id, not a category.\n  The rule: agentic-seo-check rules --rule canonical.multiple\n",
      "✖ The rule canonical.multiple is not in the category title.\n",
    ]);
  });
});
