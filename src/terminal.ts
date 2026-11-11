/**
 * What the CLI asks of the terminal it writes to (issue #65): whether it shows colour and links,
 * how wide it is, and a progress line that rewrites itself. Only `cli.ts` imports this; the core and
 * the text report never read `process`.
 */
import { terminalSafe } from "./core/report/text.js";
import type { TextOptions } from "./core/report/text.js";

/** The report's formats: text for a person, Markdown, JSON for a program. */
export type OutputFormat = "text" | "md" | "json";

/**
 * The report format: as asked; else by the output file's extension (`.md` Markdown, `.txt` text,
 * anything else JSON); else text on a terminal, for a person, and JSON when piped, for a program,
 * which is what agents and CI read.
 */
export const formatFor = (
  format: OutputFormat | undefined,
  out: string | undefined,
  isTTY: boolean
): OutputFormat => {
  if (format !== undefined) {
    return format;
  }

  if (out) {
    if (out.endsWith(".md")) {
      return "md";
    }

    return out.endsWith(".txt") ? "text" : "json";
  }

  return isTTY ? "text" : "json";
};

/** The widest the text report gets, however wide the terminal: longer lines are hard to read. */
const MAX_WIDTH = 100;

type Env = NodeJS.ProcessEnv;

/** What the CLI reads of stdout or stderr, and writes to them. */
export type Terminal = Pick<
  NodeJS.WriteStream,
  "isTTY" | "columns" | "hasColors" | "write"
>;

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "0" && value !== "false";

/**
 * Colour on a terminal that has it, as Node decides (`NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`), and
 * where the output is not a terminal only when `FORCE_COLOR` asks for it.
 */
export const colorFor = (stream: Terminal, env: Env = process.env): boolean =>
  stream.isTTY ? stream.hasColors(env) : isSet(env.FORCE_COLOR);

/** The release from which a terminal that reports its version shows OSC 8 links. */
const versionAtLeast = (
  version: string | undefined,
  min: number[]
): boolean => {
  const parts = (version ?? "").split(".").map(Number);

  for (const [i, want] of min.entries()) {
    const have = parts[i] ?? 0;

    if (Number.isNaN(have) || have !== want) {
      return !Number.isNaN(have) && have > want;
    }
  }

  return true;
};

/** Terminals by `TERM_PROGRAM`, and the release from which they show OSC 8 links. */
const LINKING_PROGRAMS = new Map([
  ["iTerm.app", [3, 1]],
  ["WezTerm", [0]],
  ["vscode", [1, 72]],
  ["ghostty", [0]],
]);

/** Terminals by `TERM` that show OSC 8 links. */
const LINKING_TERMS = new Set([
  "xterm-kitty",
  "xterm-ghostty",
  "wezterm",
  "alacritty",
  "foot",
]);

/**
 * Whether the terminal shows OSC 8 hyperlinks, from what it says of itself: only those known to,
 * because a terminal that does not may print the escape codes. `FORCE_HYPERLINK` decides first.
 */
export const hyperlinksFor = (
  stream: Terminal,
  env: Env = process.env
): boolean => {
  if (env.FORCE_HYPERLINK !== undefined) {
    return isSet(env.FORCE_HYPERLINK);
  }

  if (!stream.isTTY || env.TERM === "dumb" || env.CI !== undefined) {
    return false;
  }

  const program = LINKING_PROGRAMS.get(env.TERM_PROGRAM ?? "");

  if (program) {
    return versionAtLeast(env.TERM_PROGRAM_VERSION, program);
  }

  if (env.WT_SESSION !== undefined || LINKING_TERMS.has(env.TERM ?? "")) {
    return true;
  }

  return (
    Number(env.VTE_VERSION ?? 0) >= 5000 ||
    Number(env.KONSOLE_VERSION ?? 0) >= 201_200
  );
};

/** The text report's options for `stream`: colour, links and width, and the CLI's next steps. */
export const textOptionsFor = (
  stream: Terminal,
  env: Env = process.env
): TextOptions => ({
  color: colorFor(stream, env),
  links: hyperlinksFor(stream, env),
  width:
    stream.isTTY && stream.columns > 0
      ? Math.min(stream.columns, MAX_WIDTH)
      : undefined,
  nextSteps: true,
});

/** A line on a terminal that each `show` rewrites in place, for progress. */
export interface StatusLine {
  show: (text: string) => void;
  /** Removes the line, so what is written next starts at the start of an empty line. */
  clear: () => void;
}

export const statusLine = (stream: Terminal): StatusLine => {
  const dim = colorFor(stream);
  let shown = false;

  return {
    show: (text) => {
      const columns = stream.columns > 0 ? stream.columns : 80;
      const safe = terminalSafe(text).replaceAll("\n", " ");

      // One column short of the width, so the line never wraps and `\r` returns to its start.
      const line =
        safe.length < columns ? safe : `${safe.slice(0, columns - 2)}…`;

      stream.write(`\r\u001B[2K${dim ? `\u001B[2m${line}\u001B[22m` : line}`);
      shown = true;
    },
    clear: () => {
      if (shown) {
        stream.write("\r\u001B[2K");
        shown = false;
      }
    },
  };
};
