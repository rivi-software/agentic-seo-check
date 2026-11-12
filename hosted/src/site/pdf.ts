import {
  MAKER,
  MAKER_URL,
  MARK_ON_DARK_SVG,
  MARK_SVG,
  PRODUCT_NAME,
  REPOSITORY_URL,
  WEBSITE_URL,
} from "../../../src/brand.js";
/**
 * A report as a PDF (issue #157): the document that the report's "Download PDF" button hands to
 * pdfmake in the visitor's browser, built here from the same data as the HTML report
 * (report-data.ts). It is data only: pdfmake's document definition without the functions pdfmake
 * allows. What every report shares (the page, the styles, the table layouts as numbers, the
 * cover's ground and the foot of the pages) is PDF_DESIGN, which the script that draws the PDF
 * carries (pdf-script.ts); a report's data carries its own content and its running head only.
 * Nothing goes to the server.
 *
 * The document is A4 in RIVI Software's look: a cover on the website's ink ground with both
 * scores, then the contents and a summary, each audit's findings with their edits, the AI
 * crawlers (and for a site its homepage and its pages), and what the report is.
 *
 * The audited site's text is only ever a run of text here: never an image, never a URL pdfmake
 * fetches, and never markup, which pdfmake has none of. A link is http or https only. The fonts
 * draw Latin, Latin Extended and Cyrillic; a run of characters they lack becomes one "?" on grey
 * (pdf-glyphs.ts), as pdfkit would draw nothing.
 */
import type { SiteAudits } from "../../../src/core/aeo/audit.js";
import { HOSTED_LIMITS } from "../../../src/core/hosted.js";
import {
  ACTION_LABEL,
  band,
  countLabel,
  plural,
  PURPOSE_LABEL,
  SEVERITIES,
  TARGET_LABEL,
} from "../../../src/core/report/labels.js";
import type { Band } from "../../../src/core/report/labels.js";
import type {
  AeoAudit,
  AiBotPurpose,
  Finding,
  FixEdit,
  IssueRollup,
  PageAudit,
  Severity,
  SeverityCounts,
  SiteAudit,
} from "../../../src/core/types.js";
import { ORIGIN as MCP_ORIGIN } from "../limits.js";
import { MISSING_GLYPHS } from "./pdf-glyphs.js";
import {
  aeoFactRows,
  auditedOn,
  BAND_LABEL,
  categoryGroups,
  crawlFactRows,
  fieldFactRows,
  headOf,
  homeFindings,
  seoFactRows,
  severitiesOf,
  statusTone,
  urgentEntries,
} from "./report-data.js";
import type {
  Entry,
  Fact,
  Group,
  Part,
  ReportParts,
  Tone,
} from "./report-data.js";

/**
 * pdfmake's content as JSON, which is all it is here: a text, or something pdfmake lays out (a
 * stack, columns, a table…) with its properties. The page's script adds the functions.
 */
export type PdfNode = string | number | boolean | PdfNode[] | PdfObject;

export interface PdfObject {
  // Undefined as TypeScript reads an object literal among others with more properties; JSON
  // leaves it out.
  [property: string]: PdfNode | undefined;
}

/** The text of a text node: a string, or runs of text with styles of their own. */
type Runs = string | PdfNode[];

/** A table layout as data, which the script that draws the PDF turns into pdfmake's functions. */
export interface TableLayout {
  /** The lines round the table: [width, colour]. */
  frame?: [number, string];
  /** The lines between rows. */
  rows?: [number, string];
  /** The lines between columns. */
  cols?: [number, string];
  /** A bar down the left edge, in place of the frame there. */
  bar?: [number, string];
  /** Each cell's padding: left, top, right, bottom. */
  padding: [number, number, number, number];
}

/** What a report's data carries of its PDF: its own part of the document, and its running head. */
export interface PdfReport {
  /** pdfmake's document definition less PDF_DESIGN's: the report's metadata and content. */
  document: PdfObject;
  /** The head of every page after the cover, which names the site. */
  header: PdfNode;
}

/**
 * The fonts the PDF is set in, by the names its styles use, as files the website serves under
 * PDF_FONT_DIR (pdf-assets.ts). pdfmake needs static instances, and TrueType files, as fontkit
 * fails to cut a subset of these fonts out of WOFF2.
 */
export const PDF_FONTS = {
  Geist: { normal: "geist-400.ttf", bold: "geist-600.ttf" },
  GeistMedium: { normal: "geist-500.ttf", bold: "geist-600.ttf" },
  GeistMono: { normal: "geist-mono-400.ttf", bold: "geist-mono-400.ttf" },
  Display: {
    normal: "bricolage-grotesque-600.ttf",
    bold: "bricolage-grotesque-600.ttf",
  },
} as const;

export const PDF_FONT_DIR = "/fonts/pdf/";

/** A4 in points, and the margins of every page after the cover. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 54, top: 72, right: 54, bottom: 64 };
const WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

/**
 * The colours: the website's ink for the cover (ui/style.ts), and its print tokens for paper,
 * with the soft tints of each severity worked out on white.
 */
const INK = {
  ground: "#08090a",
  raised: "#111214",
  line: "#25272b",
  text: "#f7f8f8",
  body: "#d0d6e0",
  muted: "#8a8f98",
  signal: "#3be08a",
  signalText: "#5ee89f",
};

const PAPER = {
  text: "#0b0c0e",
  body: "#2f343b",
  muted: "#555b65",
  faint: "#6a707a",
  line: "#e2e4e7",
  lineStrong: "#c9ccd1",
  wash: "#f3f4f5",
  inset: "#f8f9fa",
  signal: "#139a55",
  signalText: "#0b7a42",
};

const SEVERITY_INK: Record<Severity, string> = {
  error: "#f0675f",
  warning: "#f2a33a",
  info: "#6aa6f5",
};

/** Each severity on paper: its colour, its text's darker one, and its tint. */
const SEVERITY_PAPER: Record<
  Severity,
  { main: string; text: string; soft: string }
> = {
  error: { main: "#d23b31", text: "#b0261c", soft: "#fbe7e5" },
  warning: { main: "#c97c00", text: "#8f5600", soft: "#f8eedb" },
  info: { main: "#2f6fc6", text: "#1d58a8", soft: "#e5edf9" },
};

const PAPER_DOTS: Record<Severity, string> = {
  error: SEVERITY_PAPER.error.main,
  warning: SEVERITY_PAPER.warning.main,
  info: SEVERITY_PAPER.info.main,
};

/** Each band's colour on the cover, its tint there, and its colour on paper. */
const BAND_COLOUR: Record<
  Band,
  { ink: string; inkSoft: string; paper: string }
> = {
  good: { ink: INK.signal, inkSoft: "#183026", paper: PAPER.signal },
  fair: {
    ink: SEVERITY_INK.warning,
    inkSoft: "#31271b",
    paper: SEVERITY_PAPER.warning.main,
  },
  poor: {
    ink: SEVERITY_INK.error,
    inkSoft: "#311f20",
    paper: SEVERITY_PAPER.error.main,
  },
};

const TONE_COLOUR: Record<NonNullable<Tone>, string> = {
  good: PAPER.signal,
  warn: SEVERITY_PAPER.warning.main,
  bad: SEVERITY_PAPER.error.main,
};

