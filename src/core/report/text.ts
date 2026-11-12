/**
 * The report for a person at a terminal (issue #65): the score and its band first, then the
 * findings worst first, each fix as `-` and `+` lines, info findings on one line each, and what to
 * run next. The caller decides on colour, links and width. This module never reads `process`, so it
 * runs wherever the core runs. Its layout is not a contract: scripts and agents read the JSON.
 */
import { MAKER, MAKER_URL, PRODUCT_NAME } from "../../brand.js";
import { VERSION } from "../../version.js";
import {
  CORE_VITALS,
  FIELD_LABELS,
  FIELD_METRICS,
  fieldBand,
  fieldValue,
  NO_FIELD_DATA_LABELS,
  sharePercent,
} from "../field-data.js";
import type { FieldBand, FieldMetricKey } from "../field-data.js";
import { AEO_PAGE_RULES } from "../rules/index.js";
import type {
  AeoAudit,
  AeoPageSummary,
  AiBotAccess,
  BaselineComparison,
  FieldData,
  FieldMetric,
  Finding,
  FixEdit,
  IssueRollup,
  PageAudit,
  Requirement,
  RuleMeta,
  Severity,
  SeverityCounts,
  SiteAudit,
  Audit,
} from "../types.js";
import { withoutControls } from "./controls.js";
import {
  ACTION_LABEL,
  band,
  CATEGORY_LABEL,
  countLabel,
  plural,
  PURPOSE_LABEL,
  SEVERITIES,
  TARGET_LABEL,
} from "./labels.js";
import type { Band } from "./labels.js";

export interface TextOptions {
  /** Colour and bold, as ANSI escape codes. Off by default. */
  color?: boolean;
  /** Rule ids as OSC 8 hyperlinks to their documentation. Off by default. */
  links?: boolean;
  /** The columns to wrap prose at: 80 by default, 40 at least. */
  width?: number;
  /** End with the `agentic-seo-check` commands to run next, as the CLI does. Off by default. */
  nextSteps?: boolean;
}

/** The edits shown for each finding; the Markdown and the JSON have all of them. */
const MAX_EDITS = 3;

/** The lines of code shown for each `current` and `code`. */
const MAX_CODE_LINES = 6;

/** The pages a site report lists, lowest score first. */
const MAX_PAGES = 10;

/** The cells of the score's bar. */
const BAR_CELLS = 20;

const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 40;

export type Style =
  | "bold"
  | "dim"
  | "red"
  | "yellow"
  | "green"
  | "cyan"
  | "blue";

/** Each style's ANSI code, and the code that ends it alone, so styles nest. */
const SGR: Record<Style, readonly [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39],
};

/** `text` in `style` when `color` is on, and as it is otherwise; the CLI's own lines use it too. */
export const paint = (color: boolean, style: Style, text: string): string =>
  color && text !== ""
    ? `\u001B[${SGR[style][0]}m${text}\u001B[${SGR[style][1]}m`
    : text;

const SEVERITY_STYLE: Record<Severity, Style> = {
  error: "red",
  warning: "yellow",
  info: "blue",
};

const BAND_STYLE: Record<Band, Style> = {
  good: "green",
  fair: "yellow",
  poor: "red",
};

const SYMBOL: Record<Severity, string> = {
  error: "✖",
  warning: "▲",
  info: "•",
};

const HEADING: Record<Severity, string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Info",
};

/** When a rule runs, for the rules that do not run on every audit. */
const REQUIREMENT: Record<Requirement, string> = {
  render: "Runs with --render.",
  lighthouse: "Runs with --lighthouse.",
  "field-data": "Runs with --field-data.",
  crawl: "Runs on a crawl or a directory.",
  keyword: "Runs with --keyword.",
  "ai-bots": "Runs with --ai-bots.",
};

/** The flag a rule needs to run, for the command that checks it alone. */
const REQUIRED_FLAG: Record<Requirement, string> = {
  render: " --render",
  lighthouse: " --lighthouse",
  "field-data": " --field-data",
  crawl: " --crawl",
  keyword: " --keyword <keyword>",
  "ai-bots": " --ai-bots",
};

const AEO_PAGE_RULE_IDS = new Set(AEO_PAGE_RULES.map((rule) => rule.meta.id));

/**
 * `text` without the characters that would let a page move the cursor, retitle the window or hide
 * text in the terminal, and with its tabs as spaces, so the report can count a line's width.
 * Everything this report prints goes through it: messages quote the page too.
 */
export const terminalSafe = (text: string): string =>
  withoutControls(text.replaceAll("\t", "  "));

/** What the report is written with: the options, settled. The CLI's other screens use it too. */
export interface Writer {
  style: (style: Style, text: string) => string;
  /** `text` as a link to `url`, when links are on and there is a URL. */
  link: (text: string, url: string | undefined) => string;
  width: number;
  nextSteps: boolean;
  /** The origin every URL of the report shares, which the report leaves out of them. */
  origin: string | null;
}

export const writer = (
  options: TextOptions,
  origin: string | null = null
): Writer => {
  const color = options.color === true;

  return {
    style: (style, text) => paint(color, style, text),
    link: (text, url) =>
      options.links === true && url
        ? `\u001B]8;;${terminalSafe(url)}\u001B\\${text}\u001B]8;;\u001B\\`
        : text,
    width: Math.max(MIN_WIDTH, Math.floor(options.width ?? DEFAULT_WIDTH)),
    nextSteps: options.nextSteps === true,
    origin,
  };
};

/**
 * The code points a terminal draws two columns wide: Hangul Jamo, CJK radicals, kana and
 * ideographs, Yi, Hangul syllables, CJK compatibility forms, full-width forms, and the CJK
 * extensions past the Basic Multilingual Plane.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x11_00, 0x11_5f],
  [0x2e_80, 0x30_3e],
  [0x30_41, 0x33_ff],
  [0x34_00, 0x4d_bf],
  [0x4e_00, 0x9f_ff],
  [0xa0_00, 0xa4_cf],
  [0xac_00, 0xd7_a3],
  [0xf9_00, 0xfa_ff],
  [0xfe_30, 0xfe_4f],
  [0xff_00, 0xff_60],
  [0xff_e0, 0xff_e6],
  [0x2_00_00, 0x3_ff_fd],
];

/** Emoji a terminal draws as emoji, two columns wide. ✖ and ▲ show as text, one column. */
const EMOJI = /\p{Emoji_Presentation}/u;

