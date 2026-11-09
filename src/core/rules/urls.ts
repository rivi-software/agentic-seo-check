import type { ExtractedPage, FixEdit, PageSource } from "../types.js";
import { hostOf, resolveUrl } from "../url.js";
import { isLocalHost } from "./canonical.js";
import {
  addEdit,
  addHtml,
  escapeAttribute,
  replaceHtml,
  setAttributeEdit,
  slot,
} from "./fix.js";
import {
  ORIGIN_SLOT_WRITE,
  permanentRedirect,
  withoutParameters,
} from "./page-fixes.js";
import { cap, defineRule, GOOGLE_DOCS } from "./rule.js";

/** A CSS attribute value in double quotes. */
const cssString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;

/** Query parameters that only tell analytics where a click came from. */
const TRACKING_PARAMETERS = new Set([
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "_hsenc",
  "_hsmi",
]);

const isTrackingParameter = (name: string): boolean => {
  const key = name.toLowerCase();

  return key.startsWith("utm_") || TRACKING_PARAMETERS.has(key);
};

/** Parameter names servers use for session ids, and the shortest value that looks like one. */
const SESSION_PARAMETERS = new Map([
  ["jsessionid", 8],
  ["phpsessid", 8],
  ["sessionid", 8],
  ["session_id", 8],
  ["sessid", 8],
  ["cfid", 4],
  ["cftoken", 8],
  ["zenid", 8],
  ["oscsid", 8],
  // "sid" also stands for a site or store id; only a long token is a session.
  ["sid", 16],
]);

/** A session id in the URL's query or as a `;jsessionid=` path parameter, or null. */
const sessionParameter = (url: string): string | null => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (/;jsessionid=/iu.test(parsed.pathname)) {
    return "jsessionid";
  }

  for (const [name, value] of parsed.searchParams) {
    const key = name.toLowerCase();

    const minLength = key.startsWith("aspsessionid")
      ? 8
      : SESSION_PARAMETERS.get(key);

    if (minLength !== undefined && value.length >= minLength) {
      return name;
    }
  }

  return null;
};

/** The page URL's path, or null when the URL is not one a visitor can request. */
const pagePath = (page: ExtractedPage, source: PageSource): string | null => {
  if (source === "html") {
    return null;
  }

  try {
    return new URL(page.url).pathname;
  } catch {
    return null;
  }
};

/**
 * A locale segment such as en-US, en-us, pt_BR, es-419, zh-Hans or zh-Hant-TW, whose case and
 * underscore are conventions: a lowercase language, then an optional Title-case script and an
 * optional two-letter or three-digit region. "Our-Team" and "how_to_cook" do not match.
 */
const LOCALE_SEGMENT =
  /^[a-z]{2,3}(?:[-_][A-Z][a-z]{3})?(?:[-_](?:[A-Za-z]{2}|\d{3}))?$/u;

/** The path without locale segments, which are spelled the way the locale is. */
const pathWithoutLocales = (path: string): string =>
  path
    .split("/")
    .filter((segment) => !LOCALE_SEGMENT.test(segment))
    .join("/");

/**
 * The page's URL with each path segment respelled (locale segments as they are), as the page names
 * itself: absolute on a live site, a path for files and dev servers.
 */
const respelled = (
  page: ExtractedPage,
  source: PageSource,
  respell: (segment: string) => string
): { variant: string; target: string } | null => {
  let url: URL;

  try {
    url = new URL(page.url);
  } catch {
    return null;
  }

  const path = url.pathname
    .split("/")
    .map((segment) =>
      LOCALE_SEGMENT.test(segment) ? segment : respell(segment)
    )
    .join("/");

  const absolute = source === "url" && !isLocalHost(page.url);
  const variant = `${absolute ? url.origin : ""}${path}${url.search}`;
  const target = `${absolute ? url.origin : ""}${url.pathname}${url.search}`;

  return { variant, target };
};

/**
 * The redirect that sends another spelling of the page's path to the page. The page keeps its URL:
 * renaming an indexed URL costs more than the spelling.
 */
const spellingRedirect = (
  page: ExtractedPage,
  source: PageSource,
  respell: (segment: string) => string,
  write: string
): FixEdit[] => {
  const spelling = respelled(page, source, respell);

  return spelling
    ? [
        addEdit("http", "status line", permanentRedirect(spelling.target), {
          url: spelling.variant,
          write,
        }),
      ]
    : [];
};

