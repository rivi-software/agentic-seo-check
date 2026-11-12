/**
 * What the CLI prints besides its reports, its help and its telemetry (issue #144): the MCP
 * server's banner for someone who starts it in a terminal, the progress of the browser download,
 * and the answer to a `rules` filter that matches nothing. Only the CLI's entry points import this.
 */
import { stripVTControlCharacters } from "node:util";

import { PRODUCT_NAME, REPOSITORY_URL } from "./brand.js";
import {
  block,
  commandLines,
  paint,
  terminalSafe,
  wrap,
  writer,
} from "./core/report/text.js";
import type { TextOptions } from "./core/report/text.js";
import type { RuleMeta } from "./core/types.js";
import { textOptionsFor } from "./terminal.js";
import type { StatusLine } from "./terminal.js";
import { VERSION } from "./version.js";

/** The command that adds the local MCP server to Claude Code, as the README gives it. */
export const CLAUDE_CODE_ADD =
  "claude mcp add agentic-seo-check -- npx -y @rivi-software/agentic-seo-check mcp";

/** What the MCP server says on stderr when a person starts it in a terminal. */
export const mcpBanner = (options: TextOptions): string => {
  const w = writer(options);
  const docs = `${REPOSITORY_URL}#mcp-server`;

  return `${[
    `${w.style("bold", `${PRODUCT_NAME} MCP server`)} ${w.style("dim", VERSION)}${w.style("dim", " · ")}stdio`,
    "",
    ...block(
      "Running, and waiting for an MCP client on stdin. A client starts this command itself, so add it to yours and stop this one with Ctrl+C.",
      "  ",
      w
    ),
    "",
    ...commandLines("Claude Code:", CLAUDE_CODE_ADD, w),
    `  Other clients: ${w.link(docs, docs)}`,
    "",
  ].join("\n")}\n`;
};

/**
 * Shows the banner when a person starts the MCP server in a terminal, where it would otherwise wait
 * in silence for a client that never comes. A client starts it with stdin a pipe, and its stderr
 * stays as it was. For `agentic-seo-check mcp` and `agentic-seo-check-mcp` alike.
 */
export const announceMcpServer = (): void => {
  if (process.stdin.isTTY && process.stderr.isTTY) {
    process.stderr.write(mcpBanner(textOptionsFor(process.stderr)));
  }
};

/**
 * What the progress line says while `install-browser` runs and no download is under way. It names
 * no browser: Playwright 1.65's "chromium" is Chrome for Testing, and the next may be another.
 */
export const INSTALLING =
  "Installing the browser for --render and --lighthouse";

/** The percentage Playwright prints as a download goes, when its output is piped. */
const PERCENT =
  /(?<percent>\d{1,3})% of (?<size>\d[\d.]{0,10} [A-Za-z]{1,5})$/u;

/** "Chromium 140.0.7339.16" for "Chromium 140.0.7339.16 (playwright build v1187)". */
const browserName = (title: string): string => {
  const build = title.indexOf(" (playwright");

  return build === -1 ? title : title.slice(0, build);
};

/**
 * Puts what `playwright install` prints, line by line, on the progress line: each download and its
 * percentage on the line itself, and each finished download, and anything else Playwright says,
 * such as a warning, as lines that stay.
 */
export const installProgress = (
  status: StatusLine,
  color: boolean
): ((line: string) => void) => {
  let current = "the browser";

  return (raw) => {
    const line = terminalSafe(stripVTControlCharacters(raw)).trim();

    if (line === "") {
      return;
    }

    if (line.startsWith("Downloading ")) {
      const [title = current] = line
        .slice("Downloading ".length)
        .split(" from ");

      current = browserName(title);
      status.show(`Downloading ${current}`);

      return;
    }

    const percent = PERCENT.exec(line)?.groups;

    if (percent) {
      status.show(
        percent.percent === "100"
          ? `Installing ${current}`
          : `Downloading ${current} · ${percent.percent}% of ${percent.size}`
      );

      return;
    }

    const downloaded = line.indexOf(" downloaded to ");

    if (downloaded > 0) {
      // The next step first, so the line under the one that stays never shows the finished download.
      status.show(INSTALLING);
      status.print(
        `${paint(color, "green", "✓")} ${browserName(line.slice(0, downloaded))} downloaded`
      );

      return;
    }

    status.print(line);
  };
};