/** The variation selector that asks for a character's emoji style, and its two columns. */
const EMOJI_STYLE = String.fromCodePoint(0xfe_0f);

/** What a terminal draws no column for: marks and format characters on their own. */
const ZERO_WIDTH = /^[\p{M}\p{Cf}]+$/u;

/** Text a report holds nearly always: printable ASCII, one column per character. */
const PLAIN = /^[\u0020-\u007E]*$/u;

const isWide = (grapheme: string): boolean => {
  const code = grapheme.codePointAt(0) ?? 0;

  return (
    WIDE_RANGES.some(([from, to]) => code >= from && code <= to) ||
    EMOJI.test(grapheme) ||
    grapheme.includes(EMOJI_STYLE)
  );
};

let segmenter: Intl.Segmenter | undefined;

/** `text`'s characters as a reader sees them: an emoji with its modifiers, a letter with its accent. */
const graphemes = (text: string): string[] => {
  segmenter ??= new Intl.Segmenter();

  return Array.from(segmenter.segment(text), ({ segment }) => segment);
};

/** The columns one grapheme takes on a terminal: 2, 1 or none. */
const graphemeWidth = (grapheme: string): number => {
  if (isWide(grapheme)) {
    return 2;
  }

  return ZERO_WIDTH.test(grapheme) ? 0 : 1;
};

/**
 * The columns `text` takes on a terminal, which is its length only for plain text: a table's
 * frame lines up only when a title in Japanese or with an emoji counts as wide as it shows.
 */
export const columns = (text: string): number =>
  PLAIN.test(text)
    ? text.length
    : graphemes(text).reduce((sum, g) => sum + graphemeWidth(g), 0);

/** `text` in lines of at most `width` columns, broken at spaces; a longer word keeps a line of its own. */
export const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let line = "";
    let used = 0;

    for (const word of paragraph.split(" ")) {
      if (word === "") {
        continue;
      }

      const size = columns(word);

      if (line === "") {
        line = word;
        used = size;
      } else if (used + 1 + size <= width) {
        line += ` ${word}`;
        used += 1 + size;
      } else {
        lines.push(line);
        line = word;
        used = size;
      }
    }

    lines.push(line);
  }

  return lines;
};

/** `line` in pieces of at most `width` columns: a path or a word too long for a table's cell. */
const chop = (line: string, width: number): string[] => {
  if (columns(line) <= width) {
    return [line];
  }

  const pieces: string[] = [];
  let piece = "";
  let used = 0;

  for (const grapheme of graphemes(line)) {
    const size = graphemeWidth(grapheme);

    if (piece !== "" && used + size > width) {
      pieces.push(piece);
      piece = "";
      used = 0;
    }

    piece += grapheme;
    used += size;
  }

  pieces.push(piece);

  return pieces;
};

/** The fewest columns a table's last column wraps in beside the others: a short line of prose. */
const MIN_LAST = 30;

/** A column of a table: its header, and whether its cells sit to the right, as numbers do. */
interface Column {
  header: string;
  right?: boolean;
}

/** A cell of a table: its text, which sets its width, and how each of its lines is drawn. */
interface Cell {
  text: string;
  draw?: (line: string) => string;
}

/**
 * Rows under a header, in a rounded frame drawn dim. Every column but the last is as wide as its
 * widest cell; the last takes the room they leave, up to the width, and wraps, breaking a path
 * too long for it. When they leave it less than `MIN_LAST` columns, each of its cells goes on
 * the lines under its row instead, across the table.
 */
const table = (
  heads: readonly Column[],
  rows: readonly (readonly Cell[])[],
  w: Writer
): string[] => {
  const n = heads.length - 1;

  const header = heads.map((head): Cell => ({
    text: head.header,
    draw: (line) => w.style("dim", line),
  }));

  const cells = [header, ...rows].map((row) =>
    heads.map((_, i) => ({
      text: terminalSafe(row[i]?.text ?? ""),
      draw: row[i]?.draw,
    }))
  );

  const widths = heads.map((_, i) =>
    Math.max(...cells.map((row) => columns(row[i]?.text ?? "")))
  );

  // The columns before the last, each with the two spaces after it.
  const fixed = widths.slice(0, n).reduce((sum, width) => sum + width + 2, 0);
  const natural = widths[n] ?? 0;
  // The indent and the frame's sides, with a space inside each.
  const room = w.width - 6;
  const beside = fixed + Math.min(natural, MIN_LAST) <= room;

  const inner = beside
    ? fixed + Math.min(natural, room - fixed)
    : Math.max(fixed - 2, Math.min(room, natural + 2));

  const lastWidth = beside ? inner - fixed : inner - 2;

  const pad = (cell: Cell, line: string, width: number, right = false) => {
    const fill = " ".repeat(Math.max(0, width - columns(line)));
    const drawn = cell.draw ? cell.draw(line) : line;

    return right ? `${fill}${drawn}` : `${drawn}${fill}`;
  };

  const rowLines = (row: readonly Cell[]): string[] => {
    const lead = row
      .slice(0, n)
      .map((cell, i) => pad(cell, cell.text, widths[i] ?? 0, heads[i]?.right));

    const last = row[n] ?? { text: "" };

    const lines = wrap(last.text, lastWidth).flatMap((line) =>
      chop(line, lastWidth)
    );

    if (beside) {
      return lines.map(
        (line, i) =>
          `${i === 0 ? lead.map((text) => `${text}  `).join("") : " ".repeat(fixed)}${pad(last, line, lastWidth, heads[n]?.right)}`
      );
    }

    return [
      `${lead.join("  ")}${" ".repeat(Math.max(0, inner - fixed + 2))}`,
      ...lines
        .filter((line) => line !== "")
        .map((line) => `  ${pad(last, line, lastWidth)}`),
    ];
  };

  const side = w.style("dim", "│");
  const framed = (line: string) => `  ${side} ${line} ${side}`;

  const edge = (left: string, right: string) =>
    `  ${w.style("dim", `${left}${"─".repeat(inner + 2)}${right}`)}`;

  const [head = [], ...body] = cells.map(rowLines);

  return [
    edge("╭", "╮"),
    ...head.map(framed),
    edge("├", "┤"),
    ...body.flat().map(framed),
    edge("╰", "╯"),
  ];
};

