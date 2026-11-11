import type { ExtractedPage, HreflangInfo } from "../types.js";
import { normalizeUrl } from "../url.js";
import { isLocalHost, pointCanonical, selfUrl } from "./canonical.js";
import {
  addHtml,
  escapeAttribute,
  removeEdit,
  setAttributeEdit,
  slot,
} from "./fix.js";
import { liveUrl, ORIGIN_WRITE, withAttributeSelector } from "./quoted-tags.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

const HREFLANG_CODE =
  /^(?:x-default|[a-zA-Z]{2,3}(?:-[a-zA-Z]{4})?(?:-(?:[a-zA-Z]{2}|\d{3}))?)$/u;

const isLocal = (page: ExtractedPage): boolean =>
  isLocalHost(page.url) || page.url.startsWith("file:");

/** The selector of one hreflang link. */
const linkAt = (h: HreflangInfo): string =>
  withAttributeSelector('link[rel="alternate"]', "hreflang", h.lang);

/** An hreflang code with "_" for "-" ("en_US"), which is valid once hyphenated. */
const hyphenated = (lang: string): string | null => {
  const fixed = lang.replaceAll("_", "-");

  return fixed !== lang && HREFLANG_CODE.test(fixed) ? fixed : null;
};

/** A URL to compare within an hreflang set: no trailing slash, and paths only on a local or file page. */
const setKey = (url: string, pathOnly: boolean): string | null => {
  const normalized = normalizeUrl(url);

  if (!normalized) {
    return null;
  }

  const { origin, pathname, search } = new URL(normalized);

  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  return pathOnly ? `${path}${search}` : `${origin}${path}${search}`;
};

/** The language of a code without its script or region: "en" for "en-GB". */
const languageOf = (code: string): string =>
  code.toLowerCase().split(/[-_]/u)[0] ?? "";

