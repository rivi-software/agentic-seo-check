/**
 * The CLI's help and its usage errors in the text report's style (issue #144): the product and its
 * version on top, a heading with a rule for each section, the commands and options in groups,
 * choices and defaults dimmed, and the examples last. Commander still decides what a help holds and
 * what an error is; this module lays them out. Only `cli.ts` imports it.
 */
import type { Argument, Command, Help, Option } from "commander";

import { MAKER, MAKER_URL, PRODUCT_NAME, REPOSITORY_URL } from "./brand.js";
import { sentence } from "./core/report/labels.js";
import {
  block,
  heading,
  paint,
  terminalSafe,
  writer,
} from "./core/report/text.js";
import type { Style, Writer } from "./core/report/text.js";
import { MAX_WIDTH } from "./terminal.js";
import { VERSION } from "./version.js";

/** Each command's examples, which end its help. */
const EXAMPLES = new WeakMap<Command, readonly string[]>();

/** Ends the help of `command` with `runs`, each a command line as it is typed. */
export const withExamples = (
  command: Command,
  runs: readonly string[]
): Command => {
  EXAMPLES.set(command, runs);

  return command;
};

/** "agentic-seo-check audit": the command as it is typed. */
const commandPath = (command: Command): string =>
  command.parent
    ? `${commandPath(command.parent)} ${command.name()}`
    : command.name();

/** "<target>", "[action]" */
const argumentName = (argument: Argument): string => {
  const name = `${argument.name()}${argument.variadic ? "..." : ""}`;

  return argument.required ? `<${name}>` : `[${name}]`;
};

/** "agentic-seo-check audit <target> [options]": every command takes `--help`, at least. */
const usageOf = (command: Command): string =>
  [
    commandPath(command),
    ...command.registeredArguments.map(argumentName),
    ...(command.commands.length > 0 ? ["<command>"] : []),
    "[options]",
  ].join(" ");

/** Text in one style, or in none. */
type Run = readonly [text: string, style?: Style];

/**
 * `runs` in lines of at most `width` columns, broken at spaces, each word in its run's style: a
 * dimmed default can start on one line and end on the next.
 */
const wrapRuns = (runs: readonly Run[], width: number, w: Writer): string[] => {
  const lines: string[][] = [];
  let line: string[] = [];
  let length = 0;

  for (const [text, style] of runs) {
    for (const word of text.split(" ")) {
      if (word === "") {
        continue;
      }

      if (line.length > 0 && length + 1 + word.length > width) {
        lines.push(line);
        line = [];
        length = 0;
      }

      length += (line.length > 0 ? 1 : 0) + word.length;
      line.push(style ? w.style(style, word) : word);
    }
  }

  if (line.length > 0) {
    lines.push(line);
  }

  return lines.map((words) => words.join(" "));
};

/** "a, b or c" */
const listed = (values: readonly string[]): string =>
  values.length > 1
    ? `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`
    : values.join("");

/**
 * The description, then its choices and default dimmed: "(error, warning, info or none; default:
 * none)". A description that names every choice already, as `--format`'s does, gets no list of them.
 */
const described = (
  description: string,
  choices: readonly string[] | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- commander types a default as any value
  fallback: unknown
): Run[] => {
  const words = new Set(description.split(/[^\w-]+/u));

  const extras = [
    ...(choices && !choices.every((choice) => words.has(choice))
      ? [listed(choices)]
      : []),
    ...(fallback === undefined ? [] : [`default: ${String(fallback)}`]),
  ];

  return extras.length > 0
    ? [[description], [`(${extras.join("; ")})`, "dim"]]
    : [[description]];
};

/** A line of a section: what is typed, and what it does. */
interface Item {
  /** As it is typed, which sizes the column. */
  term: string;
  /** In colour: commands and flags in cyan, as the report shows a command to run. */
  styled: string;
  description: readonly Run[];
}

const optionItem = (option: Option, w: Writer): Item => ({
  term: option.flags,
  styled: option.flags
    .split(" ")
    .map((part) => {
      if (part.startsWith("<") || part.startsWith("[")) {
        return part;
      }

      return part.endsWith(",")
        ? `${w.style("cyan", part.slice(0, -1))},`
        : w.style("cyan", part);
    })
    .join(" "),
  description: described(
    option.description,
    option.argChoices,
    // A flag that takes no value has no default worth showing: `--no-info` defaults to true.
    option.required || option.optional
      ? (option.defaultValueDescription ?? option.defaultValue)
      : undefined
  ),
});

const argumentItem = (argument: Argument, w: Writer): Item => {
  const term = argumentName(argument);

  return {
    term,
    styled: w.style("cyan", term),
    description: described(
      argument.description,
      argument.argChoices,
      argument.defaultValueDescription ?? argument.defaultValue
    ),
  };
};

const commandItem = (command: Command, helper: Help, w: Writer): Item => {
  const args = command.registeredArguments.map(argumentName);

  return {
    term: [command.name(), ...args].join(" "),
    styled: [w.style("cyan", command.name()), ...args].join(" "),
    description: [[helper.subcommandDescription(command)]],
  };
};