/** Page text, made safe and wrapped under `indent`. */
export const block = (text: string, indent: string, w: Writer): string[] =>
  wrap(terminalSafe(text), w.width - indent.length).map(
    (line) => `${indent}${line}`
  );

/** "http://localhost/a" as "/a" when every URL of the report shares its origin. */
const pathOf = (url: string, origin: string | null): string => {
  if (origin === null || !URL.canParse(url)) {
    return url;
  }

  const parsed = new URL(url);

  return parsed.origin === origin ? `${parsed.pathname}${parsed.search}` : url;
};

/** The origin all of `urls` share, or null when they do not. */
const sharedOrigin = (urls: readonly string[]): string | null => {
  const origins = new Set(
    urls.map((url) => (URL.canParse(url) ? new URL(url).origin : url))
  );

  const [only] = origins;

  return origins.size === 1 && only !== undefined && URL.canParse(only)
    ? only
    : null;
};

/** The shortest rule a heading draws after itself; a heading with less room left draws none. */
const MIN_RULE = 3;

/**
 * "Errors (3) ──────────": a section's heading, in bold and in `style` when given, with a dim rule
 * to the width after it, so each section stands out when a long report scrolls past.
 */
export const heading = (
  text: string,
  w: Writer,
  { count, style }: { count?: number; style?: Style } = {}
): string => {
  const title = count === undefined ? text : `${text} (${count})`;
  const strong = w.style("bold", style ? w.style(style, title) : title);
  const rest = w.width - title.length - 1;

  return rest >= MIN_RULE
    ? `${strong} ${w.style("dim", "─".repeat(rest))}`
    : strong;
};

const titleLine = (kind: string, target: string, w: Writer): string =>
  `${w.style("bold", kind)}${w.style("dim", " · ")}${terminalSafe(target)}`;

/** What an audit's score is called: the SEO and the AEO audit score apart. */
const scoreLabel = (audit: Audit | AeoAudit): string =>
  audit.kind === "aeo" ? "AEO score" : "Score";

/** "72/100" and "fair", each in the band's colour, with `between` them: a space or the bar. */
const scoreText = (score: number, w: Writer, between = " "): string => {
  const b = band(score);

  return `${w.style("bold", w.style(BAND_STYLE[b], `${score}/100`))}${between}${w.style(BAND_STYLE[b], b)}`;
};

/** "Score 72/100  ━━━━━━━━━━━━━━──────  fair" */
const scoreLine = (audit: Audit | AeoAudit, w: Writer): string => {
  const filled = Math.round((audit.score / 100) * BAR_CELLS);

  const bar = `${w.style(BAND_STYLE[band(audit.score)], "━".repeat(filled))}${w.style("dim", "─".repeat(BAR_CELLS - filled))}`;

  return `  ${scoreLabel(audit)} ${scoreText(audit.score, w, `  ${bar}  `)}`;
};

/** "3 errors · 19 warnings · 13 info", each coloured when there are any. */
const countsText = (counts: SeverityCounts, w: Writer): string =>
  SEVERITIES.map((severity) =>
    counts[severity] > 0
      ? w.style(
          SEVERITY_STYLE[severity],
          countLabel(severity, counts[severity])
        )
      : w.style("dim", countLabel(severity, 0))
  ).join(w.style("dim", " · "));

const dotted = (parts: readonly string[], w: Writer): string =>
  parts.filter(Boolean).join(w.style("dim", " · "));

export type Field = readonly [label: string, value: string | null];

/** Labels and values in two columns; a value wraps under itself, and a missing one says so. */
export const fieldLines = (
  fields: readonly Field[],
  w: Writer,
  indent = "  "
): string[] => {
  const labelWidth = Math.max(...fields.map(([label]) => label.length));
  const valueIndent = " ".repeat(indent.length + labelWidth + 2);

  return fields.flatMap(([label, value]) => {
    const head = `${indent}${label.padEnd(labelWidth)}  `;

    if (value === null) {
      return [`${head}${w.style("dim", "missing")}`];
    }

    const [first = "", ...rest] = wrap(
      terminalSafe(value),
      w.width - valueIndent.length
    );

    return [`${head}${first}`, ...rest.map((line) => `${valueIndent}${line}`)];
  });
};

/** `{{slots}}` in code stand out from the code around them. */
const SLOT = /(?<slot>\{\{[^{}\n]{0,200}\}\})/u;

const codeLines = (
  sign: "-" | "+",
  text: string,
  w: Writer,
  indent: string
): string[] => {
  const lines = terminalSafe(text).split("\n");
  const shown = lines.slice(0, MAX_CODE_LINES);
  const style: Style = sign === "-" ? "red" : "green";

  const out = shown.map((line) => {
    const parts = line
      .split(SLOT)
      .map((part, i) =>
        i % 2 === 1
          ? w.style("bold", w.style("cyan", part))
          : w.style(style, part)
      );

    return `${indent}${w.style(style, sign)} ${parts.join("")}`;
  });

  if (lines.length > shown.length) {
    out.push(
      `${indent}  ${w.style("dim", `… ${plural(lines.length - shown.length, "more line")}`)}`
    );
  }

  return out;
};

const editLines = (edit: FixEdit, w: Writer, indent: string): string[] => {
  const where = [
    `${ACTION_LABEL[edit.action]} in ${TARGET_LABEL[edit.in]}`,
    edit.url ? ` of ${terminalSafe(pathOf(edit.url, w.origin))}` : "",
    edit.at ? `, at ${w.style("cyan", terminalSafe(edit.at))}` : "",
  ].join("");

  return [
    `${indent}${w.style("dim", "→")} ${where}`,
    ...(edit.current === undefined
      ? []
      : codeLines("-", edit.current, w, `${indent}  `)),
    ...(edit.code === undefined
      ? []
      : codeLines("+", edit.code, w, `${indent}  `)),
    ...(edit.write
      ? block(edit.write, `${indent}  `, w).map((line) => w.style("dim", line))
      : []),
  ];
};

