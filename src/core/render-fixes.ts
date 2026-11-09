/**
 * The edits that fix what a render comparison found: put into the server HTML what only JavaScript
 * adds. `code` quotes the rendered DOM's own tag, so the server sends what the browser ends up
 * with; `current` quotes the server HTML.
 */
import {
  addHtml,
  escapeText,
  isCut,
  rebuildEdit,
  removeEdit,
  removeHtml,
  replaceHtml,
  slot,
  withContent,
} from "./rules/fix.js";
import type { ExtractedPage, FixEdit, ResponseInfo } from "./types.js";

/** The server HTML (`raw`) and the rendered DOM of one page. */
export interface RenderPages {
  raw: ExtractedPage;
  rendered: ExtractedPage;
  response?: ResponseInfo;
}

const SSR =
  "JavaScript adds this after load. Render it in the server HTML instead (SSR, SSG or prerendering; in a framework, the route's metadata or head API), so crawlers that do not run JavaScript, and Google before it renders the page, see it.";

/** The tag of the element whose text is `value`, from parallel lists of texts and tags. */
const tagFor = (
  texts: string[],
  tags: string[],
  value: string
): string | undefined => {
  const tag = tags[texts.indexOf(value)];

  return tag && !isCut(tag) ? tag : undefined;
};

/** Writes `code` into the server HTML: in place of the empty tag it has, or added to <head>. */
const intoHead = (
  empty: string | undefined,
  code: string,
  at: string,
  write: string
): FixEdit =>
  empty
    ? replaceHtml(empty, code, { at, write })
    : addHtml("head", code, write);

export const titleFix = (s: RenderPages, title: string): FixEdit[] => [
  intoHead(
    s.raw.markup.titles[0],
    tagFor(s.rendered.titles, s.rendered.markup.titles, title) ??
      `<title>${escapeText(title)}</title>`,
    "head > title",
    SSR
  ),
];

export const titleChangedFix = (
  s: RenderPages,
  serverTitle: string,
  finalTitle: string
): FixEdit[] => {
  const current = s.raw.markup.titles[s.raw.titles.indexOf(serverTitle)];
  const content = escapeText(finalTitle);
  const write = `JavaScript changes the title to this after load; send it from the server so both agree. If the change is on purpose (an unread count, a live status), keep the server title and leave this finding.`;

  return current
    ? [
        replaceHtml(
          current,
          withContent(current, content) ?? `<title>${content}</title>`,
          { at: "head > title", write }
        ),
      ]
    : [addHtml("head", `<title>${content}</title>`, write)];
};

export const descriptionFix = (
  s: RenderPages,
  description: string
): FixEdit[] => {
  const rendered = tagFor(
    s.rendered.metaDescriptions,
    s.rendered.markup.metaDescriptions,
    description
  );

  const code =
    rendered ??
    `<meta name="description" content="${description.replaceAll('"', "&quot;")}">`;

  return [
    intoHead(
      s.raw.markup.metaDescriptions[0],
      code,
      'head > meta[name="description"]',
      SSR
    ),
  ];
};

/**
 * The canonical JavaScript sets, in the server HTML: added when the server sends none, in place of
 * the server's when it sends another.
 */
export const canonicalFix = (
  s: RenderPages,
  serverCanonical: string | null,
  finalCanonical: string
): FixEdit[] => {
  const [rendered] = s.rendered.markup.canonicals;

  const code =
    rendered && !isCut(rendered)
      ? rendered
      : `<link rel="canonical" href="${finalCanonical.replaceAll('"', "&quot;")}">`;

  const at = 'head > link[rel="canonical"]';
  const [current] = s.raw.markup.canonicals;

  if (serverCanonical === null) {
    return [intoHead(current, code, at, SSR)];
  }

  const write = `JavaScript changes the canonical from ${serverCanonical} to ${finalCanonical}. Check that ${finalCanonical} is this page's own URL, send it from the server, and stop setting it a second time in the browser (a head manager or router doing it again).`;

  return current
    ? [replaceHtml(current, code, { at, write })]
    : [addHtml("head", code, write)];
};

