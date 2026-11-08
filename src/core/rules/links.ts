import { isGenericAnchor } from "../html/text.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

export const linkRules = [
  defineRule(
    {
      id: "links.no-internal",
      category: "links",
      severity: "warning",
      description:
        "The page has no internal links, so crawlers cannot reach other pages from it and it passes no authority onward.",
      recommendation:
        "Link to related pages and the main navigation with plain <a href> elements.",
      docs: GOOGLE_DOCS.links,
    },
    ({ page }, make) =>
      page.links.some((l) => l.internal)
        ? null
        : make("Page contains no internal links.", {
            evidence: { totalLinks: page.links.length },
          })
  ),
  defineRule(
    {
      id: "links.empty-anchor",
      category: "links",
      severity: "warning",
      description:
        "Links without any accessible name (no text, aria-label, title or image alt).",
      recommendation:
        "Add descriptive link text, or aria-label for icon links. Empty links tell crawlers nothing about the target page.",
      docs: GOOGLE_DOCS.links,
    },
    ({ page }, make) => {
      const empty = page.links.filter((l) => l.url && !l.hasAccessibleName);

      return empty.length
        ? make(`${empty.length} link(s) have no accessible text.`, {
            evidence: {
              count: empty.length,
              examples: cap(empty.map((l) => l.href)),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "links.generic-anchor-text",
      category: "links",
      severity: "info",
      description:
        'Links whose text is generic ("click here", "read more", "learn more").',
      recommendation:
        'Use anchor text that describes the destination, e.g. "pricing plans" instead of "click here".',
      docs: GOOGLE_DOCS.links,
    },
    ({ page }, make) => {
      const generic = page.links.filter(
        (l) => l.url && l.text && isGenericAnchor(l.text)
      );

      return generic.length
        ? make(`${generic.length} link(s) use generic anchor text.`, {
            evidence: {
              count: generic.length,
              examples: cap(
                generic.map((l) => ({ text: l.text, href: l.href }))
              ),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "links.uncrawlable-href",
      category: "links",
      severity: "info",
      description:
        'Anchors whose href is "#", empty, or a javascript: URL. Crawlers cannot follow them.',
      recommendation:
        "Use <button> for actions. For navigation, give the anchor a real URL even when JavaScript intercepts the click.",
      docs: GOOGLE_DOCS.links,
    },
    ({ page }, make) => {
      const bad = page.links.filter(
        (l) => l.href === "" || l.href === "#" || /^javascript:/i.test(l.href)
      );

      return bad.length
        ? make(`${bad.length} anchor(s) have an uncrawlable href.`, {
            evidence: {
              count: bad.length,
              examples: cap(bad.map((l) => ({ href: l.href, text: l.text }))),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "links.insecure-internal",
      category: "links",
      severity: "warning",
      description:
        "Internal links use http:// while the page is served over https://.",
      recommendation:
        "Update internal links to https:// (or use relative URLs) to avoid an extra redirect on every click and crawl.",
      docs: GOOGLE_DOCS.redirects,
    },
    ({ page, source }, make) => {
      if (source !== "url" || !page.url.startsWith("https://")) {
        return null;
      }

      const insecure = page.links.filter(
        (l) => l.internal && l.url?.startsWith("http://")
      );

      return insecure.length
        ? make(`${insecure.length} internal link(s) point to http:// URLs.`, {
            evidence: {
              count: insecure.length,
              examples: cap(insecure.map((l) => l.url)),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "links.nofollow-internal",
      category: "links",
      severity: "info",
      description: 'Internal links carry rel="nofollow".',
      recommendation:
        "Remove nofollow from internal links unless the target is intentionally kept out of the index; nofollow on internal links wastes crawl signals.",
      docs: GOOGLE_DOCS.links,
    },
    ({ page }, make) => {
      const nf = page.links.filter((l) => l.internal && l.nofollow);

      return nf.length
        ? make(`${nf.length} internal link(s) are rel="nofollow".`, {
            evidence: { count: nf.length, examples: cap(nf.map((l) => l.url)) },
          })
        : null;
    }
  ),
];