/** The most characters of a rule id the CLI looks for a near miss of: one is at most 37 now. */
const MAX_SUGGESTED = 64;

/** How many characters to change to turn `a` into `b`: Levenshtein's distance. */
const distance = (a: string, b: string): number => {
  const target = [...b];
  let previous = Array.from({ length: target.length + 1 }, (_, i) => i);

  for (const [i, left] of [...a].entries()) {
    const current = [i + 1];

    for (const [j, right] of target.entries()) {
      current.push(
        Math.min(
          (previous[j + 1] ?? 0) + 1,
          (current[j] ?? 0) + 1,
          (previous[j] ?? 0) + (left === right ? 0 : 1)
        )
      );
    }

    previous = current;
  }

  return previous[target.length] ?? 0;
};

/** The rule id nearest to a mistyped one, when it is a few characters away. */
const nearest = (
  id: string,
  rules: readonly RuleMeta[]
): string | undefined => {
  if (id.length > MAX_SUGGESTED) {
    return;
  }

  const [best] = rules
    .flatMap((rule) => {
      const steps = distance(id, rule.id);

      return steps <= 3 ? [{ id: rule.id, steps }] : [];
    })
    .toSorted((a, b) => a.steps - b.steps);

  return best?.id;
};

/**
 * `rules` when its filter matches nothing: what is not there, and the way to what is. A category
 * given to `--rule`, or a rule id to `--category`, is pointed to the other flag.
 */
export const noRuleMatches = (
  filter: { category?: string; rule?: string },
  rules: readonly RuleMeta[],
  options: TextOptions
): string => {
  const w = writer(options);
  const categories = new Set<string>(rules.map((meta) => meta.category));
  const ids = new Set(rules.map((meta) => meta.id));
  const { category, rule } = filter;

  /** The answer: what failed, in red, then the lines that help. */
  const answer = (failed: string, ...help: string[]): string =>
    `${[w.style("red", `✖ ${failed}`), ...help].join("\n")}\n`;

  if (rule !== undefined && categories.has(rule)) {
    return answer(
      `${terminalSafe(rule)} is a category, not a rule id.`,
      ...commandLines(
        "Its rules:",
        `agentic-seo-check rules --category ${terminalSafe(rule)}`,
        w
      )
    );
  }

  if (category !== undefined && ids.has(category)) {
    return answer(
      `${terminalSafe(category)} is a rule id, not a category.`,
      ...commandLines(
        "The rule:",
        `agentic-seo-check rules --rule ${terminalSafe(category)}`,
        w
      )
    );
  }

  if (category !== undefined && !categories.has(category)) {
    return answer(
      `There is no category ${terminalSafe(category)}.`,
      ...wrap(`The categories: ${[...categories].join(", ")}`, w.width - 2).map(
        (line) => `  ${w.style("dim", line)}`
      )
    );
  }

  if (rule !== undefined && !ids.has(rule)) {
    const near = nearest(rule, rules);

    return answer(
      `There is no rule ${terminalSafe(rule)}.`,
      ...(near ? [`  Did you mean ${w.style("cyan", near)}?`] : []),
      ...commandLines("Every rule:", "agentic-seo-check rules", w)
    );
  }

  // Both exist, and the rule is in another category: the only filter left that matches nothing.
  return answer(
    `The rule ${terminalSafe(rule ?? "")} is not in the category ${terminalSafe(category ?? "")}.`
  );
};
