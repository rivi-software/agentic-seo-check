import { normalizeUrl } from "../url.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

const HREFLANG_CODE =
  /^(?:x-default|[a-zA-Z]{2,3}(?:-[a-zA-Z]{4})?(?:-(?:[a-zA-Z]{2}|\d{3}))?)$/u;

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

      return bad.length
        ? make(`${bad.length} hreflang value(s) are invalid.`, {
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

      return rel.length
        ? make(`${rel.length} hreflang link(s) use relative URLs.`, {
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

      return dupes.length
        ? make(`hreflang codes with conflicting URLs: ${dupes.join(", ")}.`, {
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

      return hasSelf
        ? null
        : make("hreflang set has no entry pointing at this page.", {
            selector: 'link[rel="alternate"][hreflang]',
            evidence: {
              page: page.url,
              alternates: cap(
                page.hreflang.map((h) => `${h.lang} → ${h.href}`)
              ),
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
            selector: 'link[rel="alternate"][hreflang]',
          })
        : null
  ),
];
