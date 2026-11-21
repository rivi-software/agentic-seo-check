/**
 * The videos a page shows as content: `<video>` elements a visitor can play and the players of the
 * common video hosts, embedded in an `<iframe>`. Google indexes a video it finds on a page and
 * reads VideoObject structured data to understand it (structured-data.video-missing).
 */
import type { VideoInfo } from "../types.js";
import { resolveUrl } from "../url.js";
import { attr, hasAttr, queryAll, queryOne } from "./dom.js";
import type { Document, Element } from "./dom.js";

/** Videos read per page at most. */
const MAX_VIDEOS = 20;

/**
 * Where a video is page furniture rather than content: a menu or sidebar, or an element that does
 * not render (a <template> a script stamps out, a <noscript> fallback).
 */
const OUTSIDE_CONTENT = new Set([
  "nav",
  "aside",
  "template",
  "noscript",
  "svg",
]);

/** The site's header and footer, unless an <article> or <main> holds them: then they are its own. */
const SITE_CHROME = new Set(["header", "footer"]);

const CONTENT_ROOTS = new Set(["article", "main"]);

const inContent = (el: Element): boolean => {
  let inChrome = false;

  for (let node = el.parent; node; node = node.parent) {
    if (!("name" in node)) {
      continue;
    }

    if (OUTSIDE_CONTENT.has(node.name)) {
      return false;
    }

    if (CONTENT_ROOTS.has(node.name)) {
      inChrome = false;
    } else if (SITE_CHROME.has(node.name)) {
      inChrome = true;
    }
  }

  return !inChrome;
};

/** Hosts whose iframe player shows a video, and the paths their players live at. */
const PLAYERS: { host: RegExp; path: RegExp }[] = [
  {
    host: /^(?:www\.)?youtube(?:-nocookie)?\.com$/u,
    path: /^\/embed\/[\w-]+/u,
  },
  { host: /^player\.vimeo\.com$/u, path: /^\/video\/\d+/u },
  { host: /^(?:www\.)?dailymotion\.com$/u, path: /^\/embed\/video\//u },
  { host: /^fast\.wistia\.(?:net|com)$/u, path: /^\/embed\//u },
  { host: /^(?:www\.)?loom\.com$/u, path: /^\/embed\//u },
];

const isPlayer = (url: string): boolean => {
  const { hostname, pathname } = new URL(url);

  return PLAYERS.some((p) => p.host.test(hostname) && p.path.test(pathname));
};

/** A YouTube player's video id, for the thumbnail YouTube serves at a fixed address. */
const youtubeId = (url: string): string | null => {
  const { hostname, pathname } = new URL(url);

  return /youtube/u.test(hostname)
    ? (/^\/embed\/(?<id>[\w-]{6,20})$/u.exec(pathname)?.groups?.id ?? null)
    : null;
};

/**
 * A <video> a visitor watches has controls to play it. One without them is a moving background or
 * an animation a script starts (muted, often looping): the decorative videos Google does not treat
 * as a page's video. Players that draw their own controls keep `controls` in the HTML as the
 * fallback before their script runs.
 */
const isWatchable = (el: Element): boolean => hasAttr(el, "controls");

export const extractVideos = (doc: Document, base: string): VideoInfo[] => {
  const out: VideoInfo[] = [];

  for (const el of queryAll(doc, "body video, body iframe[src]")) {
    if (out.length >= MAX_VIDEOS) {
      break;
    }

    if (!inContent(el)) {
      continue;
    }

    if (el.name === "iframe") {
      const url = resolveUrl(attr(el, "src") ?? "", base);

      if (url && isPlayer(url)) {
        const id = youtubeId(url);

        out.push({
          kind: "embed",
          url,
          thumbnail: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
        });
      }

      continue;
    }

    if (!isWatchable(el)) {
      continue;
    }

    const source = queryOne(el, "source[src]");
    const src = attr(el, "src") ?? (source ? attr(source, "src") : undefined);
    const poster = attr(el, "poster");

    out.push({
      kind: "video",
      url: src ? resolveUrl(src, base) : null,
      thumbnail: poster ? resolveUrl(poster, base) : null,
    });
  }

  return out;
};
