import { isGenericAnchor } from "../html/text.js";
import type { FixEdit, LinkInfo } from "../types.js";
import {
  addHtml,
  escapeAttribute,
  replaceHtml,
  setAttributeEdit,
  slot,
  withContent,
  withoutAttribute,
} from "./fix.js";
import { withAttributeSelector } from "./quoted-tags.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** The selector of one link, by its href as written. */
const linkAt = (link: LinkInfo): string =>
  withAttributeSelector("a", "href", link.href);

/** The link's start tag with rel="nofollow" taken out, keeping its other rel values. */
const withoutNofollow = (link: LinkInfo): FixEdit => {
  const rel = (link.rel ?? "")
    .split(/\s+/u)
    .filter((token) => token && token.toLowerCase() !== "nofollow");

  const at = linkAt(link);

  const write =
    "Unless the target page is kept out of search on purpose; then link to it less, or noindex it.";

  if (rel.length > 0) {
    return setAttributeEdit(
      link.tag,
      at,
      "rel",
      escapeAttribute(rel.join(" ")),
      write
    );
  }

  const code = withoutAttribute(link.tag, "rel");

  return code
    ? replaceHtml(link.tag, code, { at, write })
    : setAttributeEdit(null, at, "rel", "", write);
};

/**
 * The route a link's fragment holds, as a hash router writes it ("#/products", "#!/products"), or
 * null for an ordinary fragment ("#reviews") and a bare "#/" or "#!", which open nothing.
 */
export const hashRoute = (href: string): string | null => {
  const at = href.indexOf("#");

  if (at === -1) {
    return null;
  }

  const fragment = href.slice(at + 1).trim();
  const route = fragment.startsWith("!") ? fragment.slice(1) : fragment;

  return route.length > 1 && route.startsWith("/") ? route : null;
};

/**
 * The path a hash route becomes under the History API: the route below the app's directory, which
 * is the path before the "#" or else the page's own ("/shop/#/cart" and "#/cart" on /shop/ are
 * both /shop/cart).
 */
const historyPath = (href: string, route: string, pageUrl: string): string => {
  const before = href.slice(0, href.indexOf("#")).trim();
  let base = "/";

  try {
    const url = new URL(before || pageUrl, pageUrl);

    if (url.protocol === "http:" || url.protocol === "https:") {
      base = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    }
  } catch {
    // An href or page URL that does not parse keeps the site root.
  }

  return `${base}${route.slice(1)}`;
};

const HASH_ROUTE_WRITE =
  "Switch the app's router to the History API (React Router's createBrowserRouter, Vue Router's createWebHistory, Angular's PathLocationStrategy) so each view has a path, have the server answer every such path with the app or, better, the view's own HTML, and write links as paths.";

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
            fix: [
              addHtml(
                "body",
                `<a href="${slot("/path-of-a-related-page/")}">${slot("its name")}</a>`,
                "A plain <a href> to a page of this site a visitor would want next, with text that names it; the site's navigation or footer with links to the main sections does the same for every page. The href is a path on this site (/pricing/), not a JavaScript click handler."
              ),
            ],
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
            fix: empty.map((l) =>
              setAttributeEdit(
                l.tag,
                linkAt(l),
                "aria-label",
                slot("where the link goes"),
                `What the link to ${l.href.slice(0, 120)} leads to, in a few words ("Instagram", "Cart"). Visible text inside the link does the same and also gives search engines anchor text.`
              )
            ),
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

      // The whole link as written; when it was cut short, its text, with `at` saying which link.
      const fix = generic.map((l) => {
        const write = `Text that names the destination of ${l.href.slice(0, 120)}, such as "pricing plans" instead of "${l.text.slice(0, 40)}".`;
        const rewritten = withContent(l.outer, slot("what the link leads to"));

        return rewritten
          ? replaceHtml(l.outer, rewritten, { at: linkAt(l), write })
          : replaceHtml(l.text, slot("what the link leads to"), {
              at: linkAt(l),
              write,
            });
      });

      return generic.length
        ? make(`${generic.length} link(s) use generic anchor text.`, {
            fix,
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
        (l) => l.href === "" || l.href === "#" || /^javascript:/iu.test(l.href)
      );

      return bad.length
        ? make(`${bad.length} anchor(s) have an uncrawlable href.`, {
            fix: bad.map((l) =>
              setAttributeEdit(
                l.tag,
                linkAt(l),
                "href",
                slot("URL the link opens"),
                `The URL of the page this link opens, even when JavaScript handles the click. If it runs an action instead of opening a page${l.text ? ` ("${l.text.slice(0, 40)}")` : ""}, make it a <button type="button"> and its </a> a </button>.`
              )
            ),
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
      id: "links.hash-route",
      category: "links",
      severity: "warning",
      description:
        'Internal links whose fragment is a route ("#/products", "#!/products"). Google ignores the fragment, so it cannot reach these views as pages of their own.',
      recommendation:
        "Route with the History API instead of fragments, so each view has a path (/products) the server answers, and link to those paths.",
      docs: GOOGLE_DOCS.javascript,
    },
    ({ page }, make) => {
      const routed = page.links.flatMap((l) => {
        // A same-page href ("#/cart") resolves to no URL of its own, so it is not marked internal.
        const samePage = l.href.trim().startsWith("#");
        const route = l.internal || samePage ? hashRoute(l.href) : null;

        return route ? [{ link: l, route }] : [];
      });

      if (routed.length === 0) {
        return null;
      }

      // One edit per link as written; a menu repeats the same link in the header and the footer.
      const tags = new Set<string>();

      const fix = routed.flatMap(({ link, route }) => {
        if (tags.has(link.tag)) {
          return [];
        }

        tags.add(link.tag);

        return [
          setAttributeEdit(
            link.tag,
            linkAt(link),
            "href",
            escapeAttribute(historyPath(link.href, route, page.url)),
            HASH_ROUTE_WRITE
          ),
        ];
      });

      const hrefs = [...new Set(routed.map(({ link }) => link.href))];

      return make(
        `${routed.length} internal link(s) use the URL fragment as a route: ${cap(hrefs, 5).join(", ")}.`,
        {
          fix,
          evidence: { count: routed.length, examples: cap(hrefs) },
        }
      );
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

      // The href as written with https; one that is not written as http:// gets the full URL.
      const fix = insecure.map((l) =>
        setAttributeEdit(
          l.tag,
          linkAt(l),
          "href",
          escapeAttribute(
            /^http:/iu.test(l.href)
              ? l.href.replace(/^http:/iu, "https:")
              : (l.url ?? l.href).replace(/^http:/iu, "https:")
          )
        )
      );

      return insecure.length
        ? make(`${insecure.length} internal link(s) point to http:// URLs.`, {
            fix,
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
            fix: nf.map((l) => withoutNofollow(l)),
            evidence: { count: nf.length, examples: cap(nf.map((l) => l.url)) },
          })
        : null;
    }
  ),
];
