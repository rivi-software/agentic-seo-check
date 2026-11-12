import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { text as readAll } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { auditAeoHtml, auditAeoSite } from "../src/core/aeo/audit.js";
import { auditHtml, auditSite } from "../src/core/audit.js";
import {
  columns,
  renderAeoText,
  renderRulesText,
  renderText,
  renderVerdict,
  terminalSafe,
} from "../src/core/report/text.js";
import { ALL_RULES } from "../src/core/rules/index.js";
import type { PageAudit, SiteAudit } from "../src/core/types.js";
import {
  colorFor,
  formatFor,
  hyperlinksFor,
  statusLine,
  textOptionsFor,
} from "../src/terminal.js";
import type { Terminal } from "../src/terminal.js";
import { VERSION } from "../src/version.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";
import { tablesOf, tableUnder } from "./helpers/tables.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

/** The report with its line breaks and indents as single spaces, so a wrapped message reads whole. */
const flat = (text: string): string => text.replaceAll(/\s+/gu, " ");

const ESC = "\u001B";

/**
 * Whether a line keeps to `width`: code, an edit's location and the title are never wrapped, and a
 * word longer than the room left (a URL) keeps a line of its own.
 */
const keepsTo = (line: string, width: number): boolean =>
  line.length <= width ||
  /^\s*(?:→|[-+] )/u.test(line) ||
  line.includes(" · http") ||
  line.startsWith("Audited with ") ||
  line.split(" ").some((word) => word.length > 30);

/** The rows of the table under the heading that starts with `title`, without its header. */
const rowsUnder = (text: string, title: string): string[][] =>
  tableUnder(text, title).slice(1);

/** A terminal that records what is written to it. */
const fakeTerminal = (
  init: Partial<Terminal> = {}
): Terminal & { written: string[] } => {
  const written: string[] = [];

  return {
    isTTY: true,
    columns: 80,
    hasColors: () => true,
    write: (chunk: string) => {
      written.push(chunk);

      return true;
    },
    written,
    ...init,
  };
};