/** A path segment in lowercase, its percent-escapes kept uppercase as they are written. */
const lowercaseSegment = (segment: string): string =>
  segment.toLowerCase().replaceAll(/%[\da-f]{2}/gu, (m) => m.toUpperCase());

/** A path segment with hyphens where underscores join words. */
const hyphenatedSegment = (segment: string): string =>
  segment.replaceAll(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, "-");

/** The edit that rewrites a link's href without the parameters `drop` selects. */
const cleanLinkEdit = (
  page: ExtractedPage,
  link: ExtractedPage["links"][number],
  drop: (name: string) => boolean,
  write?: string
): FixEdit =>
  setAttributeEdit(
    link.tag,
    `a[href=${cssString(link.href)}]`,
    "href",
    escapeAttribute(withoutParameters(link.href, page.url, drop)),
    write
  );

const KEEP_EXISTING_URLS =
  "Do not rename URLs that are already indexed or linked to only for this: a rename needs a 301 redirect from every old URL and resets what search engines know about the page. Apply it to new URLs.";

/** Private networks: an address there resolves only inside one office or one machine. */
const isPrivateAddress = (host: string): boolean =>
  /^(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) ||
  /^192\.168\.\d{1,3}\.\d{1,3}$/u.test(host) ||
  /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/u.test(host);

const isDevHost = (url: string): boolean => {
  const host = hostOf(url);

  return host !== null && (isLocalHost(url) || isPrivateAddress(host));
};

/** Every URL the page links to or loads from, once, with the first place it is written. */
const urlsOnPage = (page: ExtractedPage): { url: string; where: string }[] => {
  const out = new Map<string, string>();

  const add = (raw: string | null | undefined, where: string) => {
    const url = raw ? resolveUrl(raw, page.url) : null;

    if (url && !out.has(url)) {
      out.set(url, where);
    }
  };

  add(page.canonical, '<link rel="canonical">');

  for (const h of page.hreflang) {
    add(h.url, `<link rel="alternate" hreflang="${h.lang}">`);
  }

  add(page.og["url"], "og:url");
  add(page.og["image"], "og:image");

  for (const link of page.links) {
    add(link.url, "<a href>");
  }

  for (const image of page.images) {
    add(image.src, "<img src>");
  }

  for (const resource of page.resources) {
    add(resource.url, resource.kind);
  }

  return [...out].map(([url, where]) => ({ url, where }));
};