const NOINDEX = /\bcontent\s*=\s*["']?[^"'>]*\b(?:noindex|none)\b/iu;

/** noindex that only JavaScript adds: the tag to take out of the component that renders it. */
export const noindexAddedFix = (s: RenderPages): FixEdit[] => {
  const tag =
    s.rendered.markup.metaRobots.find((t) => NOINDEX.test(t)) ??
    '<meta name="robots" content="noindex">';

  return [
    removeEdit("html", tag, {
      at: 'meta[name="robots"]',
      write:
        "JavaScript adds this tag after load (often a head manager's default or an auth guard), and Google applies it when it renders the page. Remove it from the component that renders it. If the page must stay out of search, send noindex in the server HTML or an X-Robots-Tag header instead, so the decision does not wait for rendering.",
    }),
  ];
};

/** noindex the server sends and JavaScript removes: Google keeps the server's, so remove it there. */
export const noindexRemovedFix = (s: RenderPages): FixEdit[] => {
  const write =
    "The rendered page drops noindex, so the page is meant to be indexed, but Google reads the server's noindex and does not render the page. Remove it from the server. If the page must stay out of search, keep it and stop removing it in JavaScript instead.";

  const tags = s.raw.markup.metaRobots.filter((t) => NOINDEX.test(t));

  if (tags.length) {
    return tags
      .map((t) => removeHtml(t, 'meta[name="robots"]'))
      .map((e) => ({
        ...e,
        write,
      }));
  }

  const header = s.response?.headers["x-robots-tag"];

  return [
    removeEdit("http", `X-Robots-Tag: ${header ?? "noindex"}`, {
      at: "X-Robots-Tag",
      write,
    }),
  ];
};

/** Where the server HTML's content belongs: its empty app root, or <body>. */
const contentRoot = (s: RenderPages): string =>
  s.raw.answer.emptyAppRoot ?? "body";

export const h1Fix = (s: RenderPages): FixEdit[] => {
  const index = s.rendered.headings.findIndex((h) => h.level === 1 && h.text);
  const heading = s.rendered.headings[index];
  const tag = s.rendered.markup.headings[index];

  const code =
    tag && !isCut(tag) ? tag : `<h1>${escapeText(heading?.text ?? "")}</h1>`;

  return [
    addHtml(
      contentRoot(s),
      code,
      `${SSR} Put it where the page's main content starts.`
    ),
  ];
};

export const contentFix = (s: RenderPages, words: number): FixEdit[] => {
  const start = s.rendered.text.split(" ").slice(0, 12).join(" ");

  return [
    addHtml(
      contentRoot(s),
      slot("the page's main content, as HTML"),
      `JavaScript adds ${words} words the server HTML does not have${start ? `; the rendered text starts "${start}…"` : ""}. Render this route on the server (SSR, SSG or prerendering) so the HTML carries the text.`
    ),
  ];
};

/** Internal links only the rendered DOM has, quoted as JavaScript writes them (the first 10). */
export const linksFix = (s: RenderPages, missing: number): FixEdit[] => {
  const known = new Set(
    s.raw.links.flatMap((l) => (l.internal && l.url ? [l.url] : []))
  );

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const link of s.rendered.links) {
    if (
      !link.internal ||
      !link.url ||
      known.has(link.url) ||
      seen.has(link.url) ||
      isCut(link.tag)
    ) {
      continue;
    }

    seen.add(link.url);
    lines.push(`${link.tag}${escapeText(link.text)}</a>`);

    if (lines.length === 10) {
      break;
    }
  }

  const write = `${missing} internal links exist only after JavaScript runs${lines.length ? `; the first ${lines.length} are here` : ""}. Render them as plain <a href> in the server HTML (the navigation and the content lists), so crawlers find the pages without running JavaScript.`;

  return [
    addHtml(
      contentRoot(s),
      lines.length
        ? lines.join("\n")
        : slot("the page's links, as <a href> elements"),
      write
    ),
  ];
};

/** JSON-LD longer than this is described with a slot rather than copied into the fix. */
const MAX_JSON_LD = 5000;

/** The JSON-LD JavaScript adds, as script elements for the server HTML. */
export const structuredDataFix = (s: RenderPages): FixEdit[] => {
  const scripts = new Set<string>();

  for (const item of s.rendered.structuredData) {
    if (item.source !== "json-ld") {
      continue;
    }

    // One <script> may hold several items (an array, an @graph): copy it once.
    const json =
      item.scriptText?.trim() ||
      JSON.stringify(item.data).replaceAll("<", String.raw`\u003c`);

    scripts.add(json);
  }

  const edits = [...scripts]
    .slice(0, 10)
    .map((json) =>
      addHtml(
        "head",
        json.length > MAX_JSON_LD
          ? `<script type="application/ld+json">${slot("the JSON-LD JavaScript adds")}</script>`
          : `<script type="application/ld+json">${json}</script>`,
        `${SSR} Google reads JSON-LD that JavaScript adds, but other consumers (social previews, other search engines, AI crawlers) do not.`
      )
    );

  return edits.length
    ? edits
    : [
        addHtml(
          contentRoot(s),
          slot("the microdata JavaScript adds"),
          `${SSR} The structured data is microdata on elements JavaScript renders.`
        ),
      ];
};

const SCRIPT_URL = /https?:\/\/[^\s"'()<>]+?\.m?js\b/u;

/** The scripts that throw while the page renders, from the messages they log (the first 5). */
export const consoleErrorFix = (errors: string[]): FixEdit[] =>
  errors.slice(0, 5).map((error) => {
    const url = SCRIPT_URL.exec(error)?.[0];

    return rebuildEdit(
      url,
      "code that does not throw",
      `Fix the error ${url ? "this script" : "a script of this page"} logs while the page renders (${error}): a script that fails can leave crawlers an incomplete page.`
    );
  });