describe("the text report of a page", () => {
  let audit: PageAudit;
  let text: string;

  beforeAll(async () => {
    audit = await auditHtml(fixture("bad-page.html"), {
      url: "https://shop.test/bad",
    });
    text = renderText(audit, { width: 80, nextSteps: true });
  });

  it("starts with the page, its score and band, and the counts", () => {
    const [title, , score, counts] = text.split("\n");

    expect(title).toBe("SEO audit · https://shop.test/bad");
    expect(score).toMatch(
      new RegExp(`^ {2}Score ${audit.score}/100 .* (?:good|fair|poor)$`, "u")
    );
    expect(counts).toBe(
      `  ${audit.counts.error} errors · ${audit.counts.warning} warnings · ${audit.counts.info} info`
    );
  });

  it("shows the page's facts, with what is missing named as such", () => {
    expect(text).toMatch(/^ {2}Title {13}React App \(9 characters\)$/mu);
    expect(text).toMatch(/^ {2}Meta description {2}missing$/mu);
  });

  it("shows every error and warning in full, with its rule id and what to do", () => {
    const serious = audit.findings.filter((f) => f.severity !== "info");

    const missing = serious.filter(
      (f) =>
        !flat(text).includes(flat(f.message)) ||
        !flat(text).includes(f.rule) ||
        !flat(text).includes(flat(f.recommendation))
    );

    expect(serious.length).toBeGreaterThan(10);
    expect(missing).toStrictEqual([]);
  });

  it("shows each edit as where, then - and + lines", () => {
    expect(text).toContain(
      `    → Remove in the page's HTML, at head > link[rel="canonical"]\n      - <link rel="canonical" href="https://www.example.com/b">`
    );
    expect(text).toContain(
      "      - <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n      + <p>{{real copy}}</p>"
    );
  });

  it("lists each info finding on one line, without its fix", () => {
    const info = audit.findings.filter((f) => f.severity === "info");
    const lines = text.split("\n").filter((line) => line.startsWith("  • "));
    const charset = info.find((f) => f.rule === "charset.missing");

    expect(lines).toHaveLength(info.length);
    expect(text).toContain(`Info (${info.length})`);
    expect(flat(text)).not.toContain(flat(charset?.recommendation ?? "-"));
  });

  it("leaves out the evidence, which the JSON and the Markdown keep", () => {
    expect(text).not.toContain('"canonicals"');
    expect(text).not.toContain("Evidence");
  });

  it("ends with what to fix first, the commands to run next and the footer", () => {
    expect(text).toContain(
      `  Fix the ${audit.counts.error} errors first, then the ${audit.counts.warning} warnings.`
    );
    expect(text).toContain(
      "  Every fix in full, with its evidence: run again with -o report.md"
    );
    expect(text).toContain(
      "  What a rule checks: agentic-seo-check rules --rule canonical.multiple"
    );
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      `Audited with Agentic SEO Check ${VERSION}, made by RIVI Software (https://rivi.software)`
    );
  });

  it("ends with the verdict again, which stays in view once the report has scrolled past", () => {
    const { error, warning, info } = audit.counts;

    expect(text).toMatch(
      new RegExp(
        `^Summary ─+\\n\\n {2}Score ${audit.score}/100 (?:good|fair|poor) · ${error} errors · ${warning} warnings · ${info} info\\n\\n {2}Fix the`,
        "mu"
      )
    );
    expect(renderVerdict(audit)).toBe(
      `Score ${audit.score}/100 poor · ${error} errors · ${warning} warnings · ${info} info`
    );
  });

  it("draws a rule after each heading, to the width", () => {
    const headings = text.split("\n").filter((line) => / ─{3,}$/u.test(line));

    expect(headings.map((line) => line.replace(/ ─+$/u, ""))).toStrictEqual([
      "Errors (3)",
      `Warnings (${audit.counts.warning})`,
      `Info (${audit.counts.info})`,
      "Summary",
    ]);
    expect(headings.filter((line) => line.length !== 80)).toStrictEqual([]);
  });

  it("names no command unless asked to, for the library", () => {
    const plain = renderText(audit);

    expect(plain).toContain("Fix the 3 errors first");
    expect(plain).not.toContain("agentic-seo-check rules");
    expect(plain).not.toContain("-o report.md");
  });

  it("wraps prose to the width", () => {
    const narrow = renderText(audit, { width: 60, nextSteps: true });
    const long = narrow.split("\n").filter((line) => !keepsTo(line, 60));

    expect(long).toStrictEqual([]);
    expect(narrow.split("\n").length).toBeGreaterThan(text.split("\n").length);
  });

  it("writes no escape codes without colour, and colours with it", () => {
    const coloured = renderText(audit, { color: true });

    expect(text).not.toContain(ESC);
    expect(coloured).toContain(`${ESC}[31m✖${ESC}[39m`);
    expect(coloured).toContain(`${ESC}[33m▲${ESC}[39m`);
    expect(coloured).not.toContain(`${ESC}]8;;`);
  });

  it("links rule ids to their docs when links are on", () => {
    const linked = renderText(audit, { links: true });
    const docs = audit.findings.find((f) => f.docs)?.docs;

    expect(docs).toBeDefined();
    expect(linked).toContain(`${ESC}]8;;${docs}${ESC}\\`);
  });

  it("says when there is nothing to fix", async () => {
    const good = await auditHtml(fixture("good-page.html"), {
      url: "https://www.example.com/widgets/blue/",
    });

    const report = renderText(good);

    expect(report).toContain("Title             Blue Widgets for Home");
    expect(report).not.toContain("Errors (");
    expect(report).toMatch(
      /Nothing to fix(?:\.|: the info findings are suggestions\.)/u
    );
  });
});

describe("the columns text takes on a terminal", () => {
  it("counts CJK and emoji as two, a letter with its accent as one, and the report's symbols as one", () => {
    expect(
      ["title", "東京", "☕", "é", "✖ ▲ • ─ │"].map((text) => columns(text))
    ).toStrictEqual([5, 4, 2, 1, 9]);
  });
});

describe("text from a page in the text report", () => {
  it("cannot reach the terminal as an escape sequence or reorder what is shown", async () => {
    const audit = await auditHtml(
      '<!doctype html><html lang="en"><head><title>Hi &#27;]0;PWNED&#7; there &#x202E;txt.exe</title></head><body><h1>Hi</h1></body></html>',
      { url: "https://shop.test/" }
    );

    const text = renderText(audit, { color: true, links: true });

    expect(text).toContain("Hi ]0;PWNED there txt.exe");
    expect(text).not.toContain(`${ESC}]0;`);
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("‮");
  });

  it("drops C0 and C1 controls, keeps newlines and turns tabs into spaces", () => {
    expect(terminalSafe("a\u001B[2Jb\u009B31mc\r\nd\te\u007F")).toBe(
      "a[2Jb31mc\nd  e"
    );
  });
});

