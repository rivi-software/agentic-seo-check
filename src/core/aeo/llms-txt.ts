import { promises as fs } from "node:fs";
import path from "node:path";

import { fetchPage } from "../fetch.js";
import type { FetchOptions } from "../fetch.js";
import type { LlmsTxtInfo } from "../types.js";

/** An llms.txt is an index of links; a file this large is not one, and is read no further. */
const MAX_LLMS_TXT_BYTES = 1_000_000;

/**
 * `[name](url)`. Each negated class also stops at the bracket that would start the next attempt,
 * so a line of "[[[[" or "](](](" costs one pass. A URL with parentheses in it is not counted.
 */
const MARKDOWN_LINK = /\[[^[\]\n]*\]\([^()\s]+\)/gu;

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

  return {
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
    links: [...text.matchAll(MARKDOWN_LINK)].length,
    bytes: Buffer.byteLength(text, "utf-8"),
    problems,
  };
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