/**
 * The symbol and the message, wrapped, with the rule id at the end of its last line when it fits.
 * `strong` makes the message bold, for a finding whose fix follows.
 */
const findingHead = (
  finding: Pick<Finding, "severity" | "message" | "rule" | "docs">,
  w: Writer,
  indent: string,
  { strong = false }: { strong?: boolean } = {}
): string[] => {
  const inner = `${indent}  `;
  const room = w.width - inner.length;
  const id = terminalSafe(finding.rule);
  const lines = wrap(terminalSafe(finding.message), room);
  const last = lines.length - 1;
  const fits = columns(lines[last] ?? "") + 2 + columns(id) <= room;
  const idText = w.link(w.style("dim", id), finding.docs);

  const symbol = w.style(
    SEVERITY_STYLE[finding.severity],
    SYMBOL[finding.severity]
  );

  const out = lines.map(
    (line, i) =>
      `${i === 0 ? `${indent}${symbol} ` : inner}${strong ? w.style("bold", line) : line}${i === last && fits ? `  ${idText}` : ""}`
  );

  return fits ? out : [...out, `${inner}${idText}`];
};

/** An error or a warning in full: the message, what to do and the edits. */
const findingLines = (finding: Finding, w: Writer): string[] => {
  const edits = finding.fix ?? [];
  const inner = "    ";

  return [
    ...findingHead(finding, w, "  ", { strong: true }),
    ...block(finding.recommendation, inner, w),
    ...edits.slice(0, MAX_EDITS).flatMap((edit) => editLines(edit, w, inner)),
    ...(edits.length > MAX_EDITS
      ? [
          `${inner}${w.style("dim", `… and ${plural(edits.length - MAX_EDITS, "more edit")}`)}`,
        ]
      : []),
    "",
  ];
};

/** The findings by severity: errors and warnings in full, info on one line each. */
const findingSections = (findings: readonly Finding[], w: Writer): string[] => {
  if (findings.length === 0) {
    return [`  ${w.style("green", "✓ No issues found.")}`, ""];
  }

  return SEVERITIES.flatMap((severity) => {
    const group = findings.filter((f) => f.severity === severity);

    if (group.length === 0) {
      return [];
    }

    const body =
      severity === "info"
        ? [...group.flatMap((f) => findingHead(f, w, "  ")), ""]
        : group.flatMap((f) => findingLines(f, w));

    return [
      heading(HEADING[severity], w, {
        count: group.length,
        style: SEVERITY_STYLE[severity],
      }),
      "",
      ...body,
    ];
  });
};

/** A row for each rule the pages broke, worst first. */
const issueLines = (issues: readonly IssueRollup[], w: Writer): string[] => {
  if (issues.length === 0) {
    return [];
  }

  return [
    heading("On the pages, by rule", w, { count: issues.length }),
    "",
    ...table(
      [
        { header: "" },
        { header: "Pages", right: true },
        { header: "Rule" },
        { header: "Finding" },
      ],
      issues.map((issue) => [
        {
          text: SYMBOL[issue.severity],
          draw: (line) => w.style(SEVERITY_STYLE[issue.severity], line),
        },
        { text: String(issue.pages) },
        { text: issue.rule, draw: (line) => w.style("dim", line) },
        { text: issue.message },
      ]),
      w
    ),
    "",
  ];
};

interface PageRow {
  url: string;
  score: number;
  counts: SeverityCounts;
}

/** The pages with the lowest scores, and how the rest score. */
const pageRows = (
  title: string,
  pages: readonly PageRow[],
  w: Writer
): string[] => {
  if (pages.length === 0) {
    return [];
  }

  const sorted = pages.toSorted(
    (a, b) =>
      a.score - b.score ||
      b.counts.error - a.counts.error ||
      b.counts.warning - a.counts.warning ||
      a.url.localeCompare(b.url)
  );

  const shown = sorted.slice(0, MAX_PAGES);
  const rest = sorted.slice(MAX_PAGES);

  const countWidth = Math.max(
    ...shown.flatMap((p) => SEVERITIES.map((s) => String(p.counts[s]).length))
  );

  const count = (p: PageRow, severity: Severity): Cell => ({
    text: `${SYMBOL[severity]} ${String(p.counts[severity]).padStart(countWidth)}`,
    draw: (line) =>
      w.style(p.counts[severity] > 0 ? SEVERITY_STYLE[severity] : "dim", line),
  });

  const lines = table(
    [
      { header: "Score", right: true },
      ...SEVERITIES.map((s) => ({ header: HEADING[s], right: true })),
      { header: "Page" },
    ],
    shown.map((p) => [
      {
        text: String(p.score),
        draw: (line) => w.style(BAND_STYLE[band(p.score)], line),
      },
      ...SEVERITIES.map((s) => count(p, s)),
      { text: pathOf(p.url, w.origin) },
    ]),
    w
  );

  const [lowest] = rest;

  if (lowest) {
    lines.push(
      w.style(
        "dim",
        `  … and ${plural(rest.length, "more page")}, each scoring ${lowest.score} or more`
      )
    );
  }

  return [
    heading(rest.length > 0 ? `${title}, lowest scores first` : title, w, {
      count: pages.length,
    }),
    "",
    ...lines,
    "",
  ];
};

const baselineLines = (b: BaselineComparison, w: Writer): string[] => {
  const lines = [
    heading("Re-check", w),
    "",
    `  ${dotted(
      [
        w.style("green", `${b.fixed.length} fixed`),
        `${b.open.length} still open`,
        b.new.length > 0 ? w.style("red", `${b.new.length} new`) : "0 new",
        b.notChecked > 0 ? w.style("dim", `${b.notChecked} not checked`) : "",
      ],
      w
    )}`,
  ];

  for (const f of b.fixed) {
    lines.push(
      ...block(
        `✓ ${f.message ?? f.rule}${f.url ? ` (${f.url})` : ""}`,
        "  ",
        w
      ).map((line) => w.style("green", line))
    );
  }

  for (const id of b.new) {
    lines.push(`  ${w.style("red", "+")} ${terminalSafe(id)}`);
  }

  return [...lines, ""];
};