/** The origin of a development-host URL, to swap for the production one. */
const devOrigin = (raw: string): string | null => {
  const match = /^(?:https?:)?\/\/[^/?#]+/iu.exec(raw.trim());

  return match ? match[0] : null;
};

/**
 * Edits that move every URL on a development host to the production origin: the canonical, the
 * hreflang links, og:url and og:image, links, images and resources, each in the tag that has it.
 */
const localHostEdits = (page: ExtractedPage): FixEdit[] => {
  const origin = slot("https://www.example.com");
  const edits: FixEdit[] = [];
  const seen = new Set<string>();

  const add = (
    raw: string | null | undefined,
    tag: string | undefined,
    at: string,
    attribute: string
  ) => {
    const from = raw ? devOrigin(raw) : null;
    const absolute = raw ? resolveUrl(raw, page.url) : null;

    if (!raw || !from || !absolute || !isDevHost(absolute)) {
      return;
    }

    // A URL quoted on its own stops before any "&", which the source may write as "&amp;".
    const quoted = tag ? raw : (raw.split("&")[0] ?? raw);
    const moved = `${origin}${quoted.trim().slice(from.length)}`;
    const key = `${at}|${raw}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    if (tag === undefined) {
      edits.push(replaceHtml(quoted, moved, { at, write: ORIGIN_SLOT_WRITE }));

      return;
    }

    edits.push(
      tag.includes(raw)
        ? replaceHtml(
            tag,
            tag.replace(raw, () => moved),
            {
              at,
              write: ORIGIN_SLOT_WRITE,
            }
          )
        : setAttributeEdit(tag, at, attribute, moved, ORIGIN_SLOT_WRITE)
    );
  };

  for (const [i, raw] of page.canonicals.entries()) {
    add(raw, page.markup.canonicals[i], 'head > link[rel="canonical"]', "href");
  }

  for (const h of page.hreflang) {
    add(h.href, h.tag, `link[hreflang=${cssString(h.lang)}]`, "href");
  }

  for (const property of ["url", "image"] as const) {
    add(
      page.og[property],
      page.markup.social[`og:${property}`],
      `head > meta[property="og:${property}"]`,
      "content"
    );
  }

  for (const resource of page.resources) {
    add(
      resource.raw,
      undefined,
      `${resource.element}[${resource.attribute}*=${cssString(resource.raw)}]`,
      resource.attribute
    );
  }

  for (const link of page.links) {
    add(link.href, link.tag, `a[href=${cssString(link.href)}]`, "href");
  }

  return edits;
};

/**
 * `url`, which `raw` resolves to, cut where `raw` is cut at its first "&": the query after it is
 * the same in both, while a <base href> before it may hold an "&" of its own.
 */
const cutLikeRaw = (url: string, raw: string): string => {
  let cut = url.length;

  for (let n = raw.split("&").length - 1; n > 0 && cut > 0; n -= 1) {
    cut = url.lastIndexOf("&", cut - 1);
  }

  return cut > 0 ? url.slice(0, cut) : url;
};

/**
 * Edits that load each insecure resource over https, once per URL as the page writes it. Only the
 * scheme changes, so the quote stops before any "&", which the source may write as "&amp;".
 */
const httpsEdits = (resources: ExtractedPage["resources"]): FixEdit[] => {
  const seen = new Set<string>();
  const edits: FixEdit[] = [];

  for (const r of resources) {
    const quoted = r.raw.split("&")[0] ?? r.raw;

    if (seen.has(quoted)) {
      continue;
    }

    seen.add(quoted);
    const at = `${r.element}[${r.attribute}*=${cssString(quoted)}]`;

    // A relative URL is http:// only through an http <base href>: it is written out in full.
    edits.push(
      /^http:/iu.test(quoted)
        ? replaceHtml(quoted, quoted.replace(/^http:/iu, "https:"), { at })
        : replaceHtml(
            quoted,
            cutLikeRaw(r.url, r.raw).replace(/^http:/iu, "https:"),
            {
              at,
              write:
                "The page's <base href> is on http://; make it https:// too, and check that the https URL exists.",
            }
          )
    );
  }

  return edits;
};

export const urlRules = [
  defineRule(
    {
      id: "url.uppercase",
      category: "links",
      severity: "info",
      description:
        "The page's URL path has uppercase letters. Google treats /Page and /page as two URLs, so links that differ in case split signals or end in a 404.",
      recommendation: `Use lowercase paths for new pages, and redirect (301) other spellings of the path to the one you keep. ${KEEP_EXISTING_URLS}`,
      docs: GOOGLE_DOCS.urlStructure,
    },
    ({ page, source }, make) => {
      const path = pagePath(page, source);

      // Percent-escapes such as %C3%A9 are uppercase by convention, not part of the path's spelling.
      return path &&
        /[A-Z]/u.test(pathWithoutLocales(path).replaceAll(/%[\dA-F]{2}/giu, ""))
        ? make(`The URL path ${path} has uppercase letters.`, {
            fix: spellingRedirect(
              page,
              source,
              lowercaseSegment,
              "Have the lowercase spelling of the path redirect to this page, so links that differ in case reach it; whatever it answers now (404 or a copy of the page). For new pages, use lowercase paths from the start."
            ),
            evidence: { path },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "url.underscores",
      category: "links",
      severity: "info",
      description:
        "The page's URL path separates words with underscores; Google recommends hyphens.",
      recommendation: `Separate words in new URLs with hyphens (/blue-widgets, not /blue_widgets). ${KEEP_EXISTING_URLS}`,
      docs: GOOGLE_DOCS.urlStructure,
    },
    ({ page, source }, make) => {
      const path = pagePath(page, source);

      // Underscores in a word (/blue_widgets), not as a leading marker (/_next/, /_assets/).
      return path && /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(pathWithoutLocales(path))
        ? make(`The URL path ${path} uses underscores between words.`, {
            fix: spellingRedirect(
              page,
              source,
              hyphenatedSegment,
              "Have the hyphenated spelling of the path redirect to this page, in case links use it. For new pages, separate words with hyphens from the start; keep this indexed URL as it is."
            ),
            evidence: { path },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "url.session-id",
      category: "links",
      severity: "warning",
      description:
        "The page's URL or its internal links carry a session id (jsessionid, PHPSESSID, sid), so every visit creates new URLs for the same content.",
      recommendation:
        "Keep sessions in a cookie, not in the URL. In Java servlet containers, set the session tracking mode to COOKIE; in PHP, set session.use_trans_sid=0 and session.use_only_cookies=1.",
      docs: GOOGLE_DOCS.urlStructure,
    },
    ({ page, source }, make) => {
      const own = pagePath(page, source) ? sessionParameter(page.url) : null;

      const links = page.links.filter(
        (l) => l.internal && l.url && sessionParameter(l.url)
      );

      if (!own && links.length === 0) {
        return null;
      }

      const parameter =
        own ?? (links[0]?.url ? sessionParameter(links[0].url) : null);

      const isSession = (name: string) =>
        name.toLowerCase() === parameter?.toLowerCase() ||
        name.toLowerCase() === "jsessionid";

      const serverSetting =
        "Then keep the session in a cookie: in a Java servlet container, <tracking-mode>COOKIE</tracking-mode> in web.xml's <session-config>; in PHP, session.use_trans_sid=0 and session.use_only_cookies=1.";

      // The page names its clean URL as canonical, so the session spelling folds into it.
      const [canonicalTag] = page.markup.canonicals;

      const clean = own
        ? withoutParameters(page.url, page.url, isSession)
        : null;

      const ownEdit: FixEdit[] = clean
        ? [
            canonicalTag
              ? setAttributeEdit(
                  canonicalTag,
                  'head > link[rel="canonical"]',
                  "href",
                  escapeAttribute(clean),
                  serverSetting
                )
              : addHtml(
                  "head",
                  `<link rel="canonical" href="${escapeAttribute(clean)}">`,
                  serverSetting
                ),
          ]
        : [];

      return make(
        own
          ? `The page URL carries a session id (${own}).`
          : `${links.length} internal link(s) carry a session id (${parameter}).`,
        {
          fix: [
            ...ownEdit,
            ...links.map((link, i) =>
              cleanLinkEdit(
                page,
                link,
                isSession,
                i === 0 && ownEdit.length === 0 ? serverSetting : undefined
              )
            ),
          ],
          evidence: {
            parameter,
            pageUrl: own ? page.url : null,
            links: links.length,
            examples: cap(links.map((l) => l.url)),
          },
        }
      );
    }
  ),
  defineRule(
    {
      id: "links.tracking-parameters",
      category: "links",
      severity: "info",
      description:
        "Internal links carry campaign tracking parameters (utm_*, gclid, fbclid), which make crawlers fetch duplicate URLs and overwrite the visit's real traffic source in analytics.",
      recommendation:
        "Link to the clean URL. Campaign parameters belong on links from emails, ads and other sites, not on links between your own pages; to measure which banner or menu item was clicked, use an analytics event instead.",
      docs: GOOGLE_DOCS.urlStructure,
    },
    ({ page }, make) => {
      const tagged = page.links.filter((l) => {
        if (!l.internal || !l.url) {
          return false;
        }

        try {
          return [...new URL(l.url).searchParams.keys()].some(
            isTrackingParameter
          );
        } catch {
          return false;
        }
      });

      return tagged.length > 0
        ? make(`${tagged.length} internal link(s) carry tracking parameters.`, {
            fix: tagged.map((link) =>
              cleanLinkEdit(page, link, isTrackingParameter)
            ),
            evidence: {
              count: tagged.length,
              examples: cap(tagged.map((l) => l.url)),
            },
          })
        : null;
    }
  ),
  defineRule(
    {
      id: "links.local-host",
      category: "links",
      severity: "error",
      description:
        "A public page's canonical, og:url, og:image, hreflang, images or scripts point to localhost, a .local or .test host, or a private network address, which work only on the developer's machine (error). Only <a> links there is info: a setup guide may mean them.",
      recommendation:
        "Build these URLs from the production site URL (an environment variable such as SITE_URL) instead of the development server's, or make them relative. Check the canonical, og:url and og:image first: a canonical on localhost points search engines at a page they cannot reach.",
    },
    ({ page, source }, make) => {
      if (source === "html" || isDevHost(page.url)) {
        return null;
      }

      const local = urlsOnPage(page).filter((u) => isDevHost(u.url));

      if (local.length === 0) {
        return null;
      }

      const places = [...new Set(local.map((u) => u.where))];
      const fix = localHostEdits(page);

      // A tutorial may link to http://localhost:3000 on purpose, for the reader's own machine.
      const onlyAnchors = places.every((w) => w === "<a href>");

      return make(
        `${local.length} URL(s) on the page point to a development host (${cap(places, 4).join(", ")}).`,
        {
          severity: onlyAnchors ? "info" : "error",
          recommendation: onlyAnchors
            ? "If these links are meant for the reader's own machine (a setup guide), leave them. Otherwise build them from the production site URL or make them relative."
            : undefined,
          fix,
          evidence: {
            count: local.length,
            examples: cap(local.map((u) => `${u.where}: ${u.url}`)),
          },
        }
      );
    }
  ),
  defineRule(
    {
      id: "links.missing-fragment",
      category: "links",
      severity: "info",
      description:
        'Same-page links (href="#name") point to an id that no element on the page has, so the link goes nowhere.',
      recommendation:
        'Give the target element the id the link names, or fix the link. If JavaScript handles the click (a menu or modal toggle), use a <button> instead of <a href="#...">.',
    },
    ({ page }, make) =>
      page.missingFragments.length > 0
        ? make(
            `${page.missingFragments.length} same-page link(s) point to ids that are not on the page: ${cap(page.missingFragments, 5).join(", ")}.`,
            {
              fix: page.missingFragments.map((href) =>
                addHtml(
                  `the element ${href} should scroll to`,
                  `id="${escapeAttribute(href.slice(1))}"`,
                  `Put this id on the section or heading the link ${href} means. If a script handles the click instead (a menu or modal toggle), make the link a <button type="button">.`
                )
              ),
              selector: cap(page.missingFragments, 5)
                .map((href) => `a[href="${href.replaceAll('"', '\\"')}"]`)
                .join(", "),
              evidence: { fragments: cap(page.missingFragments) },
            }
          )
        : null
  ),
  defineRule(
    {
      id: "https.mixed-content",
      category: "document",
      severity: "warning",
      description:
        "An https page loads resources over http. Browsers block scripts, stylesheets, frames and responsive images (warning) and upgrade plain images, audio and video to https, which fails when the https URL does not exist (info). With a Content-Security-Policy of upgrade-insecure-requests, every resource is upgraded (info).",
      recommendation:
        "Load every resource over https: change http:// URLs to https:// (or make them relative), and host or replace any resource that has no https version. A Content-Security-Policy of upgrade-insecure-requests upgrades the rest.",
      docs: "https://web.dev/articles/what-is-mixed-content",
    },
    ({ page, source, response }, make) => {
      if (source !== "url" || !page.url.startsWith("https://")) {
        return null;
      }

      const insecure = page.resources.filter((r) =>
        r.url.startsWith("http://")
      );

      // upgrade-insecure-requests (meta tag or header) has the browser request all of them over https.
      const upgradesAll =
        page.upgradesInsecureRequests ||
        // Several CSP headers arrive joined with ", ", and a comma separates policies.
        /(?:^|[;,])\s*upgrade-insecure-requests\s*(?:[;,]|$)/iu.test(
          response?.headers["content-security-policy"] ?? ""
        );

      const isUpgraded = (r: (typeof insecure)[number]) =>
        upgradesAll || r.kind === "image" || r.kind === "media";

      const blocked = insecure.filter((r) => !isUpgraded(r));
      const upgraded = insecure.filter(isUpgraded);

      const examples = (list: typeof blocked) =>
        cap(list.map((r) => `${r.kind}: ${r.url}`));

      const fixOf = (list: typeof blocked) => httpsEdits(list);

      return [
        blocked.length > 0
          ? make(
              `Browsers block ${blocked.length} resource(s) the page loads over http (${[...new Set(blocked.map((r) => r.kind))].join(", ")}).`,
              {
                fix: fixOf(blocked),
                key: "blocked",
                evidence: {
                  count: blocked.length,
                  examples: examples(blocked),
                },
              }
            )
          : null,
        upgraded.length > 0
          ? make(
              `${upgraded.length} resource URL(s) use http; browsers upgrade them to https, which fails where the https URL does not exist.`,
              {
                severity: "info",
                fix: fixOf(upgraded),
                key: "upgraded",
                evidence: {
                  count: upgraded.length,
                  examples: examples(upgraded),
                },
              }
            )
          : null,
      ].filter((f) => f !== null);
    }
  ),
];
