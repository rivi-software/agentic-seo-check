import { isTag } from "domhandler";

import type { ResourceInfo } from "../types.js";
import { resolveUrl } from "../url.js";
import { attr, queryAll } from "./dom.js";
import type { Document, Element } from "./dom.js";

/** URLs in a srcset: each candidate is a URL, then an optional width or density. */
const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * The URLs of a srcset, read the way the HTML spec does: a URL runs to the next whitespace, so a
 * data: URL keeps its commas, and a trailing comma ends a candidate that has no descriptor. One
 * pass over the attribute.
 */
export const srcsetUrls = (srcset: string): string[] => {
  const urls: string[] = [];
  let i = 0;

  while (i < srcset.length) {
    while (
      i < srcset.length &&
      (isSpace(srcset[i] ?? "") || srcset[i] === ",")
    ) {
      i += 1;
    }

    const start = i;

    while (i < srcset.length && !isSpace(srcset[i] ?? "")) {
      i += 1;
    }

    let url = srcset.slice(start, i);

    if (url.endsWith(",")) {
      url = url.replace(/,+$/u, "");
    } else {
      // Skip the descriptors ("2x", "480w") up to the comma that ends this candidate.
      let depth = 0;

      while (i < srcset.length && (srcset[i] !== "," || depth > 0)) {
        if (srcset[i] === "(") {
          depth += 1;
        } else if (srcset[i] === ")") {
          depth = Math.max(0, depth - 1);
        }

        i += 1;
      }
    }

    if (url) {
      urls.push(url);
    }
  }

  return urls;
};

const isInPicture = (el: Element): boolean =>
  el.parent !== null && isTag(el.parent) && el.parent.name === "picture";

/**
 * Why browsers treat the resource the way they do: images, audio and video are upgraded to https
 * (an image with srcset or in a <picture> is not), everything else is blocked.
 */
const kindOf = (el: Element): ResourceInfo["kind"] | null => {
  switch (el.name) {
    case "script": {
      return "script";
    }

    case "link": {
      return "stylesheet";
    }

    case "iframe": {
      return "frame";
    }

    case "embed":
    case "object": {
      return "object";
    }

    case "img": {
      return attr(el, "srcset") || isInPicture(el)
        ? "responsive-image"
        : "image";
    }

    case "source": {
      return isInPicture(el) ? "responsive-image" : "media";
    }

    case "audio":
    case "video": {
      return "media";
    }

    // Subtitles are not among the destinations browsers upgrade (image, audio, video).
    case "track": {
      return "track";
    }

    default: {
      return null;
    }
  }
};

const urlsOf = (el: Element): string[] => {
  if (el.name === "link") {
    return [attr(el, "href") ?? ""];
  }

  if (el.name === "object") {
    return [attr(el, "data") ?? ""];
  }

  return [
    attr(el, "src") ?? "",
    ...srcsetUrls(attr(el, "srcset") ?? ""),
    ...(el.name === "video" ? [attr(el, "poster") ?? ""] : []),
  ];
};

/**
 * A Content-Security-Policy meta tag with upgrade-insecure-requests: browsers then request every
 * http:// resource of the page over https instead of blocking it.
 */
export const upgradesInsecureRequests = (doc: Document): boolean =>
  queryAll(doc, "meta[http-equiv]").some(
    (el) =>
      (attr(el, "http-equiv") ?? "").trim().toLowerCase() ===
        "content-security-policy" &&
      /(?:^|;)\s*upgrade-insecure-requests\s*(?:;|$)/iu.test(
        attr(el, "content") ?? ""
      )
  );

/** Scripts, stylesheets, frames, images and media the page loads, with absolute URLs. */
export const extractResources = (
  doc: Document,
  base: string
): ResourceInfo[] => {
  const elements = queryAll(
    doc,
    'script[src], link[rel~="stylesheet" i][href], iframe[src], embed[src], object[data], img, source, audio[src], video, track[src]'
  );

  const out: ResourceInfo[] = [];

  for (const el of elements) {
    const kind = kindOf(el);

    if (!kind) {
      continue;
    }

    for (const raw of urlsOf(el)) {
      const url = raw.trim() ? resolveUrl(raw, base) : null;

      if (url) {
        out.push({ kind, url });
      }
    }
  }

  return out;
};

/** The text a fragment link targets, or null for links that do not target an element. */
const fragmentTarget = (href: string): string | null => {
  let fragment = href.slice(1);

  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // A malformed escape is compared as written.
  }

  // "#top" scrolls to the top without an element; "#!" and "#/" are client-side routes,
  // "#:~:text=" is a text fragment, and a fragment with "=" carries state for a script (a tab, a
  // popup such as Elementor's "#elementor-action:action=popup:open"), not an element id.
  if (
    !fragment ||
    fragment.toLowerCase() === "top" ||
    /^(?:!|\/|:~:)/u.test(fragment) ||
    fragment.includes("=")
  ) {
    return null;
  }

  return fragment;
};

/** `href="#name"` links on the page whose target has no element with that id (or `<a name>`). */
export const extractMissingFragments = (doc: Document): string[] => {
  const links = queryAll(doc, 'a[href^="#"]');

  if (links.length === 0) {
    return [];
  }

  const targets = new Set<string>();

  for (const el of queryAll(doc, "[id], a[name]")) {
    for (const id of [
      attr(el, "id"),
      el.name === "a" ? attr(el, "name") : undefined,
    ]) {
      if (id) {
        targets.add(id);
      }
    }
  }

  const missing = new Set<string>();

  for (const el of links) {
    const href = (attr(el, "href") ?? "").trim();
    const target = fragmentTarget(href);

    if (target !== null && !targets.has(target)) {
      missing.add(href);
    }
  }

  return [...missing];
};