/** The first finding worth a look, for the hint at `agentic-seo-check rules --rule`. */
const firstRule = (
  findings: readonly { rule: string; severity: Severity }[]
): string | undefined =>
  SEVERITIES.flatMap((s) => findings.filter((f) => f.severity === s))[0]?.rule;

/** "What a rule checks: <command>", with the command on a line of its own when both do not fit. */
export const commandLines = (label: string, run: string, w: Writer): string[] =>
  2 + label.length + 1 + run.length <= w.width
    ? [`  ${label} ${w.style("cyan", run)}`]
    : [`  ${label}`, `    ${w.style("cyan", run)}`];

/** "the error", "the 3 errors" */
const the = (severity: "error" | "warning", count: number): string =>
  count === 1 ? `the ${severity}` : `the ${countLabel(severity, count)}`;

/** "Score 72/100 fair · 3 errors · 19 warnings · 13 info" */
const verdictLine = (audit: Audit | AeoAudit, w: Writer): string =>
  `${scoreLabel(audit)} ${scoreText(audit.score, w)}${w.style("dim", " · ")}${countsText(audit.counts, w)}`;

/**
 * The verdict again, what to fix first, and the commands to run next. A terminal shows the end of
 * what was printed, so this is what is in view once the report has scrolled past. `rule` is the
 * one `agentic-seo-check rules --rule` is suggested for; `detail` says what `-o report.md` adds.
 */
const summaryLines = (
  audit: Audit | AeoAudit,
  rule: string | undefined,
  detail: string,
  w: Writer
): string[] => {
  const { counts } = audit;

  const advice = (): string => {
    if (counts.error > 0) {
      return counts.warning > 0
        ? `Fix ${the("error", counts.error)} first, then ${the("warning", counts.warning)}.`
        : `Fix ${the("error", counts.error)}.`;
    }

    if (counts.warning > 0) {
      return `Fix ${the("warning", counts.warning)}; the info findings can wait.`;
    }

    return counts.info > 0
      ? "Nothing to fix: the info findings are suggestions."
      : "Nothing to fix.";
  };

  const lines = [
    heading("Summary", w),
    "",
    `  ${verdictLine(audit, w)}`,
    "",
    `  ${advice()}`,
  ];

  if (w.nextSteps) {
    lines.push(
      ...commandLines(`${detail}: run again with`, "-o report.md", w),
      ...(rule
        ? commandLines(
            "What a rule checks:",
            `agentic-seo-check rules --rule ${terminalSafe(rule)}`,
            w
          )
        : [])
    );
  }

  return [...lines, ""];
};

/** One line, however narrow the terminal, as the Markdown report's. */
const footer = (w: Writer): string =>
  w.style(
    "dim",
    `Audited with ${PRODUCT_NAME} ${VERSION}, made by ${MAKER} (${MAKER_URL})`
  );