describe("the text report of a site", () => {
  let server: FixtureServer;
  let site: SiteAudit;
  let text: string;

  beforeAll(async () => {
    server = await startFixtureServer(siteRoutes());
    site = await auditSite(`${server.origin}/`, { maxPages: 10 });
    text = renderText(site, { width: 100, nextSteps: true });
  });

  afterAll(async () => {
    await server.close();
  });

  it("shows the crawl, robots.txt and the sitemaps under the score", () => {
    expect(text.split("\n")[0]).toBe(`SEO site audit · ${server.origin}/`);
    expect(text).toContain(
      `  ${site.crawl.pagesCrawled} pages audited, ${site.crawl.pagesDiscovered} found`
    );
    expect(text).toMatch(/^ {2}robots\.txt {2}found, 1 sitemap declared$/mu);
  });

  it("shows the site-wide findings in full and the page findings by rule", () => {
    const missing = site.issues.filter((i) => !flat(text).includes(i.rule));

    expect(text).toContain(`Site-wide (${site.siteFindings.length})`);
    expect(flat(text)).toContain("site.broken-internal-links");
    expect(text).toContain(`On the pages, by rule (${site.issues.length})`);
    expect(missing).toStrictEqual([]);
    expect(text).toContain("Every page's fixes: run again with -o report.md");
  });

  it("lists the pages by path, lowest score first", () => {
    const rows = rowsUnder(text, "Pages (");
    const scores = rows.map(([score]) => Number(score));

    expect(text).toContain("  │ Score  Errors  Warnings  Info  Page         │");
    expect(rows).toHaveLength(site.pages.length);
    expect(scores).toStrictEqual(scores.toSorted((a, b) => a - b));
    expect(rows.filter((row) => row.at(-1) === "/about/")).toHaveLength(1);
    expect(rows.flat()).not.toContain(expect.stringContaining(server.origin));
  });

  it("lists the page findings by rule, with how many pages each is on", () => {
    const rows = rowsUnder(text, "On the pages, by rule");

    expect(rows.map((row) => row[2])).toStrictEqual(
      site.issues.map((issue) => issue.rule)
    );
    expect(rows[0]).toStrictEqual([
      "✖",
      "1",
      "response.error-status",
      "URL returned HTTP 404.",
    ]);
  });

  it("draws each table in a frame whose lines are all as wide, within the width", () => {
    const tables = tablesOf(text);

    expect(tables).toHaveLength(2);

    for (const lines of tables) {
      const widths = new Set(lines.map((line) => columns(line)));

      expect(widths.size).toBe(1);
      expect([...widths][0]).toBeLessThanOrEqual(100);
    }
  });

  it("keeps a frame in line around wide characters, and breaks a path too long for it", () => {
    const [first, second] = site.issues;
    const [page] = site.pages;

    if (!first || !second || !page) {
      throw new Error("The crawl found too little.");
    }

    const slug = "a-very-long-article-slug-".repeat(4);

    const wide: SiteAudit = {
      ...site,
      issues: [
        {
          ...first,
          message: "タイトル「東京のカフェ ☕ ガイド」は短すぎます。",
        },
        second,
      ],
      pages: [{ ...page, url: `${server.origin}/blog/${slug}` }],
    };

    const report = renderText(wide, { width: 80 });
    const [issues = [], pages = []] = tablesOf(report);
    // Where the Page column starts: the rest of the table is one column to a character.
    const at = pages[1]?.indexOf("Page") ?? 0;

    expect(new Set(issues.map((line) => columns(line))).size).toBe(1);
    expect(new Set(pages.map((line) => columns(line)))).toStrictEqual(
      new Set([80])
    );
    expect(
      pages
        .slice(3, -1)
        .map((line) => line.slice(at, -2).trim())
        .join("")
    ).toBe(`/blog/${slug}`);
  });

  it("lists 10 pages at most, and how the rest score", () => {
    const [first] = site.pages;

    if (!first) {
      throw new Error("The crawl audited no page.");
    }

    const many: SiteAudit = {
      ...site,
      pages: Array.from({ length: 13 }, (_, i) => ({
        ...first,
        url: `${server.origin}/p${i}`,
        score: 99 - i,
      })),
    };

    const report = renderText(many);

    const rows = rowsUnder(report, "Pages, lowest scores first");

    expect(report).toContain("Pages, lowest scores first (13)");
    expect(report).toContain(
      "╯\n  … and 3 more pages, each scoring 97 or more"
    );
    expect(rows.map(([score]) => score)).toStrictEqual([
      "87",
      "88",
      "89",
      "90",
      "91",
      "92",
      "93",
      "94",
      "95",
      "96",
    ]);
    expect(rows.map((row) => row.at(-1))).not.toContain("/p0");
  });
});