/** With less room than this beside its term, a description goes under it instead. */
const MIN_DESCRIPTION = 30;

/** Items in two columns, each description wrapped beside its term; `column` is where it starts. */
const itemLines = (
  items: readonly Item[],
  column: number,
  w: Writer
): string[] =>
  items.flatMap((item) => {
    if (w.width - column < MIN_DESCRIPTION) {
      return [
        `  ${item.styled}`,
        ...wrapRuns(item.description, w.width - 6, w).map(
          (line) => `      ${line}`
        ),
      ];
    }

    const [first = "", ...rest] = wrapRuns(
      item.description,
      w.width - column,
      w
    );

    return [
      `  ${item.styled}${" ".repeat(column - 2 - item.term.length)}${first}`,
      ...rest.map((line) => `${" ".repeat(column)}${line}`),
    ];
  });

/**
 * A heading with its rule, then its lines. Unlike a report's, a help's heading has no blank line
 * under it: its lines are short, and the help fits on fewer screens.
 */
const section = (title: string, body: readonly string[], w: Writer): string[] =>
  body.length === 0 ? [] : [heading(title, w), ...body, ""];

/**
 * The help of `command`. It is always painted: commander takes the colour out again where it does
 * not show (a pipe, `NO_COLOR`). Its width is the terminal's, 100 columns at most, as the report's.
 */
export const formatHelp = (command: Command, helper: Help): string => {
  const w = writer({
    color: true,
    width: Math.min(helper.helpWidth ?? 80, MAX_WIDTH),
  });

  const root = command.parent === null;

  const commandGroups = helper.groupItems(
    [...command.commands],
    helper.visibleCommands(command),
    (sub) => sub.helpGroup() || "Commands"
  );

  const optionGroups = helper.groupItems(
    [...command.options],
    helper.visibleOptions(command),
    (option) => option.helpGroupHeading ?? "Options"
  );

  // The root's commands come before its options: they are what someone looks for first.
  const groups: (readonly [string, Item[]])[] = [
    [
      "Arguments",
      helper
        .visibleArguments(command)
        .map((argument) => argumentItem(argument, w)),
    ],
    ...[...commandGroups].map(
      ([title, subs]) =>
        [title, subs.map((sub) => commandItem(sub, helper, w))] as const
    ),
    ...[...optionGroups].map(
      ([title, options]) =>
        [title, options.map((option) => optionItem(option, w))] as const
    ),
  ];

  // One column for the whole help, so its sections line up.
  const column =
    Math.max(
      0,
      ...groups.flatMap(([, items]) => items.map((item) => item.term.length))
    ) + 4;

  const examples = (EXAMPLES.get(command) ?? []).map(
    (run) => `  ${w.style("dim", "$")} ${run}`
  );

  return [
    `${w.style("bold", PRODUCT_NAME)} ${w.style("dim", VERSION)}${w.style("dim", " · ")}${root ? command.summary() : w.style("bold", command.name())}`,
    "",
    ...block(command.description(), "  ", w),
    "",
    ...section("Usage", [`  ${usageOf(command)}`], w),
    ...groups.flatMap(([title, items]) =>
      section(title, itemLines(items, column, w), w)
    ),
    ...section("Examples", examples, w),
    ...(root
      ? [
          `  Each command's options: ${w.style("cyan", `${commandPath(command)} <command> --help`)}`,
          "",
        ]
      : []),
    w.style(
      "dim",
      `Made by ${MAKER} (${MAKER_URL}). Docs and issues: ${REPOSITORY_URL}`
    ),
    "",
  ].join("\n");
};

/** Commander's suggestion after an unknown command or option: "(Did you mean audit?)". */
const SUGGESTION = /^\(Did you mean (?<what>[^\s?]{1,100})\?\)$/u;

/**
 * An error as the CLI's own lines show one: "✖ Unknown option '--bogus'." in red, then the lines
 * after its first, indented under it, such as commander's "Did you mean --crawl?". For commander's
 * errors and the CLI's own alike.
 */
export const errorText = (message: string, color: boolean): string => {
  const [first = "", ...rest] = terminalSafe(message.replace(/^error: /u, ""))
    .trimEnd()
    .split("\n");

  const lines = [paint(color, "red", `✖ ${sentence(first)}`)];

  for (const line of rest) {
    const what = SUGGESTION.exec(line.trim())?.groups?.what;

    lines.push(
      what === undefined
        ? `  ${line}`
        : `  Did you mean ${paint(color, "cyan", what)}?`
    );
  }

  return `${lines.join("\n")}\n`;
};

/**
 * What follows a usage error on a terminal: the usage, and the command for the whole help, so the
 * error stays in view. Piped, the whole help follows instead, which an agent reads to correct its
 * call. Commander writes this as it is, so it is painted for stderr here.
 */
export const usageHint = (command: Command, color: boolean): string =>
  [
    "",
    `  Usage  ${usageOf(command)}`,
    `  Help   ${paint(color, "cyan", `${commandPath(command)} --help`)}`,
  ].join("\n");