const TONE_INK: Record<NonNullable<Tone>, string> = {
  good: INK.signal,
  warn: SEVERITY_INK.warning,
  bad: SEVERITY_INK.error,
};

/** An edit's "Now" (the code it removes) and "Write" (the code it adds). */
const DIFF = {
  del: {
    frame: "#f1cdc9",
    label: "#fbe3e0",
    ground: "#fdf3f2",
    text: SEVERITY_PAPER.error.text,
  },
  add: {
    frame: "#bfe3cd",
    label: "#dcf1e4",
    ground: "#f1f9f4",
    text: PAPER.signalText,
  },
};

const LAYOUTS = {
  ...Object.fromEntries(
    SEVERITIES.map((severity): [string, TableLayout] => [
      `finding-${severity}`,
      { bar: [2.5, SEVERITY_PAPER[severity].main], padding: [12, 3, 0, 3] },
    ])
  ),
  ...Object.fromEntries(
    (["del", "add"] as const).map((kind): [string, TableLayout] => [
      `diff-${kind}`,
      { frame: [0.6, DIFF[kind].frame], padding: [8, 4, 8, 4] },
    ])
  ),
  rows: { rows: [0.5, PAPER.line], padding: [0, 6, 10, 6] },
  table: {
    frame: [0.5, PAPER.line],
    rows: [0.5, PAPER.line],
    padding: [8, 5, 8, 5],
  },
  tiles: {
    frame: [0.5, PAPER.line],
    rows: [0.5, PAPER.line],
    cols: [0.5, PAPER.line],
    padding: [9, 7, 9, 8],
  },
  "ink-card": {
    frame: [0.75, INK.line],
    cols: [0.75, INK.line],
    padding: [16, 16, 16, 16],
  },
  "ink-tiles": {
    frame: [0.75, INK.line],
    cols: [0.75, INK.line],
    padding: [12, 9, 12, 10],
  },
} satisfies Record<string, TableLayout>;

const STYLES: PdfObject = {
  h1: {
    font: "Display",
    fontSize: 26,
    lineHeight: 1.05,
    color: PAPER.text,
  },
  h2: {
    font: "GeistMedium",
    fontSize: 12.5,
    lineHeight: 1.2,
    color: PAPER.text,
  },
  h3: { font: "GeistMedium", fontSize: 10.5, color: PAPER.text },
  kicker: {
    font: "GeistMono",
    fontSize: 7.5,
    characterSpacing: 1.1,
  },
  lede: { fontSize: 10.5, lineHeight: 1.45, color: PAPER.muted },
  label: {
    bold: true,
    fontSize: 6.5,
    characterSpacing: 0.8,
    color: PAPER.faint,
  },
  small: { fontSize: 8, color: PAPER.muted },
  msg: {
    font: "GeistMedium",
    fontSize: 9.75,
    lineHeight: 1.3,
    color: PAPER.text,
  },
  mono: { font: "GeistMono", fontSize: 7.5, color: PAPER.muted },
  code: {
    font: "GeistMono",
    fontSize: 7.5,
    lineHeight: 1.3,
    color: PAPER.text,
    preserveLeadingSpaces: true,
  },
  link: { color: PAPER.signalText },
  step: { fontSize: 10, color: PAPER.muted, lineHeight: 1 },
  note: { fontSize: 8.5, color: PAPER.muted },
  missing: { background: PAPER.line, color: PAPER.muted },
  toc: { font: "GeistMedium", fontSize: 10.5, color: PAPER.text },
  tocNumber: { fontSize: 10, color: PAPER.muted },
  tocSub: { fontSize: 9, color: PAPER.muted },
  tocSubNumber: { fontSize: 9, color: PAPER.faint },
  ...Object.fromEntries(
    SEVERITIES.map((severity) => [
      `tag-${severity}`,
      {
        bold: true,
        fontSize: 6.5,
        characterSpacing: 0.6,
        color: SEVERITY_PAPER[severity].text,
        background: SEVERITY_PAPER[severity].soft,
      },
    ])
  ),
};

/**
 * Characters nobody sees, which the PDF leaves out: controls and format characters (a soft
 * hyphen, zero widths, direction marks). Each line is cleaned on its own, which keeps its breaks.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

const MISSING_MARK = { text: "?", style: "missing" };

/**
 * Text from the audited site, as runs pdfmake draws with the PDF's fonts: what they lack becomes
 * "?" on grey, one for each run of such characters, and a tab two spaces.
 */
export const quote = (text: string): Runs => {
  const clean = text
    .replaceAll("\t", "  ")
    .split(/\r?\n/u)
    .map((line) => line.replaceAll(INVISIBLE, ""))
    .join("\n");

  const runs: PdfNode[] = [];
  let last = 0;

  for (const match of clean.matchAll(MISSING_GLYPHS)) {
    if (match.index > last) {
      runs.push(clean.slice(last, match.index));
    }

    runs.push(MISSING_MARK);
    last = match.index + match[0].length;
  }

  if (runs.length === 0) {
    return clean;
  }

  if (last < clean.length) {
    runs.push(clean.slice(last));
  }

  return runs;
};

/** A link to `url` when it is http or https, so a page's text never becomes another kind of link. */
const linkTo = (url: string): { link?: string } =>
  /^https?:\/\//iu.test(url) ? { link: url } : {};

/** Text from the audited site in the PDF's mono face. */
const mono = (text: string, colour: string = PAPER.text): PdfObject => ({
  text: quote(text),
  style: "mono",
  color: colour,
});

/** The kicker above a heading: a short green bar, then words in capitals. */
const kicker = (
  text: string,
  colour: string = PAPER.signalText
): PdfObject => ({
  columns: [
    {
      width: 18,
      canvas: [
        {
          type: "rect",
          x: 0,
          y: 3.25,
          w: 12,
          h: 2.5,
          r: 1.25,
          color: INK.signal,
        },
      ],
    },
    { width: "*", text: text.toUpperCase(), style: "kicker", color: colour },
  ],
});

/** A coloured dot, to put before a count or a value, on the same line as it. */
const dot = (colour: string): PdfObject => ({
  text: "● ",
  color: colour,
});

/** The counts of each severity that occurs (or of all three), each after its dot. */
const tallyRuns = (
  counts: SeverityCounts,
  colours: Record<Severity, string>,
  all = false
): PdfNode[] =>
  SEVERITIES.filter((severity) => all || counts[severity] > 0).flatMap(
    (severity, index) => [
      ...(index > 0 ? ["    "] : []),
      dot(colours[severity]),
      // A count and its word stay on one line.
      countLabel(severity, counts[severity]).replace(" ", " "),
    ]
  );

const countsOf = (severities: Severity[]): SeverityCounts => ({
  error: severities.filter((s) => s === "error").length,
  warning: severities.filter((s) => s === "warning").length,
  info: severities.filter((s) => s === "info").length,
});

/** "2 errors, 7 warnings and 3 info", or "no findings". */
const countsSentence = (counts: SeverityCounts): string => {
  const parts = SEVERITIES.flatMap((severity) =>
    counts[severity] > 0 ? [countLabel(severity, counts[severity])] : []
  );

  if (parts.length === 0) {
    return "no findings";
  }

  return parts.length === 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
};