describe("the text report of an AEO audit", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer({
      ...siteRoutes(),
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /about/\n\nUser-agent: *\nAllow: /\n",
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("groups the AI crawlers by purpose, with a line for each bot kept out", async () => {
    const audit = await auditAeoSite(`${server.origin}/`, { maxPages: 10 });
    const text = renderAeoText(audit, { width: 100, nextSteps: true });

    expect(text.split("\n").slice(0, 3)).toStrictEqual([
      `AEO audit · ${server.origin}/`,
      "",
      expect.stringMatching(/^ {2}AEO score \d+\/100 /u),
    ]);
    expect(text).toMatch(/^ {2}Search index {4}✓ all 3 allowed: Googlebot/mu);
    expect(text).toContain("✗ GPTBot (OpenAI) blocked");
    expect(text).toMatch(
      /✗ ClaudeBot \(Anthropic\) blocked on 1 of \d+ pages/u
    );
    expect(flat(text)).toMatch(
      /Start page .* On the pages, by rule .* Every page's fixes/u
    );
  });

  it("shows a page's findings in full", async () => {
    const audit = await auditAeoHtml(fixture("aeo-bad-page.html"), {
      url: "https://shop.test/guide",
    });

    const text = renderAeoText(audit);
    const serious = audit.findings.filter((f) => f.severity !== "info");

    const missing = serious.filter(
      (f) => !flat(text).includes(flat(f.message))
    );

    expect(serious.length).toBeGreaterThan(0);
    expect(missing).toStrictEqual([]);
    expect(text).toMatch(/^Page ─+\n\n {2}Indexable/mu);
    expect(text).not.toMatch(/^AI crawlers/mu);
  });
});

describe("the text list of rules", () => {
  it("lists every rule under its category", () => {
    const text = renderRulesText(ALL_RULES, { width: 100 });
    const ids = new Set(text.split("\n").map((line) => line.split(" ")[3]));

    expect(ALL_RULES.filter((rule) => !ids.has(rule.id))).toStrictEqual([]);
    expect(text).toContain("Canonical URLs (");
    expect(tablesOf(text)).toHaveLength(
      new Set(ALL_RULES.map((r) => r.category)).size
    );
    expect(text.trimEnd().split("\n").at(-1)).toBe(`${ALL_RULES.length} rules`);
  });

  it("gives each category's descriptions the room its own ids leave", () => {
    const text = renderRulesText(ALL_RULES, { width: 80 });

    expect(text).toContain(
      "  │ title.missing    error     The page has no <title> element or it is empty. │\n"
    );
  });

  it("puts each description under its rule when the ids leave it too little room", () => {
    const text = renderRulesText(
      ALL_RULES.filter((rule) => rule.category === "structured-data"),
      { width: 80 }
    );

    const [lines = []] = tablesOf(text);

    expect(lines.slice(1, 3)).toStrictEqual([
      `  │ Rule${" ".repeat(33)}Severity${" ".repeat(30)}│`,
      `  │   Checks${" ".repeat(67)}│`,
    ]);
    expect(lines[4]).toMatch(
      /^ {2}│ structured-data\.invalid-json +error +│$/u
    );
    expect(lines[5]).toMatch(/^ {2}│ {3}A JSON-LD <script> block/u);
    expect(new Set(lines.map((line) => columns(line)))).toStrictEqual(
      new Set([80])
    );
  });

  it("shows one rule in full", () => {
    const rule = ALL_RULES.find((r) => r.id === "canonical.multiple");

    if (!rule) {
      throw new Error("canonical.multiple is not a rule.");
    }

    const text = renderRulesText([rule], { width: 100 });

    expect(text.split("\n")[0]).toBe(
      "canonical.multiple · error · Canonical URLs"
    );
    expect(flat(text)).toContain(flat(rule.recommendation));
    expect(text).toContain(`  Docs        ${rule.docs}`);
  });

  it("says when no rule matches", () => {
    expect(renderRulesText([])).toBe("No rule matches.\n");
  });

  it("gives the CLI's commands: one rule in full, and the audit that checks only it", () => {
    const list = renderRulesText(ALL_RULES, { nextSteps: true, color: true });

    const checks = [
      "canonical.multiple",
      "rendering.title-changed",
      "aeo.llms-txt-missing",
    ].map((id) =>
      renderRulesText(
        ALL_RULES.filter((r) => r.id === id),
        { nextSteps: true, width: 120 }
      )
        .trimEnd()
        .split("\n")
        .at(-1)
    );

    expect(checks).toStrictEqual([
      "  Check only this rule: agentic-seo-check audit <target> --rule canonical.multiple",
      "  Check only this rule: agentic-seo-check audit <target> --rule rendering.title-changed --render",
      "  Check only this rule: agentic-seo-check aeo <target> --rule aeo.llms-txt-missing",
    ]);
    expect(list.trimEnd().split("\n").at(-1)).toBe(
      `${ALL_RULES.length} rules. One in full: ${ESC}[36magentic-seo-check rules --rule <id>${ESC}[39m`
    );
  });
});

/**
 * The CLI from source, run with `args` and its output piped, under the environment's colour
 * settings `env` adds to; whatever the test runner sets for colour is left out.
 */
const runCli = async (
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string }> => {
  const rest = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !["FORCE_COLOR", "NO_COLOR", "CLICOLOR_FORCE"].includes(name)
    )
  );

  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      ...args,
    ],
    { env: { ...rest, ...env }, stdio: ["ignore", "pipe", "pipe"] }
  );

  const [stdout, stderr] = await Promise.all([
    readAll(child.stdout),
    readAll(child.stderr),
    once(child, "close"),
  ]);

  return { stdout, stderr };
};

