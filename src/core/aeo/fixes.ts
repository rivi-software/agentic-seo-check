/**
 * Edits the AEO rules share: robots directives rewritten in the meta tags and the X-Robots-Tag
 * header that state them, status lines, and properties added to structured data.
 */
import { STATUS_CODES } from "node:http";

import {
  addHtml,
  removeEdit,
  replaceEdit,
  setAttributeEdit,
} from "../rules/fix.js";
import { parseRobotsHeader } from "../rules/indexing.js";
import type { ExtractedPage, FixEdit, ResponseInfo } from "../types.js";

/** `HTTP/1.1 403 Forbidden`: a status as a response's first line. */
export const statusLine = (status: number): string => {
  const reason = STATUS_CODES[status];

  return `HTTP/1.1 ${status}${reason ? ` ${reason}` : ""}`;
};

/** How one rule rewrites robots directives. */
export interface DirectiveChange {
  /** Robots meta tag names to rewrite (robots, googlebot, bingbot, ...); null for all of them. */
  metaNames: ReadonlySet<string> | null;
  /** X-Robots-Tag scopes to rewrite: null stands for directives for every crawler, else an agent. */
  headerAgents: ReadonlySet<string | null> | null;
  /** The directive to write instead, null to drop it; returning it unchanged keeps it. */
  change: (directive: string) => string | null;
}

/** Robots directives compare without whitespace: "max-snippet: 50" is "max-snippet:50". */
const squash = (directive: string): string => directive.replaceAll(/\s+/gu, "");

/** The directives after `change`, and whether any of them changed. */
interface Rewritten {
  kept: string[];
  changed: boolean;
}

const rewrite = (
  directives: string[],
  change: DirectiveChange["change"]
): Rewritten => {
  const kept: string[] = [];
  let changed = false;

  for (const d of directives) {
    const next = change(d);

    if (next !== d) {
      changed = true;
    }

    if (next && !kept.includes(next)) {
      kept.push(next);
    }
  }

  return { kept, changed };
};

/** The X-Robots-Tag lines that state `directives`, one line per agent they are scoped to. */
const headerLines = (
  directives: { agent: string | null; directive: string }[]
): string => {
  const runs: { agent: string | null; directives: string[] }[] = [];

  for (const d of directives) {
    const last = runs.at(-1);

    if (last?.agent === d.agent) {
      last.directives.push(d.directive);
    } else {
      runs.push({ agent: d.agent, directives: [d.directive] });
    }
  }

  return runs
    .map(
      (r) =>
        `X-Robots-Tag: ${r.agent === null ? "" : `${r.agent}: `}${r.directives.join(", ")}`
    )
    .join("\n");
};

const headerEdit = (
  header: string,
  spec: DirectiveChange,
  write: string
): FixEdit | null => {
  let changed = false;

  const kept = parseRobotsHeader(header).flatMap((d) => {
    if (spec.headerAgents && !spec.headerAgents.has(d.agent)) {
      return [d];
    }

    const next = spec.change(d.directive);

    if (next !== d.directive) {
      changed = true;
    }

    return next ? [{ agent: d.agent, directive: next }] : [];
  });

  if (!changed) {
    return null;
  }

  const current = `X-Robots-Tag: ${header}`;

  return kept.length
    ? replaceEdit("http", current, headerLines(kept), {
        at: "X-Robots-Tag",
        write,
      })
    : removeEdit("http", current, { at: "X-Robots-Tag", write });
};

/**
 * The edits that rewrite the robots directives a rule is about, in every meta tag and X-Robots-Tag
 * header that states them: the tag or header rewritten, or removed when nothing is left in it.
 */
export const directiveFixes = (
  page: ExtractedPage,
  response: ResponseInfo | undefined,
  spec: DirectiveChange,
  write: string
): FixEdit[] => {
  const edits: FixEdit[] = [];

  for (const meta of page.answer.robotsMeta) {
    const tag = page.markup.metaRobots[meta.index];

    if (!tag || (spec.metaNames && !spec.metaNames.has(meta.name))) {
      continue;
    }

    const directives = meta.content.split(",").map(squash).filter(Boolean);
    const { kept, changed } = rewrite(directives, spec.change);

    if (!changed) {
      continue;
    }

    const at = `head > meta[name="${meta.name}"]`;

    edits.push(
      kept.length
        ? setAttributeEdit(tag, at, "content", kept.join(", "), write)
        : removeEdit("html", tag, { at, write })
    );
  }

  const header = response?.headers["x-robots-tag"];
  const edit = header ? headerEdit(header, spec, write) : null;

  if (edit) {
    edits.push(edit);
  }

  return edits;
};

/** A structured data object a fix adds to: its type, its name when it has one, and how it is written. */
export interface MarkupTarget {
  type: string;
  name?: string | null;
  /** The object is microdata (itemscope), not JSON-LD. */
  microdata: boolean;
  /** A property of the object to add to instead of the object itself (`author`). */
  within?: string;
}

/** Where an edit of a structured data object goes: `BlogPosting (JSON-LD) > author`, or a microdata selector. */
export const markupAt = (target: MarkupTarget): string => {
  if (target.microdata) {
    return `[itemtype$="/${target.type}"]${target.within ? ` [itemprop="${target.within}"]` : ""}`;
  }

  const named = target.name ? ` ${JSON.stringify(target.name)}` : "";

  return `${target.type}${named} (JSON-LD)${target.within ? ` > ${target.within}` : ""}`;
};

/**
 * The edit that adds a property to a structured data object: a JSON-LD property, or for microdata
 * the element that states it.
 */
export const addProperty = (
  target: MarkupTarget,
  property: { json: string; microdata: string },
  write: string
): FixEdit =>
  addHtml(
    markupAt(target),
    target.microdata ? property.microdata : property.json,
    write
  );

/** A JSON string safe inside a <script> element: `<` is escaped, so the text cannot close it. */
export const scriptJson = (value: string): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");