/** A severity as a tag in capitals on its tint. */
const tag = (severity: Severity): PdfObject => ({
  text: ` ${severity.toUpperCase()} `,
  style: `tag-${severity}`,
});

/** A score out of 100 as a ring that fills to it, in its band's colour on ink or on paper. */
const ringSvg = (score: number, size: number, ink: boolean): string => {
  const colours = BAND_COLOUR[band(score)];
  const colour = ink ? colours.ink : colours.paper;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="none" stroke="${colour}" stroke-opacity="0.2" stroke-width="5"/>${
    score > 0
      ? `<circle cx="32" cy="32" r="28" fill="none" stroke="${colour}" stroke-width="5" stroke-linecap="round" pathLength="100" stroke-dasharray="${score} 100" transform="rotate(-90 32 32)"/>`
      : ""
  }</svg>`;
};

/** The ring with the score in its middle. */
const ring = (score: number, size: number, ink: boolean): PdfObject => {
  const fontSize = Math.round(size * 0.3);

  return {
    width: size,
    stack: [
      { svg: ringSvg(score, size, ink), width: size },
      {
        text: String(score),
        alignment: "center",
        font: "GeistMedium",
        fontSize,
        color: ink ? INK.text : PAPER.text,
        relativePosition: { x: 0, y: -(size / 2 + fontSize * 0.62) },
      },
    ],
  };
};

/** A bar split by the counts of each severity, as the website draws one under a score. */
const severityBar = (counts: SeverityCounts, width: number): PdfObject => {
  const total = counts.error + counts.warning + counts.info;

  const segments: PdfNode[] = [
    {
      type: "rect",
      x: 0,
      y: 0,
      w: width,
      h: 4,
      r: 2,
      color: total === 0 ? PAPER.signal : PAPER.wash,
    },
  ];

  let x = 0;

  for (const severity of SEVERITIES) {
    const w = (counts[severity] / Math.max(total, 1)) * width;

    if (w > 0) {
      segments.push({
        type: "rect",
        x,
        y: 0,
        w: Math.max(w - 1.5, 1),
        h: 4,
        r: 1,
        color: SEVERITY_PAPER[severity].main,
      });
      x += w;
    }
  }

  return { canvas: segments, width };
};

/** A thin rule across the page. */
const rule = (
  colour: string = PAPER.line,
  margin: number[] = [0, 0, 0, 0]
): PdfObject => ({
  canvas: [
    {
      type: "line",
      x1: 0,
      y1: 0,
      x2: WIDTH,
      y2: 0,
      lineWidth: 0.5,
      lineColor: colour,
    },
  ],
  margin,
});

/**
 * A heading that keeps with what follows it: the script that draws the PDF breaks the page before
 * one that would end a page (pdf-script.ts). Every node of a heading carries the level, so that
 * the nodes after it on its page count only when they are not the heading's own.
 */
const keep = (node: PdfObject): PdfObject => ({ ...node, headlineLevel: 1 });

const subheading = (text: string, counts?: SeverityCounts): PdfObject =>
  keep({
    text: [
      { text, style: "h2" },
      ...(counts ? ["     ", ...tallyRuns(counts, PAPER_DOTS)] : []),
    ],
    style: "small",
    margin: [0, 18, 0, 9],
  });

/** A section's opening on a page of its own: a kicker, its title (in the contents) and a lede. */
const sectionHead = (
  id: string,
  kick: string,
  title: string,
  lede?: Runs
): PdfObject => ({
  pageBreak: "before",
  stack: [
    kicker(kick),
    {
      text: title,
      style: "h1",
      id,
      tocItem: true,
      outline: true,
      margin: [0, 8, 0, lede ? 6 : 16],
    },
    ...(lede ? [{ text: lede, style: "lede", margin: [0, 0, 0, 16] }] : []),
  ],
});

/** Facts as a two-column list: what a page says of itself. */
const factList = (rows: Fact[]): PdfNode[] => {
  const body = rows.flatMap(([label, value]) =>
    value === null || value === ""
      ? []
      : [
          [
            { text: label, style: "small" },
            { text: quote(value), color: PAPER.text },
          ],
        ]
  );

  return body.length === 0
    ? []
    : [
        {
          table: { widths: [92, "*"], body },
          layout: "rows",
          margin: [0, 0, 0, 10],
        },
      ];
};

/** How many facts a row of tiles holds. */
const TILE_COLUMNS = 4;

/** Facts as tiles, each value after its tone's dot. */
const factTiles = (rows: Fact[]): PdfNode[] => {
  const cells: PdfNode[] = rows.flatMap(([label, value, tone]) =>
    value === null || value === ""
      ? []
      : [
          {
            stack: [
              { text: label.toUpperCase(), style: "label" },
              {
                text: [...(tone ? [dot(TONE_COLOUR[tone])] : []), quote(value)],
                font: "GeistMedium",
                fontSize: 9.5,
                color: PAPER.text,
                margin: [0, 4, 0, 0],
              },
            ],
          },
        ]
  );

  if (cells.length === 0) {
    return [];
  }

  const body: PdfNode[][] = [];

  for (let i = 0; i < cells.length; i += TILE_COLUMNS) {
    const row = cells.slice(i, i + TILE_COLUMNS);

    while (row.length < TILE_COLUMNS) {
      row.push("");
    }

    body.push(row);
  }

  return [
    {
      table: {
        widths: Array.from({ length: TILE_COLUMNS }, () => "*"),
        body,
        dontBreakRows: true,
      },
      layout: "tiles",
      margin: [0, 0, 0, 10],
    },
  ];
};

/** "What to change", and the text that says it. */
const todo = (recommendation: string): PdfObject => ({
  stack: [
    { text: "WHAT TO CHANGE", style: "label" },
    { text: quote(recommendation), margin: [0, 3, 0, 0] },
  ],
  margin: [0, 6, 0, 0],
});

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

/** An edit's "Now" or "Write" block: its label on a tint, the code under it. */
const diff = (kind: "del" | "add", label: string, code: string): PdfObject => ({
  table: {
    widths: ["*"],
    body: [
      [
        {
          text: label.toUpperCase(),
          style: "label",
          color: DIFF[kind].text,
          fillColor: DIFF[kind].label,
        },
      ],
      [{ text: quote(code), style: "code", fillColor: DIFF[kind].ground }],
    ],
  },
  layout: `diff-${kind}`,
  margin: [18, 5, 0, 0],
});

/** One edit of a fix: where it goes, the code it replaces, the code to write, and what to fill in. */
const editNode = (edit: FixEdit, index: number): PdfObject => ({
  stack: [
    {
      columns: [
        { width: 18, text: CIRCLED[index] ?? `${index + 1}.`, style: "step" },
        {
          width: "*",
          text: [
            `${ACTION_LABEL[edit.action]} in ${TARGET_LABEL[edit.in]}`,
            ...(edit.at ? [" at ", mono(edit.at)] : []),
            ...(edit.url ? [" of ", mono(edit.url)] : []),
          ],
          margin: [0, 0.5, 0, 0],
        },
      ],
    },
    ...(edit.current ? [diff("del", "Now", edit.current)] : []),
    ...(edit.code
      ? [diff("add", edit.action === "add" ? "Add" : "Write", edit.code)]
      : []),
    ...(edit.write
      ? [
          {
            text: [{ text: "Fill in: ", bold: true }, quote(edit.write)],
            style: "note",
            margin: [18, 5, 0, 0],
          },
        ]
      : []),
  ],
  margin: [0, 7, 0, 0],
});

/** A finding's documentation as a line with its link, when it has an http or https one. */
const docsNode = (docs: string | undefined): PdfNode[] => {
  const target = docs ? linkTo(docs).link : undefined;

  return target
    ? [
        {
          text: [
            { text: "DOCUMENTATION   ", style: "label" },
            { text: quote(target), style: "link", link: target },
          ],
          margin: [0, 8, 0, 0],
        },
      ]
    : [];
};

/** A finding's rows after its head: what to change, where, its fix and its documentation. */
const findingRows = (finding: Finding): PdfNode[] => [
  todo(finding.recommendation),
  ...(finding.selector
    ? [
        {
          text: [{ text: "WHERE   ", style: "label" }, mono(finding.selector)],
          margin: [0, 6, 0, 0],
        },
      ]
    : []),
  ...(finding.fix && finding.fix.length > 0
    ? [
        { text: "THE FIX", style: "label", margin: [0, 8, 0, 0] },
        ...finding.fix.map(editNode),
      ]
    : []),
  ...docsNode(finding.docs),
];

/** A rule's findings on a site's pages: what to change, and the pages it is on. */
const issueRows = (issue: IssueRollup): PdfNode[] => [
  todo(issue.recommendation),
  {
    stack: [
      {
        text:
          issue.pages > issue.examples.length
            ? `PAGES, THE FIRST ${issue.examples.length}`
            : "PAGES",
        style: "label",
      },
      ...issue.examples.map((url) => ({
        ...mono(url, PAPER.signalText),
        margin: [0, 3, 0, 0],
        ...linkTo(url),
      })),
    ],
    margin: [0, 8, 0, 0],
  },
];

/**
 * An entry's message, and under it its rule, the audit it is from and how many pages have it.
 * `target` is what the message is: the entry's anchor (`id`), or a link to it.
 */
const entryHead = (
  entry: Entry,
  target: "id" | "linkToDestination",
  audit?: string
): PdfObject => {
  const head = headOf(entry);

  const meta = [
    head.rule,
    ...(audit ? [audit] : []),
    ...(head.pages === undefined ? [] : [plural(head.pages, "page")]),
  ];

  return {
    stack: [
      { text: quote(head.message), style: "msg", [target]: entry.id },
      { text: meta.join("  ·  "), style: "mono", margin: [0, 2, 0, 0] },
    ],
  };
};

/**
 * An entry as a table with a bar of its severity's colour down its left: its head, then its rows.
 * The head is the table's header row, which keeps with the row after it and comes again at the
 * top of the next page when an entry runs on.
 */
const entryNode = (entry: Entry): PdfObject => {
  const { severity } = headOf(entry);

  const rows =
    entry.kind === "finding"
      ? findingRows(entry.finding)
      : issueRows(entry.issue);

  const headCell: PdfObject = {
    columns: [
      { width: "auto", text: [tag(severity)], margin: [0, 2, 0, 0] },
      { width: "*", ...entryHead(entry, "id") },
    ],
    columnGap: 8,
  };

  return {
    table: {
      widths: ["*"],
      headerRows: 1,
      keepWithHeaderRows: 1,
      body: [[headCell], ...rows.map((row) => [row])],
    },
    layout: `finding-${severity}`,
    margin: [0, 0, 0, 12],
  };
};

/**
 * A group under its heading, with its counts, and every entry. With `contents`, the heading is a
 * line of the contents too, under its section's.
 */
const groupNodes = (
  group: Group,
  parent: string,
  contents: boolean
): PdfNode[] => {
  const label: PdfObject = keep({
    width: "auto",
    text: group.label,
    style: "h3",
    id: group.id,
    outline: true,
    outlineParentId: parent,
  });

  if (contents) {
    label.tocItem = true;
    label.tocStyle = "tocSub";
    label.tocNumberStyle = "tocSubNumber";
    label.tocMargin = [14, 2, 0, 2];
  }

  return [
    keep(rule(PAPER.line, [0, 6, 0, 0])),
    keep({
      columns: [
        label,
        keep({
          width: "*",
          text: tallyRuns(countsOf(severitiesOf([group])), PAPER_DOTS),
          style: "small",
          margin: [12, 1.5, 0, 0],
        }),
      ],
      margin: [0, 9, 0, 10],
    }),
    ...group.entries.map(entryNode),
  ];
};

/** A line that says there is nothing to fix. */
const allClear = (text: string): PdfObject => ({
  text: [dot(PAPER.signal), text],
  color: PAPER.text,
  margin: [0, 4, 0, 0],
});

/** A findings section's parts, or a line that says there is nothing to fix. */
const partsNodes = (
  parts: Part[],
  parent: string,
  empty: string,
  contents = true
): PdfNode[] => {
  const shown = parts.filter((part) => part.groups.length > 0);

  if (shown.length === 0) {
    return [allClear(empty)];
  }

  return shown.flatMap((part) => [
    ...(part.title
      ? [keep({ text: part.title, style: "h2", margin: [0, 18, 0, 8] })]
      : []),
    ...part.groups.flatMap((group) => groupNodes(group, parent, contents)),
  ]);
};

/** One audit's findings section: its opening, then its parts. */
const findingsSection = (
  audit: "seo" | "aeo",
  lede: string,
  parts: Part[],
  empty: string
): PdfNode[] => [
  sectionHead(
    audit,
    audit === "seo" ? "SEO  ·  Search engines" : "AEO  ·  AI answer engines",
    audit === "seo" ? "SEO findings" : "AEO findings",
    lede
  ),
  ...partsNodes(parts, audit, empty),
];

/** The most entries the summary lists to fix first. */
const MAX_FIX_FIRST = 8;

/** The summary's list of what to fix first, each linked to its entry, with the page it is on. */
const fixFirstNodes = (parts: ReportParts): PdfNode[] => {
  const urgent = urgentEntries(parts);

  if (urgent.length === 0) {
    return [
      subheading("Fix first"),
      allClear("No errors and no warnings: nothing that has to be fixed."),
    ];
  }

  const rows = urgent.slice(0, MAX_FIX_FIRST).map(({ audit, entry }) => [
    { text: [tag(headOf(entry).severity)], margin: [0, 2, 0, 0] },
    entryHead(entry, "linkToDestination", audit),
    {
      // A page reference resolves alone in its text, not after other words.
      text: [{ pageReference: entry.id }],
      linkToDestination: entry.id,
      style: "small",
      alignment: "right",
      margin: [0, 1, 0, 0],
    },
  ]);

  const more = urgent.length - rows.length;

  return [
    subheading(
      "Fix first",
      countsOf(urgent.map(({ entry }) => headOf(entry).severity))
    ),
    {
      table: { widths: ["auto", "*", 30], body: rows, dontBreakRows: true },
      layout: "rows",
    },
    ...(more > 0
      ? [
          {
            text: `And ${more} more in the SEO and AEO findings.`,
            style: "small",
            margin: [0, 8, 0, 0],
          },
        ]
      : []),
  ];
};

/** A count in an index row: the number in its severity's colour, or a faint dash for none. */
const countCell = (count: number, severity: Severity): PdfObject => ({
  text: count > 0 ? String(count) : "–",
  color: count > 0 ? SEVERITY_PAPER[severity].text : PAPER.lineStrong,
  font: "GeistMedium",
  alignment: "right",
});

/** A row of the index that spans it: an audit's name, or a part's title. */
const spanRow = (cell: PdfObject): PdfNode[] => [
  { ...cell, colSpan: 5 },
  "",
  "",
  "",
  "",
];

/** One audit's rows of the index: its name, then each group with its counts and page. */
const indexRows = (name: string, audit: Part[]): PdfNode[][] => {
  const shown = audit.filter((part) => part.groups.length > 0);

  const title = spanRow({
    text: name,
    font: "GeistMedium",
    color: PAPER.text,
    fillColor: PAPER.inset,
  });

  if (shown.length === 0) {
    return [title, spanRow({ text: "No findings", style: "small" })];
  }

  return [
    title,
    ...shown.flatMap((part) => [
      ...(part.title ? [spanRow({ text: part.title, style: "small" })] : []),
      ...part.groups.map((group) => {
        const counts = countsOf(severitiesOf([group]));

        return [
          {
            text: group.label,
            color: PAPER.text,
            linkToDestination: group.id,
            margin: [part.title ? 10 : 0, 0, 0, 0],
          },
          ...SEVERITIES.map((severity) =>
            countCell(counts[severity], severity)
          ),
          {
            text: [{ pageReference: group.id }],
            linkToDestination: group.id,
            style: "small",
            alignment: "right",
          },
        ];
      }),
    ]),
  ];
};

/** The words over the index's count columns. */
const COUNT_HEADINGS: Record<Severity, string> = {
  error: "ERRORS",
  warning: "WARNINGS",
  info: "INFO",
};

/** The summary's index of both audits' groups, with their counts and the page each starts on. */
const indexNodes = (parts: ReportParts): PdfNode[] => [
  subheading("Findings by section"),
  {
    table: {
      headerRows: 1,
      widths: ["*", 52, 60, 40, 34],
      body: [
        [
          { text: "SECTION", style: "label" },
          ...SEVERITIES.map((severity) => ({
            text: [dot(PAPER_DOTS[severity]), COUNT_HEADINGS[severity]],
            style: "label",
            alignment: "right",
          })),
          { text: "PAGE", style: "label", alignment: "right" },
        ],
        ...indexRows("SEO: search engines", parts.seo),
        ...indexRows("AEO: AI answer engines", parts.aeo),
      ],
      dontBreakRows: true,
    },
    layout: "table",
  },
];

interface Scored {
  score: number;
  counts: SeverityCounts;
}

/** One audit's score in the summary's table: its ring, its name, its band, counts and bar. */
const scoreRow = (
  name: string,
  subtitle: string,
  { score, counts }: Scored
): PdfNode[] => {
  const grade = band(score);

  return [
    ring(score, 40, false),
    {
      stack: [
        { text: name, font: "GeistMedium", fontSize: 11, color: PAPER.text },
        { text: subtitle, style: "small", margin: [0, 1, 0, 0] },
      ],
      margin: [0, 7, 0, 0],
    },
    {
      text: BAND_LABEL[grade].toUpperCase(),
      bold: true,
      fontSize: 7.5,
      characterSpacing: 0.8,
      color: BAND_COLOUR[grade].paper,
      margin: [0, 15, 0, 0],
    },
    {
      stack: [
        { text: tallyRuns(counts, PAPER_DOTS, true), style: "small" },
        { ...severityBar(counts, 150), margin: [0, 6, 0, 0] },
      ],
      margin: [0, 10, 0, 0],
    },
  ];
};

const scoresTable = (seo: Scored, aeo: Scored): PdfObject => ({
  table: {
    widths: [40, "*", 40, 160],
    body: [
      scoreRow("SEO", "Search engines", seo),
      scoreRow("AEO", "AI answer engines", aeo),
    ],
    dontBreakRows: true,
  },
  layout: "rows",
  margin: [0, 4, 0, 0],
});

/** A score on the cover: its ring, its name, its band and its counts. */
const coverScore = (
  name: string,
  subtitle: string,
  { score, counts }: Scored
): PdfObject => {
  const grade = band(score);

  return {
    fillColor: INK.raised,
    columns: [
      ring(score, 74, true),
      {
        width: "*",
        stack: [
          { text: name, font: "Display", fontSize: 17, color: INK.text },
          {
            text: subtitle,
            fontSize: 8.5,
            color: INK.muted,
            margin: [0, 1, 0, 0],
          },
          {
            text: [
              {
                text: `  ${BAND_LABEL[grade].toUpperCase()}  `,
                color: BAND_COLOUR[grade].ink,
                background: BAND_COLOUR[grade].inkSoft,
              },
            ],
            bold: true,
            fontSize: 7,
            characterSpacing: 0.8,
            margin: [0, 9, 0, 0],
          },
          {
            text: tallyRuns(counts, SEVERITY_INK, true),
            fontSize: 7.5,
            color: INK.body,
            margin: [0, 9, 0, 0],
          },
        ],
        margin: [14, 6, 0, 0],
      },
    ],
  };
};

/** The hostname as large as its length allows on the cover. */
const hostSize = (host: string): number => {
  if (host.length <= 18) {
    return 46;
  }

  if (host.length <= 26) {
    return 36;
  }

  return host.length <= 36 ? 28 : 22;
};

/** A fact on the cover: its label in capitals, its value after its tone's dot. */
const coverTile = ([label, value, tone]: Fact): PdfObject => ({
  fillColor: INK.raised,
  stack: [
    {
      text: label.toUpperCase(),
      font: "GeistMono",
      fontSize: 6.5,
      characterSpacing: 0.8,
      color: INK.muted,
    },
    {
      text: [...(tone ? [dot(TONE_INK[tone])] : []), quote(value ?? "")],
      font: "GeistMedium",
      fontSize: 10,
      color: INK.text,
      margin: [0, 5, 0, 0],
    },
  ],
});

/** What the cover shows: what was audited, when, both scores, and up to four facts. */
interface Cover {
  url: string;
  auditedAt: string;
  seo: Scored;
  aeo: Scored;
  facts: Fact[];
  /** How many pages a crawl audited; none for a page's audit. */
  pages?: number;
}

/** The cover's lockup: the mark, the tool's name and its maker, and the website. */
const LOCKUP: PdfObject = {
  columns: [
    { svg: MARK_ON_DARK_SVG, width: 26 },
    {
      width: "*",
      stack: [
        {
          text: PRODUCT_NAME,
          font: "Display",
          fontSize: 13.5,
          color: INK.text,
          lineHeight: 1,
        },
        {
          text: `by ${MAKER}`,
          fontSize: 7.5,
          color: INK.muted,
          margin: [0, 2, 0, 0],
        },
      ],
      margin: [9, 1, 0, 0],
    },
    {
      width: "auto",
      text: new URL(WEBSITE_URL).host,
      link: WEBSITE_URL,
      font: "GeistMono",
      fontSize: 7,
      color: INK.muted,
      margin: [0, 9, 0, 0],
    },
  ],
};

/** The cover, on the ink ground the script draws behind it. */
const coverNodes = (cover: Cover): PdfNode[] => {
  const host = new URL(cover.url).hostname;

  const tiles = cover.facts
    .filter(([, value]) => value !== null && value !== "")
    .slice(0, TILE_COLUMNS);

  return [
    LOCKUP,
    {
      ...kicker(
        cover.pages === undefined ? "Page audit report" : "Site audit report",
        INK.signalText
      ),
      margin: [0, 176, 0, 14],
    },
    {
      text: quote(host),
      font: "Display",
      fontSize: hostSize(host),
      lineHeight: 1,
      color: INK.text,
    },
    {
      text: quote(cover.url),
      font: "GeistMono",
      fontSize: 8.5,
      color: INK.muted,
      margin: [0, 14, 0, 0],
      ...linkTo(cover.url),
    },
    {
      text: [
        `Audited on ${auditedOn(cover.auditedAt)}`,
        ...(cover.pages === undefined
          ? []
          : [`  ·  ${plural(cover.pages, "page")} crawled`]),
      ],
      fontSize: 9.5,
      color: INK.body,
      margin: [0, 6, 0, 0],
    },
    {
      table: {
        widths: ["*", "*"],
        body: [
          [
            coverScore("SEO", "Search engines", cover.seo),
            coverScore("AEO", "AI answer engines", cover.aeo),
          ],
        ],
      },
      layout: "ink-card",
      margin: [0, 44, 0, 0],
    },
    ...(tiles.length > 0
      ? [
          {
            table: {
              widths: tiles.map(() => "*"),
              body: [tiles.map(coverTile)],
            },
            layout: "ink-tiles",
            margin: [0, 10, 0, 0],
          },
        ]
      : []),
  ];
};

/**
 * The cover's ground: the ink, a grid of dots that fades out from the top (a gradient of the ink
 * over it, since pdfkit draws no SVG masks), a green glow from the top, and one behind the scores.
 */
const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE.width}" height="${PAGE.height}" viewBox="0 0 ${PAGE.width} ${PAGE.height}"><defs><pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="0.75" fill="#ffffff" fill-opacity="0.16"/></pattern><radialGradient id="fade" cx="0.5" cy="0" r="0.62"><stop offset="0" stop-color="${INK.ground}" stop-opacity="0"/><stop offset="1" stop-color="${INK.ground}" stop-opacity="1"/></radialGradient><radialGradient id="glow" cx="0.5" cy="0" r="0.7"><stop offset="0" stop-color="${INK.signal}" stop-opacity="0.2"/><stop offset="1" stop-color="${INK.signal}" stop-opacity="0"/></radialGradient><radialGradient id="stage" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${INK.signal}" stop-opacity="0.09"/><stop offset="1" stop-color="${INK.signal}" stop-opacity="0"/></radialGradient></defs><rect width="${PAGE.width}" height="${PAGE.height}" fill="${INK.ground}"/><rect width="${PAGE.width}" height="460" fill="url(#dots)"/><rect width="${PAGE.width}" height="460" fill="url(#fade)"/><rect width="${PAGE.width}" height="540" fill="url(#glow)"/><rect x="40" y="430" width="${PAGE.width - 80}" height="320" fill="url(#stage)"/></svg>`;

/** The cover's last line, in its foot, where the other pages have their number. */
const COVER_FOOTER: PdfObject = {
  margin: [MARGIN.left, 22, MARGIN.right, 0],
  stack: [
    rule(INK.line),
    {
      columns: [
        {
          width: "*",
          text: `Made with ${PRODUCT_NAME}, open source by ${MAKER}`,
          fontSize: 7.5,
          color: INK.muted,
        },
        {
          width: "auto",
          text: new URL(MAKER_URL).host,
          link: MAKER_URL,
          font: "GeistMono",
          fontSize: 7,
          color: INK.muted,
        },
      ],
      margin: [0, 9, 0, 0],
    },
  ],
};

/** The foot of every page after the cover: the website, and the page's number. */
const FOOTER: PdfObject = {
  margin: [MARGIN.left, 24, MARGIN.right, 0],
  stack: [
    rule(),
    {
      columns: [
        {
          width: "*",
          text: new URL(WEBSITE_URL).host,
          link: WEBSITE_URL,
          font: "GeistMono",
          fontSize: 7,
          color: PAPER.muted,
        },
        {
          width: "auto",
          text: "Page {page} of {pages}",
          fontSize: 7.5,
          color: PAPER.muted,
        },
      ],
      margin: [0, 8, 0, 0],
    },
  ],
};

/**
 * What every report's PDF shares, which the script that draws it carries (pdf-script.ts) rather
 * than every report's data: the page, the styles, the fonts, the table layouts, the cover's ground
 * and its foot, and the foot of every other page, whose {page} and {pages} the script fills in.
 */
export const PDF_DESIGN = {
  document: {
    language: "en",
    pageSize: "A4",
    pageMargins: [MARGIN.left, MARGIN.top, MARGIN.right, MARGIN.bottom],
    defaultStyle: {
      font: "Geist",
      fontSize: 9,
      lineHeight: 1.35,
      color: PAPER.body,
    },
    styles: STYLES,
  },
  fonts: PDF_FONTS,
  layouts: LAYOUTS,
  cover: COVER_SVG,
  footer: FOOTER,
  coverFooter: COVER_FOOTER,
};

/** The head of every page after the cover: the mark, the tool, and what was audited. */
const headerNode = (host: string, kind: "page" | "site"): PdfObject => ({
  margin: [MARGIN.left, 30, MARGIN.right, 0],
  stack: [
    {
      columns: [
        { svg: MARK_SVG, width: 12 },
        {
          width: "*",
          text: PRODUCT_NAME,
          font: "GeistMedium",
          fontSize: 7.5,
          color: PAPER.text,
          margin: [6, 2, 0, 0],
        },
        {
          width: "auto",
          text: [
            kind === "site" ? "Site audit  ·  " : "Page audit  ·  ",
            { text: quote(host), color: PAPER.text },
          ],
          fontSize: 7.5,
          color: PAPER.muted,
          margin: [0, 2, 0, 0],
        },
      ],
    },
    rule(PAPER.line, [0, 9, 0, 0]),
  ],
});

/** The contents: every section's title and the page it starts on. */
const CONTENTS: PdfObject = {
  pageBreak: "before",
  stack: [
    kicker("In this report"),
    {
      toc: {
        title: { text: "Contents", style: "h1", margin: [0, 8, 0, 14] },
        textStyle: "toc",
        numberStyle: "tocNumber",
        textMargin: [0, 5, 0, 5],
      },
    },
  ],
};

const para = (text: Runs): PdfObject => ({ text, margin: [0, 0, 0, 8] });

const SEVERITY_MEANING: [Severity, string][] = [
  [
    "error",
    "What to fix first: it keeps a page out of search or answers, or shows it wrongly there.",
  ],
  ["warning", "Worth fixing: it costs the page reach or clicks."],
  [
    "info",
    "A note: it costs a point at most, and it may be a choice the site made on purpose.",
  ],
];

const REPOSITORY = new URL(REPOSITORY_URL);

/** The closing line: the mark, the tool's name, and where it and its maker are. */
const SIGNATURE: PdfObject = {
  unbreakable: true,
  margin: [0, 16, 0, 0],
  stack: [
    rule(),
    {
      columns: [
        { svg: MARK_SVG, width: 22 },
        {
          width: "*",
          stack: [
            {
              text: PRODUCT_NAME,
              font: "Display",
              fontSize: 12,
              color: PAPER.text,
            },
            {
              text: [
                `Open source, by ${MAKER}.  `,
                {
                  text: `${REPOSITORY.host}${REPOSITORY.pathname}`,
                  style: "link",
                  link: REPOSITORY_URL,
                },
                "  ·  ",
                {
                  text: new URL(MAKER_URL).host,
                  style: "link",
                  link: MAKER_URL,
                },
              ],
              style: "small",
              margin: [0, 2, 0, 0],
            },
          ],
          margin: [10, 1, 0, 0],
        },
      ],
      margin: [0, 14, 0, 0],
    },
  ],
};

/** What the report is: how it scores, what its parts mean, how to run it again, and who made it. */
const aboutNodes = (url: string, kind: "page" | "site"): PdfNode[] => {
  const command =
    kind === "site"
      ? `npx @rivi-software/agentic-seo-check crawl ${new URL(url).origin}`
      : `npx @rivi-software/agentic-seo-check audit ${url}`;

  return [
    sectionHead("about", "About", "About this report"),
    para(
      `${PRODUCT_NAME} runs two audits. The SEO audit reads a page as search engines do; the AEO audit reads it as AI answer engines such as ChatGPT search, Claude, Perplexity and Google AI Overviews do. Each finding comes from a rule, with what to change and, where the rule can write it, the exact edit. No AI model reads the page or writes the findings.`
    ),
    subheading("Scores"),
    para(
      "Each audit scores from 0 to 100. A page starts at 100 and loses 15 for each error, 5 for each warning and 1 for each info finding. A site scores the average of its pages, less 10, 3 and 0.5 for each finding across the site. 90 and up is good, 50 to 89 fair, and under 50 poor."
    ),
    subheading("Severities"),
    {
      table: {
        widths: [62, "*"],
        body: SEVERITY_MEANING.map(([severity, meaning]) => [
          { text: [tag(severity)] },
          meaning,
        ]),
      },
      layout: "rows",
      margin: [0, 0, 0, 8],
    },
    subheading("In this PDF"),
    para(
      "Every finding with what to change and its fix, but not its evidence: the report's JSON download has that. Characters the PDF's fonts cannot draw, such as Chinese, Japanese, Arabic or emoji, show as ? on grey; the JSON and the Markdown quote them as the page has them."
    ),
    subheading("Run it again"),
    para([
      "On the website, at ",
      {
        text: new URL(WEBSITE_URL).host,
        style: "link",
        link: `${WEBSITE_URL}/`,
      },
      kind === "site"
        ? `, which crawls up to ${HOSTED_LIMITS.maxPages} pages of a site from its homepage. In a terminal:`
        : ". In a terminal:",
    ]),
    {
      table: {
        widths: ["*"],
        body: [
          [{ text: quote(command), style: "code", fillColor: PAPER.inset }],
        ],
      },
      layout: "table",
      margin: [0, 0, 0, 8],
    },
    para([
      "Or from an AI assistant, through the hosted MCP server at ",
      { text: `${MCP_ORIGIN}/mcp`, style: "link", link: `${MCP_ORIGIN}/` },
      ", which is free and needs no account.",
    ]),
    SIGNATURE,
  ];
};

/**
 * The dot beside a crawler's answer: green when robots.txt lets it in; red when it keeps out one
 * that search or answers need; grey for a training crawler kept out, which is the site's choice.
 */
const crawlerColour = (allowed: boolean, purpose: AiBotPurpose): string => {
  if (allowed) {
    return PAPER.signal;
  }

  return purpose === "training" ? PAPER.faint : SEVERITY_PAPER.error.main;
};

/** The AI crawlers robots.txt lets in or keeps out, by what they fetch pages for. */
const crawlersNodes = (aeo: AeoAudit, page: string): PdfNode[] => {
  const bots = aeo.crawlers?.bots ?? [];

  if (bots.length === 0) {
    return [];
  }

  const allowed = bots.filter((bot) => bot.allowed).length;

  return [
    sectionHead(
      "crawlers",
      "AI crawlers",
      "AI crawlers in robots.txt",
      `${allowed} of ${bots.length} may fetch ${page}. Keeping the training crawlers out is the site's own choice; the search and answer crawlers decide whether AI answers can find and cite it.`
    ),
    ...(["search", "answer", "training"] as const).flatMap((purpose) => {
      const group = bots.filter((bot) => bot.purpose === purpose);

      return group.length === 0
        ? []
        : [
            subheading(PURPOSE_LABEL[purpose]),
            {
              table: {
                widths: [118, 92, "*", 50],
                body: group.map((bot) => [
                  mono(bot.name),
                  { text: quote(bot.operator), style: "small" },
                  { text: quote(bot.usedFor), style: "small" },
                  {
                    text: [
                      dot(crawlerColour(bot.allowed, purpose)),
                      bot.allowed ? "Allowed" : "Blocked",
                    ],
                    font: "GeistMedium",
                    fontSize: 8,
                    color: PAPER.text,
                    alignment: "right",
                  },
                ]),
                dontBreakRows: true,
              },
              layout: "rows",
            },
          ];
    }),
  ];
};

/** The facts a summary shows of a page: what it says of itself, and its numbers. */
const pageFactsNodes = (seo: PageAudit, title: string): PdfNode[] => {
  const rows = seoFactRows(seo);

  return [subheading(title), ...factList(rows.text), ...factTiles(rows.tiles)];
};

const fieldNodes = (field: PageAudit["fieldData"]): PdfNode[] => {
  const rows = fieldFactRows(field);

  return rows
    ? [
        subheading("Real visits on phones"),
        ...factTiles(rows.tiles),
        { text: quote(rows.note), style: "small" },
      ]
    : [];
};

/** A report's own part of its PDF: its metadata, its content, and its running head. */
const report = (
  kind: "page" | "site",
  url: string,
  content: PdfNode[]
): PdfReport => {
  const { hostname } = new URL(url);

  return {
    document: {
      info: {
        title: `${PRODUCT_NAME} report: ${hostname}`,
        author: MAKER,
        subject: `${kind === "site" ? "Site" : "Page"} audit of ${url} for search engines and AI answer engines`,
        creator: PRODUCT_NAME,
        producer: PRODUCT_NAME,
      },
      content,
    },
    header: headerNode(hostname, kind),
  };
};

/** The facts among `rows` whose labels are `labels`, in that order. */
const pick = (rows: Fact[], labels: string[]): Fact[] =>
  labels.flatMap((label) => {
    const row = rows.find(([name]) => name === label);

    return row ? [row] : [];
  });

/** The summary's opening: what was audited and found, both scores, and what to fix first. */
const summaryNodes = (
  lede: string,
  seo: Scored,
  aeo: Scored,
  parts: ReportParts
): PdfNode[] => [
  sectionHead("summary", "Summary", "At a glance", lede),
  scoresTable(seo, aeo),
  ...fixFirstNodes(parts),
  ...indexNodes(parts),
];

/** The PDF of one page's two audits, from the parts its HTML report shows (report.ts). */
export const pagePdf = (
  seo: PageAudit,
  aeo: AeoAudit,
  parts: ReportParts
): PdfReport => {
  const all = countsOf(
    [...seo.findings, ...aeo.findings].map((f) => f.severity)
  );

  return report("page", seo.url, [
    ...coverNodes({
      url: seo.url,
      auditedAt: seo.auditedAt,
      seo,
      aeo,
      facts: pick(seoFactRows(seo).tiles, [
        "HTTP status",
        "Indexable",
        "Words",
        "Language",
      ]),
    }),
    CONTENTS,
    ...summaryNodes(
      `${PRODUCT_NAME} audited this page for search engines (SEO) and for AI answer engines (AEO) on ${auditedOn(seo.auditedAt)}. It found ${plural(seo.findings.length + aeo.findings.length, "finding")}: ${countsSentence(all)}. Each says what to change, and the edits that fix it follow in the SEO and AEO findings.`,
      seo,
      aeo,
      parts
    ),
    ...pageFactsNodes(seo, "The page"),
    subheading("For AI answer engines"),
    ...factTiles(aeoFactRows(aeo, "page")),
    ...fieldNodes(seo.fieldData),
    ...findingsSection(
      "seo",
      `${plural(seo.findings.length, "finding")} for search engines: ${countsSentence(seo.counts)}.`,
      parts.seo,
      "No SEO findings: nothing to fix on this page."
    ),
    ...findingsSection(
      "aeo",
      `${plural(aeo.findings.length, "finding")} for AI answer engines: ${countsSentence(aeo.counts)}.`,
      parts.aeo,
      "No AEO findings: nothing to fix on this page."
    ),
    ...crawlersNodes(aeo, "this page"),
    ...aboutNodes(seo.url, "page"),
  ]);
};

/** A score on paper, in its band's colour. */
const scoreText = (score: number | null | undefined): PdfNode =>
  score === undefined || score === null
    ? ""
    : {
        text: String(score),
        font: "GeistMedium",
        color: BAND_COLOUR[band(score)].paper,
        alignment: "right",
      };

/** A page's HTTP status after its tone's dot, or that it gave no answer. */
const statusCell = (status: number | null | undefined): PdfObject => {
  if (!status) {
    return { text: "No answer", style: "small" };
  }

  const tone = statusTone(status);

  return {
    text: [...(tone ? [dot(TONE_COLOUR[tone])] : []), String(status)],
  };
};

/** Every page a crawl audited, with its HTTP status, its depth and both scores. */
const pagesNodes = (seo: SiteAudit, aeo: AeoAudit): PdfNode[] => {
  const aeoScores = new Map((aeo.pages ?? []).map((p) => [p.url, p.score]));

  return [
    sectionHead(
      "pages",
      "Pages",
      "The pages",
      `The ${plural(seo.pages.length, "page")} the crawl audited, with both scores. A page's own findings and edits are in its own report: audit its address on ${new URL(WEBSITE_URL).host}.`
    ),
    {
      table: {
        headerRows: 1,
        widths: ["*", 44, 34, 30, 30],
        body: [
          [
            { text: "PAGE", style: "label" },
            { text: "HTTP", style: "label" },
            { text: "DEPTH", style: "label", alignment: "right" },
            { text: "SEO", style: "label", alignment: "right" },
            { text: "AEO", style: "label", alignment: "right" },
          ],
          ...seo.pages.map((page) => [
            { ...mono(page.url), ...linkTo(page.url) },
            statusCell(page.response?.status),
            {
              text: page.depth === undefined ? "" : String(page.depth),
              alignment: "right",
            },
            scoreText(page.score),
            scoreText(aeoScores.get(page.url)),
          ]),
        ],
        dontBreakRows: true,
      },
      layout: "table",
    },
  ];
};

/** The homepage's own findings with their edits, as its page report has them. */
const homeNodes = (start: SiteAudits["start"]): PdfNode[] => {
  if (!start) {
    return [];
  }

  const findings = homeFindings(start);

  return [
    sectionHead("home", "The homepage", "The homepage", [
      "Every finding on ",
      mono(start.seo.url),
      `, with its fix: ${plural(findings.length, "finding")}.`,
    ]),
    ...pageFactsNodes(start.seo, "The page"),
    ...partsNodes(
      [{ groups: categoryGroups("home", findings) }],
      "home",
      "No findings on the homepage.",
      false
    ),
  ];
};

/** The PDF of a site's two audits from one crawl, from the parts its HTML report shows. */
export const sitePdf = (audits: SiteAudits, parts: ReportParts): PdfReport => {
  const { seo, aeo, start } = audits;
  const { hostname } = new URL(aeo.url);
  const aeoIssues = aeo.issues ?? [];
  const crawlRows = crawlFactRows(seo);
  const siteCount = seo.siteFindings.length + aeo.findings.length;
  const ruleCount = seo.issues.length + aeoIssues.length;

  return report("site", aeo.url, [
    ...coverNodes({
      url: aeo.url,
      auditedAt: seo.auditedAt,
      seo,
      aeo,
      pages: seo.pages.length,
      facts: [
        // The count alone: the crawl's own tile says how many it found.
        ["Pages audited", String(seo.crawl.pagesCrawled)],
        ...pick(crawlRows, ["Links checked", "robots.txt", "Sitemap URLs"]),
      ],
    }),
    CONTENTS,
    ...summaryNodes(
      `${PRODUCT_NAME} crawled ${plural(seo.pages.length, "page")} of ${hostname} on ${auditedOn(seo.auditedAt)} and audited them for search engines (SEO) and for AI answer engines (AEO). It found ${plural(siteCount, "finding")} across the site and ${plural(ruleCount, "rule")} that fire on its pages.`,
      seo,
      aeo,
      parts
    ),
    subheading("The crawl"),
    ...factTiles(crawlRows),
    subheading("For AI answer engines"),
    ...factTiles(aeoFactRows(aeo, "site")),
    ...fieldNodes(start?.seo.fieldData),
    ...findingsSection(
      "seo",
      `${plural(seo.siteFindings.length, "finding")} across the site, and ${plural(seo.issues.length, "rule")} that fire on its pages, each with up to 10 of them.`,
      parts.seo,
      "No SEO findings across the site or on its pages."
    ),
    ...findingsSection(
      "aeo",
      `${plural(aeo.findings.length, "finding")} across the site, and ${plural(aeoIssues.length, "rule")} that fire on its pages.`,
      parts.aeo,
      "No AEO findings across the site or on its pages."
    ),
    ...homeNodes(start),
    ...pagesNodes(seo, aeo),
    ...crawlersNodes(aeo, "the homepage"),
    ...aboutNodes(aeo.url, "site"),
  ]);
};