/** "850 ms" under a second, "12.4 s" from there. */
const duration = (milliseconds: number): string =>
  milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(1)} s`;

const yesNo = (value: boolean): string => (value ? "yes" : "no");

const listOr = (values: readonly string[], none: string): string =>
  values.length > 0 ? values.join(", ") : none;

const ms = (value: number | null): string | null =>
  value === null ? null : `${Math.round(value).toLocaleString("en-US")} ms`;

const performanceLines = (audit: PageAudit, w: Writer): string[] => {
  if (!audit.performance) {
    return [];
  }

  const m = audit.performance.metrics;

  return [
    heading(`Lighthouse (${audit.performance.formFactor})`, w),
    "",
    ...fieldLines(
      [
        [
          "Performance",
          m.performanceScore === null ? null : String(m.performanceScore),
        ],
        ["SEO", m.seoScore === null ? null : String(m.seoScore)],
        ["LCP", ms(m.lcpMs)],
        ["CLS", m.cls === null ? null : m.cls.toFixed(3)],
        ["TBT", ms(m.tbtMs)],
        ["FCP", ms(m.fcpMs)],
        ["Speed Index", ms(m.speedIndexMs)],
        ["TTFB", ms(m.ttfbMs)],
      ],
      w
    ),
    "",
  ];
};

const FIELD_BAND_STYLE: Record<FieldBand, Style> = {
  good: "green",
  "needs improvement": "yellow",
  poor: "red",
};

/** "2.1 s · good · 82% of visits good", or that the record has too few visits for the metric. */
const fieldMetricText = (
  key: FieldMetricKey,
  metric: FieldMetric | null,
  w: Writer
): string => {
  if (!metric) {
    return w.style("dim", "too few visits");
  }

  const rating = fieldBand(key, metric.p75);

  return dotted(
    [
      w.style(FIELD_BAND_STYLE[rating], fieldValue(key, metric.p75)),
      w.style(FIELD_BAND_STYLE[rating], rating),
      `${sharePercent(metric.good)} of visits good`,
    ],
    w
  );
};

/** Whose record it is and the 28 days it covers. */
const fieldRecordText = (field: FieldData): string =>
  `${field.source === "url" ? "this URL" : "the origin, as this URL has too few visits"}, ${field.period.firstDate} to ${field.period.lastDate}`;

const FIELD_HEADING = "Field data (Chrome UX Report, phones)";

/** Real-user Core Web Vitals at the 75th percentile, or why the audit has none. */
const fieldDataLines = (audit: PageAudit, w: Writer): string[] => {
  const field = audit.fieldData;

  if (!field) {
    return [];
  }

  if (field.source === null) {
    return [
      heading(FIELD_HEADING, w),
      "",
      ...block(field.message, "  ", w),
      "",
    ];
  }

  return [
    heading(FIELD_HEADING, w),
    "",
    ...fieldLines(
      [
        ["Record", fieldRecordText(field)],
        ...FIELD_METRICS.map((key): Field => [
          `${FIELD_LABELS[key]} (p75)`,
          fieldMetricText(key, field[key], w),
        ]),
      ],
      w
    ),
    "",
  ];
};

/** The Core Web Vitals of the pages a crawl asked the Chrome UX Report for. */
const siteFieldDataLines = (audit: SiteAudit, w: Writer): string[] => {
  const asked = audit.pages.filter((p) => p.fieldData);

  if (asked.length === 0) {
    return [];
  }

  const dim = (line: string) => w.style("dim", line);

  const vital = (metric: FieldMetric | null, key: FieldMetricKey): Cell =>
    metric
      ? {
          text: fieldValue(key, metric.p75),
          draw: (line) =>
            w.style(FIELD_BAND_STYLE[fieldBand(key, metric.p75)], line),
        }
      : { text: "–", draw: dim };

  return [
    heading(FIELD_HEADING, w, { count: asked.length }),
    "",
    ...table(
      [
        ...CORE_VITALS.map((key) => ({
          header: FIELD_LABELS[key],
          right: true,
        })),
        { header: "Record" },
        { header: "Page" },
      ],
      asked.flatMap(({ url, fieldData: field }) => {
        if (!field) {
          return [];
        }

        const record: Cell =
          field.source === null
            ? { text: NO_FIELD_DATA_LABELS[field.reason], draw: dim }
            : { text: field.source === "url" ? "URL" : "origin" };

        return [
          [
            ...CORE_VITALS.map((key) =>
              vital(field.source === null ? null : field[key], key)
            ),
            record,
            { text: pathOf(url, w.origin) },
          ],
        ];
      }),
      w
    ),
    "",
  ];
};

const shown = (value: string | number | null): string =>
  value === null || value === "" ? "missing" : String(value);

/** One value when the server's HTML and the rendered DOM agree, else "server → rendered". */
const compared = (
  raw: string | number | null,
  rendered: string | number | null
): string =>
  raw === rendered ? shown(raw) : `${shown(raw)} → ${shown(rendered)}`;

const renderingLines = (audit: PageAudit, w: Writer): string[] => {
  if (!audit.rendering) {
    return [];
  }

  const { raw, rendered } = audit.rendering;

  return [
    heading("Server HTML → rendered DOM", w),
    "",
    ...fieldLines(
      [
        ["Title", compared(raw.title, rendered.title)],
        [
          "Meta description",
          compared(raw.metaDescription, rendered.metaDescription),
        ],
        ["Canonical", compared(raw.canonical, rendered.canonical)],
        ["Robots", compared(raw.robots.join(", "), rendered.robots.join(", "))],
        ["H1 count", compared(raw.h1Count, rendered.h1Count)],
        ["Words", compared(raw.wordCount, rendered.wordCount)],
        ["Internal links", compared(raw.internalLinks, rendered.internalLinks)],
        [
          "Structured data",
          compared(raw.structuredDataCount, rendered.structuredDataCount),
        ],
      ],
      w
    ),
    "",
  ];
};

const pageFacts = (audit: PageAudit): Field[] => {
  const s = audit.summary;
  const og = Object.keys(s.openGraph).map((k) => `og:${k}`);

  return [
    [
      "Title",
      s.title ? `${s.title} (${plural(s.titleLength, "character")})` : null,
    ],
    ["Meta description", s.metaDescription],
    ["Canonical", s.canonical],
    [
      "Indexable",
      s.indexable
        ? "yes"
        : `no${s.robots.length > 0 ? `: ${s.robots.join(", ")}` : ""}`,
    ],
    ["Language", s.lang],
    ["H1", s.h1.length > 0 ? s.h1.join(" / ") : null],
    ["Words", s.wordCount.toLocaleString("en-US")],
    [
      "Images",
      `${s.images.total}${s.images.missingAlt > 0 ? `, ${s.images.missingAlt} without alt` : ""}`,
    ],
    ["Links", `${s.links.internal} internal, ${s.links.external} external`],
    ["Structured data", listOr(s.structuredDataTypes, "none")],
    ["Open Graph", listOr(og, "none")],
  ];
};

const pageText = (audit: PageAudit, w: Writer): string[] => {
  const { response } = audit;

  return [
    titleLine("SEO audit", audit.url, w),
    "",
    scoreLine(audit, w),
    `  ${dotted(
      [
        countsText(audit.counts, w),
        response?.status ? `HTTP ${response.status}` : "",
        response?.timeMs ? `${response.timeMs} ms` : "",
      ],
      w
    )}`,
    "",
    ...fieldLines(pageFacts(audit), w),
    "",
    ...fieldDataLines(audit, w),
    ...performanceLines(audit, w),
    ...renderingLines(audit, w),
    ...(audit.baseline ? baselineLines(audit.baseline, w) : []),
    ...findingSections(audit.findings, w),
    ...summaryLines(
      audit,
      firstRule(audit.findings),
      "Every fix in full, with its evidence",
      w
    ),
  ];
};

const robotsTxtValue = (audit: SiteAudit): string => {
  if (!audit.robotsTxt) {
    return "not checked";
  }

  if (audit.robotsTxt.found) {
    return `found, ${plural(audit.robotsTxt.sitemaps.length, "sitemap")} declared`;
  }

  return `not found (HTTP ${audit.robotsTxt.status ?? "n/a"})`;
};

const sitemapValue = (audit: SiteAudit): string => {
  const { sources, urlCount, errors } = audit.sitemaps;

  if (sources.length === 0) {
    return "none found";
  }

  return `${plural(sources.length, "file")}, ${plural(urlCount, "URL")}${errors.length > 0 ? `, ${plural(errors.length, "error")}` : ""}`;
};

/** Findings without a page of their own: errors and warnings in full, info on one line. */
const siteFindingLines = (
  title: string,
  findings: readonly Finding[],
  w: Writer
): string[] => {
  if (findings.length === 0) {
    return [];
  }

  const sorted = SEVERITIES.flatMap((s) =>
    findings.filter((f) => f.severity === s)
  );

  return [
    heading(title, w, { count: findings.length }),
    "",
    ...sorted.flatMap((f) =>
      f.severity === "info" ? findingHead(f, w, "  ") : findingLines(f, w)
    ),
    ...(sorted.at(-1)?.severity === "info" ? [""] : []),
  ];
};

const siteText = (audit: SiteAudit, w: Writer): string[] => {
  const { crawl } = audit;

  return [
    titleLine("SEO site audit", audit.target, w),
    "",
    scoreLine(audit, w),
    `  ${countsText(audit.counts, w)}`,
    `  ${dotted(
      [
        `${plural(crawl.pagesCrawled, "page")} audited, ${crawl.pagesDiscovered} found${crawl.hitPageLimit ? ` (the limit of ${crawl.maxPages} was reached)` : ""}`,
        duration(crawl.durationMs),
      ],
      w
    )}`,
    "",
    ...fieldLines(
      [
        ["robots.txt", robotsTxtValue(audit)],
        ["Sitemaps", sitemapValue(audit)],
      ],
      w
    ),
    "",
    ...(audit.baseline ? baselineLines(audit.baseline, w) : []),
    ...siteFindingLines("Site-wide", audit.siteFindings, w),
    ...issueLines(audit.issues, w),
    ...siteFieldDataLines(audit, w),
    ...pageRows("Pages", audit.pages, w),
    ...(audit.siteFindings.length === 0 && audit.issues.length === 0
      ? [`  ${w.style("green", "✓ No issues found.")}`, ""]
      : []),
    ...summaryLines(
      audit,
      firstRule([...audit.siteFindings, ...audit.issues]),
      "Every page's fixes",
      w
    ),
  ];
};

/** A bot robots.txt or the server keeps out, on the page or on some of the pages. */
const kept = (bot: AiBotAccess): boolean =>
  !bot.allowed || bot.blockedPages > 0 || bot.probe?.blocked === true;

/** What robots.txt says of a bot it keeps out: of the page, or of some of the pages. */
const robotsVerdict = (bot: AiBotAccess, pages: number, w: Writer): string => {
  if (!bot.allowed) {
    return w.style("red", "blocked");
  }

  return bot.blockedPages > 0
    ? w.style("yellow", `blocked on ${bot.blockedPages} of ${pages} pages`)
    : "";
};

/** "✗ GPTBot (OpenAI) blocked · server: HTTP 403" */
const keptText = (bot: AiBotAccess, pages: number, w: Writer): string => {
  const server = bot.probe?.blocked
    ? w.style("red", `server: ${terminalSafe(bot.probe.reason ?? "blocked")}`)
    : "";

  return `${w.style(bot.allowed ? "yellow" : "red", "✗")} ${terminalSafe(bot.name)} ${w.style("dim", `(${terminalSafe(bot.operator)})`)} ${dotted([robotsVerdict(bot, pages, w), server], w)}`;
};

/**
 * One purpose's bots: those let in on one line, with their names after it, then a line for each
 * bot that is kept out, so a blocked bot stands out among two dozen.
 */
const crawlerGroup = (
  label: string,
  group: readonly AiBotAccess[],
  pages: number,
  w: Writer
): string[] => {
  const indent = " ".repeat(label.length + 4);
  const fine = group.filter((bot) => !kept(bot));
  const lines: string[] = [];

  if (fine.length > 0) {
    const count =
      fine.length === group.length ? `all ${fine.length}` : String(fine.length);

    const [first = "", ...rest] = wrap(
      `${count} allowed: ${fine.map((bot) => terminalSafe(bot.name)).join(", ")}`,
      w.width - indent.length - 2
    );

    lines.push(
      `${w.style("green", "✓")} ${first}`,
      ...rest.map((line) => `  ${w.style("dim", line)}`)
    );
  }

  for (const bot of group.filter(kept)) {
    lines.push(keptText(bot, pages, w));
  }

  return lines.map((line, i) => `${i === 0 ? `  ${label}  ` : indent}${line}`);
};

const llmsTxtValue = (audit: AeoAudit): string => {
  const llms = audit.llmsTxt;

  if (!llms) {
    return "not checked";
  }

  if (llms.status === "found") {
    return `found${llms.title ? `, "${llms.title}"` : ""}, ${plural(llms.links, "link")}`;
  }

  return llms.status === "invalid"
    ? `invalid: ${llms.problems.join("; ")}`
    : "not found";
};

const crawlerLines = (audit: AeoAudit, w: Writer): string[] => {
  const { crawlers } = audit;

  if (!crawlers) {
    return [];
  }

  const { pages } = audit.summary;
  const allowed = crawlers.bots.filter((bot) => bot.allowed).length;

  const purposes = (["search", "answer", "training"] as const).filter(
    (purpose) => crawlers.bots.some((bot) => bot.purpose === purpose)
  );

  const labelWidth = Math.max(
    ...purposes.map((purpose) => PURPOSE_LABEL[purpose].length)
  );

  const groups = purposes.flatMap((purpose) =>
    crawlerGroup(
      PURPOSE_LABEL[purpose].padEnd(labelWidth),
      crawlers.bots.filter((bot) => bot.purpose === purpose),
      pages,
      w
    )
  );

  const signals: Field[] = crawlers.contentSignals.map((signal) => [
    "Content-Signal",
    `${signal.userAgents.join(", ") || "(no user agent)"}${signal.path ? ` on ${signal.path}` : ""}: ${
      Object.entries(signal.signals)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(empty)"
    }`,
  ]);

  return [
    heading("AI crawlers", w),
    "",
    ...block(
      `robots.txt ${crawlers.status}${crawlers.httpStatus ? ` (HTTP ${crawlers.httpStatus})` : ""} · ${allowed} of ${crawlers.bots.length} may fetch ${audit.pages ? "the start page" : "this page"}`,
      "  ",
      w
    ).map((line) => w.style("dim", line)),
    "",
    ...groups,
    "",
    ...fieldLines(
      [
        ["Training preference", crawlers.trainingPreference],
        ["llms.txt", llmsTxtValue(audit)],
        ...signals,
      ],
      w
    ),
    ...(crawlers.probeBaseline
      ? block(
          `"server" is what the server answered each bot's User-Agent, sent from this machine; the audit's own request got HTTP ${crawlers.probeBaseline.status ?? "—"}.`,
          "  ",
          w
        ).map((line) => w.style("dim", line))
      : []),
    "",
  ];
};

const aeoFacts = (s: AeoPageSummary): Field[] => [
  ["Indexable", yesNo(s.indexable)],
  ["Google snippets and AI Overviews", s.googleSnippets],
  ["Copilot answers", s.copilotAnswers],
  ["Words in the HTML", s.wordCount.toLocaleString("en-US")],
  ["Question headings", String(s.questions)],
  ["Structured data", listOr(s.structuredDataTypes, "none")],
  ["Author", s.author],
  ["Published", s.datePublished],
  ["Modified", s.dateModified],
];

const aeoText = (audit: AeoAudit, w: Writer): string[] => {
  const site = audit.pages !== undefined;
  const { page } = audit.summary;

  // A site's page findings are in `issues`, by rule; the findings left are the site's own.
  const findings = site
    ? audit.findings.filter((f) => !AEO_PAGE_RULE_IDS.has(f.rule))
    : audit.findings;

  return [
    titleLine("AEO audit", site ? audit.target : audit.url, w),
    "",
    scoreLine(audit, w),
    `  ${dotted([countsText(audit.counts, w), `${plural(audit.summary.pages, "page")} audited`], w)}`,
    "",
    ...crawlerLines(audit, w),
    ...(page
      ? [
          heading(site ? "Start page" : "Page", w),
          "",
          ...fieldLines(aeoFacts(page), w),
          "",
        ]
      : []),
    ...(audit.baseline ? baselineLines(audit.baseline, w) : []),
    ...(site
      ? [
          ...siteFindingLines("Site-wide", findings, w),
          ...issueLines(audit.issues ?? [], w),
          ...pageRows("Pages", audit.pages ?? [], w),
          ...(findings.length === 0 && (audit.issues ?? []).length === 0
            ? [`  ${w.style("green", "✓ No issues found.")}`, ""]
            : []),
        ]
      : findingSections(findings, w)),
    ...summaryLines(
      audit,
      firstRule([...findings, ...(audit.issues ?? [])]),
      site ? "Every page's fixes" : "Every fix in full, with its evidence",
      w
    ),
  ];
};

const finish = (lines: readonly string[], w: Writer): string =>
  `${[...lines, footer(w)].join("\n")}\n`;

/** The SEO audit of a page or a site, for a person at a terminal. */
export const renderText = (audit: Audit, options: TextOptions = {}): string => {
  const w = writer(
    options,
    sharedOrigin(
      audit.kind === "page" ? [audit.url] : audit.pages.map((p) => p.url)
    )
  );

  return finish(
    audit.kind === "page" ? pageText(audit, w) : siteText(audit, w),
    w
  );
};

/** The AEO audit of a page or a site, for a person at a terminal. */
export const renderAeoText = (
  audit: AeoAudit,
  options: TextOptions = {}
): string => {
  const w = writer(
    options,
    sharedOrigin(audit.pages ? audit.pages.map((p) => p.url) : [audit.url])
  );

  return finish(aeoText(audit, w), w);
};

/**
 * "Score 72/100 fair · 3 errors · 19 warnings · 13 info" on its own, for the CLI to say what a
 * report it wrote to a file found.
 */
export const renderVerdict = (
  audit: Audit | AeoAudit,
  options: TextOptions = {}
): string => verdictLine(audit, writer(options, null));

/**
 * One rule in full: what it checks, what to do, when it runs and where it is documented, and for
 * the CLI, the command that checks it alone.
 */
const ruleDetail = (rule: RuleMeta, w: Writer): string[] => [
  `${w.style("bold", w.link(rule.id, rule.docs))}${w.style("dim", " · ")}${w.style(SEVERITY_STYLE[rule.severity], rule.severity)}${w.style("dim", ` · ${CATEGORY_LABEL[rule.category]}`)}`,
  "",
  ...block(rule.description, "  ", w),
  "",
  ...fieldLines(
    [
      ["What to do", rule.recommendation],
      ...(rule.requires
        ? ([["When", REQUIREMENT[rule.requires]]] as const)
        : []),
      ...(rule.docs ? ([["Docs", rule.docs]] as const) : []),
    ],
    w
  ),
  ...(w.nextSteps
    ? [
        "",
        ...commandLines(
          "Check only this rule:",
          `agentic-seo-check ${rule.category === "aeo" ? "aeo" : "audit"} <target> --rule ${rule.id}${rule.requires ? REQUIRED_FLAG[rule.requires] : ""}`,
          w
        ),
      ]
    : []),
];

/** The rules, by category, one line each; or one rule in full. */
export const renderRulesText = (
  rules: readonly RuleMeta[],
  options: TextOptions = {}
): string => {
  const w = writer(options, null);

  if (rules.length === 0) {
    return "No rule matches.\n";
  }

  const [only] = rules;

  if (rules.length === 1 && only) {
    return `${ruleDetail(only, w).join("\n")}\n`;
  }

  const groups = new Map<RuleMeta["category"], RuleMeta[]>();

  for (const rule of rules) {
    groups.set(rule.category, [...(groups.get(rule.category) ?? []), rule]);
  }

  const lines: string[] = [];

  for (const [category, group] of groups) {
    // A table for each category, so one long id elsewhere leaves this one's descriptions the room.
    // Below 30 columns of description, each description goes under its rule instead.
    lines.push(
      heading(CATEGORY_LABEL[category], w, { count: group.length }),
      "",
      ...table(
        [{ header: "Rule" }, { header: "Severity" }, { header: "Checks" }],
        group.map((rule) => [
          { text: rule.id, draw: (line) => w.link(line, rule.docs) },
          {
            text: rule.severity,
            draw: (line) => w.style(SEVERITY_STYLE[rule.severity], line),
          },
          {
            text: `${rule.description}${rule.requires ? ` ${REQUIREMENT[rule.requires]}` : ""}`,
          },
        ]),
        w
      ),
      ""
    );
  }

  lines.push(
    w.nextSteps
      ? `${plural(rules.length, "rule")}. One in full: ${w.style("cyan", "agentic-seo-check rules --rule <id>")}`
      : plural(rules.length, "rule")
  );

  return `${lines.join("\n")}\n`;
};
