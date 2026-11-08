/** Text analysis helpers: word counts, readability, placeholder detection. */

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export const words = (text: string): string[] => text.match(WORD_RE) ?? [];

export const wordCount = (text: string): number => words(text).length;

export const collapseWhitespace = (text: string): string =>
  text.replaceAll(/\s+/gu, " ").trim();

export const sentenceCount = (text: string): number => {
  const parts = text
    .split(/[.!?]+(?:\s+|$)/u)
    .filter((s) => s.trim().length > 0);

  return Math.max(1, parts.length);
};

/** English syllable heuristic: vowel groups minus silent trailing e, min 1. */
export const syllables = (word: string): number => {
  const w = word.toLowerCase().replaceAll(/[^a-z]/gu, "");

  if (!w) {
    return 0;
  }

  if (w.length <= 3) {
    return 1;
  }

  let count = (w.replace(/e$/u, "").match(/[aeiouy]+/gu) ?? []).length;

  if (w.endsWith("le") && !/[aeiouy]le$/u.test(w)) {
    count += 1;
  }

  return Math.max(1, count);
};

/**
 * Flesch Reading Ease (English formula). Returns null when there is not enough text.
 * 90-100 very easy, 60-70 plain English, 30-50 difficult, <30 very difficult.
 */
export const fleschReadingEase = (text: string): number | null => {
  const ws = words(text);

  if (ws.length < 100) {
    return null;
  }

  const sentences = sentenceCount(text);
  const syl = ws.reduce((sum, w) => sum + syllables(w), 0);

  const score =
    206.835 - 1.015 * (ws.length / sentences) - 84.6 * (syl / ws.length);

  return Math.round(score * 10) / 10;
};

const PLACEHOLDER_RE = /lorem ipsum|dolor sit amet|consectetur adipiscing/iu;

export const hasPlaceholderText = (text: string): boolean =>
  PLACEHOLDER_RE.test(text);

export const GENERIC_TITLES = new Set([
  "home",
  "homepage",
  "index",
  "untitled",
  "untitled page",
  "untitled document",
  "document",
  "new page",
  "page",
  "title",
  "welcome",
  "react app",
  "vite app",
  "vite + react",
  "vite + react + ts",
  "vite + vue",
  "vite + svelte",
  "create next app",
  "next app",
  "nuxt app",
  "nuxt",
  "astro",
  "my app",
  "my site",
  "my website",
  "website",
  "default",
  "test",
  "hello world",
  "svelte app",
  "angular app",
  "gatsby default starter",
  "remix app",
  "tanstack start starter",
  "example",
]);

export const isGenericTitle = (title: string): boolean =>
  GENERIC_TITLES.has(collapseWhitespace(title).toLowerCase());

export const GENERIC_ANCHORS = new Set([
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "this",
  "this page",
  "continue",
  "continue reading",
  "details",
  "more info",
  "info",
  "go",
  "page",
  "article",
  "website",
  "url",
  "www",
]);

export const isGenericAnchor = (text: string): boolean => {
  const t = collapseWhitespace(text)
    .toLowerCase()
    .replace(/[.!…»›>]+$/u, "")
    .trim();

  return GENERIC_ANCHORS.has(t);
};

export const normalizeForComparison = (text: string): string =>
  collapseWhitespace(text).toLowerCase();

export const includesKeyword = (
  haystack: string | null | undefined,
  keyword: string
): boolean => {
  if (!haystack) {
    return false;
  }

  return normalizeForComparison(haystack).includes(
    normalizeForComparison(keyword)
  );
};

export const keywordOccurrences = (text: string, keyword: string): number => {
  const hay = normalizeForComparison(text);
  const needle = normalizeForComparison(keyword);

  if (!needle) {
    return 0;
  }

  let count = 0;
  let idx = hay.indexOf(needle);

  while (idx !== -1) {
    count += 1;
    idx = hay.indexOf(needle, idx + needle.length);
  }

  return count;
};

/** 5-word shingles for near-duplicate detection. */
export const shingles = (text: string, size = 5): Set<string> => {
  const ws = words(normalizeForComparison(text));
  const out = new Set<string>();

  for (let i = 0; i + size <= ws.length; i += 1) {
    out.add(ws.slice(i, i + size).join(" "));
  }

  return out;
};

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }

  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];

  for (const s of small) {
    if (large.has(s)) {
      inter += 1;
    }
  }

  return inter / (a.size + b.size - inter);
};
