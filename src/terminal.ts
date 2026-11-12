/**
 * What the CLI asks of the terminal it writes to (issue #65): whether it shows colour and links,
 * how wide it is, and a progress line that rewrites itself. Only `cli.ts` imports this; the core and
 * the text report never read `process`.
 */
import { paint, terminalSafe } from "./core/report/text.js";
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

/**
 * Lets a reader that stops early, such as `| head`, end the CLI's output without crashing it (issue
 * #85). Writing on after the pipe closed fails with `EPIPE`, which Node throws as an uncaught error
 * when nothing listens for it. The rest of the output is not wanted: the run goes on to its own
 * exit code, and error tracking hears nothing, since it is no bug. Any other error is thrown as
 * before.
 */
export const endQuietlyOnClosedPipe = (
  stream: Pick<NodeJS.WriteStream, "on">
): void => {
  stream.on("error", (error: Error) => {
    if (!("code" in error && error.code === "EPIPE")) {
      throw error;
    }
  });
};

/** A line on a terminal that each `show` rewrites in place, for progress. */
export interface StatusLine {
  show: (text: string) => void;
  /** Removes the line, so what is written next starts at the start of an empty line. */
  clear: () => void;
}

/** The spinner's frames: it turns while the line is shown, so a slow request does not look stuck. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** How often the spinner turns. */
const TICK_MS = 80;

/** From when the line says how long the run has taken: a quick audit never shows a time. */
const SHOW_ELAPSED_MS = 2000;

/** "12 s", then "2 min 5 s". */
const elapsed = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);

  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

/** The spinner and the space after it, which the line's text does not get. */
const SPINNER_COLUMNS = 2;

/**
 * "⠹ Crawling 12/50 · 200 https://example.com/pricing  14 s": a spinner, the step the run is at,
 * and from two seconds on, the time since the first `show`. The spinner's frame and the time are
 * both read off the clock, which a timer redraws; the timer never keeps Node running.
 */
export const statusLine = (stream: Terminal): StatusLine => {
  const color = colorFor(stream);
  let text: string | null = null;
  let started = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const draw = (): void => {
    if (text === null) {
      return;
    }

    const took = Date.now() - started;
    const frame = SPINNER[Math.floor(took / TICK_MS) % SPINNER.length] ?? "";
    const time = took >= SHOW_ELAPSED_MS ? `  ${elapsed(took)}` : "";

    // One column short of the width, so the line never wraps and `\r` returns to its start.
    const columns = stream.columns > 0 ? stream.columns : 80;
    const room = Math.max(1, columns - 1 - SPINNER_COLUMNS - time.length);
    const line = text.length <= room ? text : `${text.slice(0, room - 1)}…`;

    stream.write(
      `\r\u001B[2K${paint(color, "cyan", frame)} ${paint(color, "dim", `${line}${time}`)}`
    );
  };

  return {
    show: (next) => {
      if (text === null) {
        started = Date.now();
        timer = setInterval(draw, TICK_MS);
        timer.unref();
      }

      text = terminalSafe(next).replaceAll("\n", " ");
      draw();
    },
    clear: () => {
      clearInterval(timer);

      if (text !== null) {
        stream.write("\r\u001B[2K");
        text = null;
      }
    },
  };
};
