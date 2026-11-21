import { promises as fs } from "node:fs";
import path from "node:path";

import { fetchPage } from "../fetch.js";
import type { FetchOptions } from "../fetch.js";
import { detached } from "../html/dom.js";
import type { LlmsTxtInfo } from "../types.js";
import { resolveUrl } from "../url.js";

/** An llms.txt is an index of links; a file this large is not one, and is read no further. */
const MAX_LLMS_TXT_BYTES = 1_000_000;

/**
 * `[name](url)`. Each negated class also stops at the bracket that would start the next attempt,
 * so a line of "[[[[" or "](](](" costs one pass. A URL with parentheses in it is not counted.
 */
const MARKDOWN_LINK = /\[[^[\]\n]*\]\([^()\s]+\)/gu;

/** The target of a Markdown link: what follows "](" up to the closing parenthesis. */
const LINK_TARGET = /\]\((?<target>[^()\s]+)\)$/u;

/** `markdown`, one link as the file writes it, pointing at `target` instead. */
export const retargetLink = (markdown: string, target: string): string =>
  markdown.replace(LINK_TARGET, `](${target})`);

/** Links kept per file for a check, at most. */
const MAX_KEPT_LINKS = 500;

/** A Markdown link of an llms.txt as the file writes it, and the URL it points to. */
export interface LlmsTxtLink {
  markdown: string;
  url: string;
}

/**
 * The links each parsed file holds. Kept beside the file's info rather than in it, so the audit's
 * JSON carries the count only, as it always has.
 */
const linksOfFile = new WeakMap<LlmsTxtInfo, LlmsTxtLink[]>();

/** The links of a parsed llms.txt, resolved against its URL; none for a file not parsed here. */
export const llmsTxtLinks = (info: LlmsTxtInfo): LlmsTxtLink[] =>
  linksOfFile.get(info) ?? [];

const missing = (url: string, httpStatus: number | null): LlmsTxtInfo => ({
  url,
  status: "missing",
  httpStatus,
  title: null,
  summary: null,
  sections: [],
  links: 0,
  bytes: 0,
  problems: [],
});

/** Reads an llms.txt file against the format at llmstxt.org: an H1 title is the one required part. */
export const parseLlmsTxt = (
  url: string,
  httpStatus: number | null,
  raw: string
): LlmsTxtInfo => {
  const text = raw.replace(/^\uFEFF/u, "").slice(0, MAX_LLMS_TXT_BYTES);
  const lines = text.split(/\r\n|\r|\n/u).map((l) => l.trim());
  const firstIndex = lines.findIndex(Boolean);
  const first = firstIndex === -1 ? "" : (lines[firstIndex] ?? "");
  const title = /^#\s+\S/u.test(first) ? first.replace(/^#\s+/u, "") : null;
  const afterTitle = lines.slice(firstIndex + 1).find(Boolean) ?? "";
  const problems: string[] = [];

  if (!first) {
    problems.push("the file is empty");
  } else if (!title) {
    problems.push(
      `it does not start with an H1 title ("# Site name"); the first line is "${first.slice(0, 80)}"`
    );
  }

  // Every link counts; the first MAX_KEPT_LINKS are kept, copied so they do not pin the file.
  let count = 0;
  const links: LlmsTxtLink[] = [];

  for (const match of text.matchAll(MARKDOWN_LINK)) {
    count += 1;

    const target =
      links.length < MAX_KEPT_LINKS
        ? LINK_TARGET.exec(match[0])?.groups?.target
        : undefined;

    const resolved = target ? resolveUrl(target, url) : null;

    if (resolved) {
      links.push({ markdown: detached(match[0]), url: resolved });
    }
  }

  const info: LlmsTxtInfo = {
    url,
    status: problems.length ? "invalid" : "found",
    httpStatus,
    title: title ? title.slice(0, 200) : null,
    summary:
      title && afterTitle.startsWith(">")
        ? afterTitle.replace(/^>\s*/u, "").slice(0, 300)
        : null,
    sections: lines
      .filter((l) => /^##\s+\S/u.test(l))
      .slice(0, 20)
      .map((l) => l.replace(/^##\s+/u, "").slice(0, 120)),
    links: count,
    bytes: Buffer.byteLength(text, "utf-8"),
    problems,
  };

  linksOfFile.set(info, links);

  return info;
};

/** Fetches /llms.txt from an origin. An HTML answer is a single-page app's fallback route: no file. */
export const loadLlmsTxt = async (
  origin: string,
  options: FetchOptions = {}
): Promise<LlmsTxtInfo> => {
  const url = new URL("/llms.txt", origin).href;

  const res = await fetchPage(url, {
    ...options,
    timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000),
    maxBodyBytes: MAX_LLMS_TXT_BYTES,
  });

  const contentType = res.contentType?.toLowerCase() ?? "";
  const body = res.body ?? "";

  if (
    res.status !== 200 ||
    res.error ||
    contentType.includes("text/html") ||
    /^\s*</u.test(body.slice(0, 200))
  ) {
    return missing(url, res.status);
  }

  return parseLlmsTxt(url, res.status, body);
};

/** Reads llms.txt from the root of a build output directory. */
export const readLlmsTxt = async (
  dir: string,
  baseUrl: string
): Promise<LlmsTxtInfo> => {
  const url = new URL("/llms.txt", baseUrl).href;
  const file = await fs.open(path.join(dir, "llms.txt")).catch(() => null);

  if (!file) {
    return missing(url, 404);
  }

  try {
    const buffer = Buffer.alloc(MAX_LLMS_TXT_BYTES);
    const { bytesRead } = await file.read(buffer, 0, MAX_LLMS_TXT_BYTES, 0);

    return parseLlmsTxt(
      url,
      200,
      buffer.subarray(0, bytesRead).toString("utf-8")
    );
  } finally {
    await file.close();
  }
};