export const hreflangRules = [
  defineRule(
    {
      id: "hreflang.invalid-code",
      category: "international",
      severity: "warning",
      description:
        "hreflang values that are not valid ISO 639-1 language codes with an optional ISO 3166-1 region (or x-default).",
      recommendation:
        'Use codes like "en", "en-gb", "nl-nl", "zh-hant" or "x-default". Country codes alone ("uk", "eu") are invalid.',
      docs: GOOGLE_DOCS.hreflang,
    },
    ({ page }, make) => {
      const bad = page.hreflang.filter((h) => !HREFLANG_CODE.test(h.lang));

      const fix = bad.map((h) => {
        const exact = hyphenated(h.lang);

        return setAttributeEdit(
          h.tag,
          linkAt(h),
          "hreflang",
          exact ? escapeAttribute(exact) : slot("language code"),
          exact
            ? undefined
            : `The language (ISO 639-1) and optional region (ISO 3166-1) of ${h.href.slice(0, 120)}, such as en, en-gb or nl-nl, instead of "${h.lang.slice(0, 40)}"; x-default for the fallback page.`
        );
      });

      return bad.length
        ? make(`${bad.length} hreflang value(s) are invalid.`, {
            fix,
            selector: 'link[rel="alternate"][hreflang]',
            evidence: { invalid: cap(bad.map((h) => h.lang)) },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "hreflang.relative-url",
      category: "international",
      severity: "warning",
      description: "hreflang links must use absolute URLs.",
      recommendation:
        "Use fully qualified URLs (https://example.com/nl/) in every hreflang link.",
      docs: GOOGLE_DOCS.hreflang,
    },
    ({ page }, make) => {
      const rel = page.hreflang.filter((h) => !/^https?:\/\//iu.test(h.href));
      const local = isLocal(page);

      const fix = rel.flatMap((h) =>
        h.url
          ? [
              setAttributeEdit(
                h.tag,
                linkAt(h),
                "href",
                local ? liveUrl(h.url, true) : escapeAttribute(h.url),
                local ? ORIGIN_WRITE : undefined
              ),
            ]
          : []
      );

      return rel.length
        ? make(`${rel.length} hreflang link(s) use relative URLs.`, {
            fix,
            selector: 'link[rel="alternate"][hreflang]',
            evidence: { examples: cap(rel.map((h) => h.href)) },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "hreflang.duplicate-lang",
      category: "international",
      severity: "warning",
      description:
        "The same hreflang value appears more than once with different URLs.",
      recommendation:
        "Each language/region code may map to exactly one URL per page.",
      docs: GOOGLE_DOCS.hreflang,
    },
    ({ page }, make) => {
      const seen = new Map<string, Set<string>>();

      for (const h of page.hreflang) {
        const key = h.lang.toLowerCase();
        const urls = seen.get(key) ?? new Set<string>();
        urls.add(h.url ?? h.href);
        seen.set(key, urls);
      }

      const dupes = [...seen.entries()].flatMap(([lang, urls]) =>
        urls.size > 1 ? [lang] : []
      );

      // Keep the first link of each code; remove the later ones that name another URL.
      const kept = new Map<string, string>();

      const fix = page.hreflang.flatMap((h) => {
        const key = h.lang.toLowerCase();
        const url = h.url ?? h.href;

        if (!dupes.includes(key)) {
          return [];
        }

        const first = kept.get(key);

        if (first === undefined) {
          kept.set(key, url);

          return [];
        }

        return first === url
          ? []
          : [
              removeEdit("html", h.tag, {
                at: linkAt(h),
                write: `This keeps ${first} as the ${h.lang} version. If ${url} is that version, keep this link and remove the other.`,
              }),
            ];
      });

      return dupes.length
        ? make(`hreflang codes with conflicting URLs: ${dupes.join(", ")}.`, {
            fix,
            selector: 'link[rel="alternate"][hreflang]',
            evidence: { codes: dupes },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "hreflang.missing-self",
      category: "international",
      severity: "warning",
      description:
        "The hreflang set does not include this page itself (self-referencing entry).",
      recommendation:
        "Every page in an hreflang cluster must list itself as well as its alternates, otherwise the annotations may be ignored.",
      docs: GOOGLE_DOCS.hreflang,
    },
    ({ page }, make) => {
      if (page.hreflang.length === 0) {
        return null;
      }

      const self = new Set(
        [
          normalizeUrl(page.url),
          page.canonical ? normalizeUrl(page.canonical) : null,
        ].filter(Boolean)
      );

      const hasSelf = page.hreflang.some(
        (h) => h.url && self.has(normalizeUrl(h.url))
      );

      if (hasSelf) {
        return null;
      }

      // The page's own language from <html lang>, when it is a valid code no other link uses.
      const used = new Set(page.hreflang.map((h) => h.lang.toLowerCase()));
      const lang = page.lang?.toLowerCase() ?? "";
      const knownLang = HREFLANG_CODE.test(lang) && !used.has(lang);
      const local = isLocal(page);
      const target = page.canonical ?? normalizeUrl(page.url) ?? page.url;

      const write = [
        knownLang
          ? undefined
          : "This page's language code (and region, if the other links use one), such as en or en-gb.",
        local ? ORIGIN_WRITE : undefined,
        "Add the same link on every page of the set.",
      ]
        .filter(Boolean)
        .join(" ");

      return make("hreflang set has no entry pointing at this page.", {
        fix: [
          addHtml(
            "head",
            `<link rel="alternate" hreflang="${knownLang ? escapeAttribute(lang) : slot("language code")}" href="${local ? liveUrl(target, true) : escapeAttribute(target)}">`,
            write
          ),
        ],
        selector: 'link[rel="alternate"][hreflang]',
        evidence: {
          page: page.url,
          alternates: cap(page.hreflang.map((h) => `${h.lang} → ${h.href}`)),
        },
      });
    }
  ),
  defineRule(
    {
      id: "hreflang.missing-x-default",
      category: "international",
      severity: "info",
      description: "The hreflang set has no x-default entry.",
      recommendation:
        'Add <link rel="alternate" hreflang="x-default" href="..."> pointing at the language-selector or default version.',
      docs: GOOGLE_DOCS.hreflang,
    },
    ({ page }, make) =>
      page.hreflang.length > 0 &&
      !page.hreflang.some((h) => h.lang.toLowerCase() === "x-default")
        ? make("hreflang set has no x-default entry.", {
            fix: [
              addHtml(
                "head",
                `<link rel="alternate" hreflang="x-default" href="${slot("fallback page URL")}">`,
                `The absolute URL of the page for visitors whose language has no version of its own: a language picker, or the main version (one of ${cap(
                  page.hreflang.map((h) => h.href),
                  3
                ).join(", ")}). Add the same link on every page of the set.`
              ),
            ],
            selector: 'link[rel="alternate"][hreflang]',
          })
        : null
  ),
  defineRule(
    {
      id: "hreflang.canonical-other-language",
      category: "international",
      severity: "warning",
      description:
        "The canonical points to an hreflang alternate in another language, so search engines treat this page as a copy of that one and leave it out of the index.",
      recommendation:
        "Give each language version a canonical that names its own URL, and let hreflang link the versions. Google asks for a canonical in the same language as the page.",
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page, source }, make) => {
      if (!page.canonical || page.hreflang.length === 0) {
        return null;
      }

      const pathOnly = source !== "url" || isLocal(page);
      const canonical = setKey(page.canonical, pathOnly);
      const self = setKey(page.url, pathOnly);

      if (canonical === null || canonical === self) {
        return null;
      }

      const named = (h: HreflangInfo, key: string | null) =>
        h.url !== null &&
        h.lang.toLowerCase() !== "x-default" &&
        setKey(h.url, pathOnly) === key;

      const target = page.hreflang.find((h) => named(h, canonical));

      // The page's language by its own hreflang entry and by <html lang>. Both must differ from the
      // canonical's: a page not translated yet often keeps the original's text and its <html lang>.
      const own = [
        page.hreflang.find((h) => named(h, self))?.lang,
        page.lang,
      ].filter(
        (code): code is string =>
          typeof code === "string" &&
          code.toLowerCase() !== "x-default" &&
          HREFLANG_CODE.test(code)
      );

      if (
        !target ||
        own.length === 0 ||
        own.some((code) => languageOf(code) === languageOf(target.lang))
      ) {
        return null;
      }

      const [ownLang = ""] = own;

      return make(
        `This ${ownLang} page names its ${target.lang} version, ${page.canonical}, as canonical.`,
        {
          fix: [
            pointCanonical(
              page,
              selfUrl(page),
              `If this page still shows the ${target.lang} text because it has not been translated yet, keep the canonical and take the page out of the hreflang set until it is.`
            ),
          ],
          selector: 'head > link[rel="canonical"]',
          evidence: {
            page: page.url,
            language: ownLang,
            canonical: page.canonical,
            canonicalLanguage: target.lang,
          },
        }
      );
    }
  ),
];