describe("the CLI's terminal", () => {
  it("prints text on a terminal and JSON when piped, unless a format or a file decides", () => {
    expect([
      formatFor(undefined, undefined, true),
      formatFor(undefined, undefined, false),
      formatFor("md", undefined, true),
      formatFor(undefined, "report.md", true),
      formatFor(undefined, "report.txt", false),
      formatFor(undefined, "audit.json", true),
      formatFor("json", "report.md", true),
    ]).toStrictEqual(["text", "json", "md", "md", "text", "json", "json"]);
  });

  it("colours a terminal that has colours, and a pipe only with FORCE_COLOR", () => {
    const pipe = fakeTerminal({ isTTY: false });

    expect([
      colorFor(fakeTerminal(), {}),
      colorFor(fakeTerminal({ hasColors: () => false }), {}),
      colorFor(pipe, {}),
      colorFor(pipe, { FORCE_COLOR: "1" }),
      colorFor(pipe, { FORCE_COLOR: "0" }),
    ]).toStrictEqual([true, false, false, true, false]);
  });

  it("links only in terminals known to show OSC 8 links", () => {
    const tty = fakeTerminal();
    const pipe = fakeTerminal({ isTTY: false });

    expect([
      hyperlinksFor(tty, {
        TERM_PROGRAM: "iTerm.app",
        TERM_PROGRAM_VERSION: "3.5.2",
      }),
      hyperlinksFor(tty, {
        TERM_PROGRAM: "iTerm.app",
        TERM_PROGRAM_VERSION: "3.0.1",
      }),
      hyperlinksFor(tty, {
        TERM_PROGRAM: "vscode",
        TERM_PROGRAM_VERSION: "1.95.0",
      }),
      hyperlinksFor(tty, { WT_SESSION: "x" }),
      hyperlinksFor(tty, { VTE_VERSION: "7600" }),
      hyperlinksFor(tty, { TERM_PROGRAM: "Apple_Terminal" }),
      hyperlinksFor(tty, { WT_SESSION: "x", CI: "true" }),
      hyperlinksFor(pipe, { WT_SESSION: "x" }),
      hyperlinksFor(tty, { WT_SESSION: "x", FORCE_HYPERLINK: "0" }),
      hyperlinksFor(pipe, { FORCE_HYPERLINK: "1" }),
    ]).toStrictEqual([
      true,
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("wraps at the terminal's width, 100 columns at most", () => {
    expect([
      textOptionsFor(fakeTerminal({ columns: 72 }), {}).width,
      textOptionsFor(fakeTerminal({ columns: 200 }), {}).width,
      textOptionsFor(fakeTerminal({ isTTY: false }), {}).width,
    ]).toStrictEqual([72, 100, undefined]);
  });

  it("writes no escape codes in the help or an error where colour does not show", async () => {
    const help = await runCli(["audit", "--help"]);
    const error = await runCli(["audit", "--bogus"]);

    expect(help.stdout).toMatch(
      new RegExp(
        `^Agentic SEO Check ${VERSION} · audit\\n\\n {2}Audit a page`,
        "u"
      )
    );
    expect(help.stdout).toMatch(
      /\nExamples ─+\n {2}\$ agentic-seo-check audit /u
    );
    // Piped, an error is followed by the whole help, which an agent reads to correct its call.
    expect(error.stderr).toMatch(
      new RegExp(
        `^✖ Unknown option '--bogus'\\.\\n\\nAgentic SEO Check ${VERSION} · audit\\n`,
        "u"
      )
    );
    expect(`${help.stdout}${error.stderr}`).not.toContain(ESC);
  });

  it("colours an error in red and the help after it, with FORCE_COLOR", async () => {
    const { stderr } = await runCli(["audit", "--bogus"], { FORCE_COLOR: "1" });

    expect(stderr).toMatch(
      new RegExp(
        `^${ESC}\\[31m✖ Unknown option '--bogus'\\.${ESC}\\[39m\\n\\n${ESC}\\[1mAgentic SEO Check${ESC}\\[22m`,
        "u"
      )
    );
  });

  describe("the progress line", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rewrites one line in place, and clears it", () => {
      const terminal = fakeTerminal({ columns: 20, hasColors: () => false });
      const line = statusLine(terminal);

      line.clear();
      line.show("Crawling 1/2 · /a");
      line.show("Crawling 2/2 · /a-long-path\u001B]0;x\u0007");
      line.clear();
      line.clear();

      expect(terminal.written).toStrictEqual([
        `\r${ESC}[2K⠋ Crawling 1/2 · /a`,
        `\r${ESC}[2K⠋ Crawling 2/2 · /…`,
        `\r${ESC}[2K`,
      ]);
    });

    it("turns the spinner while it shows, and says how long the run has taken", () => {
      const terminal = fakeTerminal({ columns: 50, hasColors: () => false });
      const line = statusLine(terminal);

      line.show("Auditing https://shop.test/");
      vi.advanceTimersByTime(80);
      const turned = terminal.written.at(-1);
      vi.advanceTimersByTime(2400);
      const timed = terminal.written.at(-1);
      vi.advanceTimersByTime(62_520);
      line.show("Running Lighthouse (mobile)");
      const minutes = terminal.written.at(-1);
      line.clear();
      const cleared = terminal.written.length;
      vi.advanceTimersByTime(800);

      expect([terminal.written[0], turned, timed, minutes]).toStrictEqual([
        `\r${ESC}[2K⠋ Auditing https://shop.test/`,
        `\r${ESC}[2K⠙ Auditing https://shop.test/`,
        `\r${ESC}[2K⠙ Auditing https://shop.test/  2 s`,
        `\r${ESC}[2K⠹ Running Lighthouse (mobile)  1 min 5 s`,
      ]);
      expect(terminal.written).toHaveLength(cleared);
    });

    it("writes a line that stays above it, and goes on below", () => {
      const terminal = fakeTerminal({ columns: 40, hasColors: () => false });
      const line = statusLine(terminal);

      line.print("before it shows");
      line.show("Downloading Chrome");
      line.print("✓ FFmpeg downloaded");
      line.clear();

      expect(terminal.written).toStrictEqual([
        "before it shows\n",
        `\r${ESC}[2K⠋ Downloading Chrome`,
        `\r${ESC}[2K✓ FFmpeg downloaded\n`,
        `\r${ESC}[2K⠋ Downloading Chrome`,
        `\r${ESC}[2K`,
      ]);
    });

    it("colours the spinner and dims the step, on a terminal with colour", () => {
      const terminal = fakeTerminal();
      const line = statusLine(terminal);

      line.show("Fetching sitemaps");
      line.clear();

      expect(terminal.written[0]).toBe(
        `\r${ESC}[2K${ESC}[36m⠋${ESC}[39m ${ESC}[2mFetching sitemaps${ESC}[22m`
      );
    });
  });
});
