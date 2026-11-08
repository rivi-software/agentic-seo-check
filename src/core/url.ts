import path from "node:path";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "ref",
]);

const NON_HTML_EXTENSIONS = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".bmp",
  ".tiff",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".mov",
  ".avi",
  ".zip",
  ".gz",
  ".tar",
  ".rar",
  ".7z",
  ".dmg",
  ".exe",
  ".msi",
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".json",
  ".xml",
  ".txt",
  ".rss",
  ".atom",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
]);

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Resolve `href` against `base`, returning null for non-http(s) or unparsable values. */
export function resolveUrl(href: string, base: string): string | null {
  const trimmed = href.trim();

  if (!trimmed) {
    return null;
  }

  if (
    /^(mailto|tel|sms|javascript|data|blob|file|ftp|whatsapp|skype):/i.test(
      trimmed
    )
  ) {
    return null;
  }

  try {
    const url = new URL(trimmed, base);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

/**
 * Canonical form used for visited-sets and comparisons: lower-cased scheme/host,
 * default ports dropped, fragment removed, tracking parameters removed.
 * Path and remaining query are kept verbatim (trailing slashes matter to servers).
 */
export function normalizeUrl(input: string): string | null {
  try {
    const url = new URL(input);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    url.hash = "";
    url.hostname = url.hostname.toLowerCase();

    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }

    const params = [...url.searchParams.keys()];

    for (const key of params) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    if ([...url.searchParams.keys()].length === 0) {
      url.search = "";
    }

    return url.href;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function stripWww(host: string): string {
  return host.replace(/^www\./i, "");
}

/** Same site: identical host ignoring `www.`; optionally any subdomain of the start host. */
export function isSameSite(
  candidate: string,
  startHost: string,
  includeSubdomains = false
): boolean {
  const host = hostOf(candidate);

  if (!host) {
    return false;
  }

  const a = stripWww(host);
  const b = stripWww(startHost.toLowerCase());

  if (a === b) {
    return true;
  }

  return includeSubdomains && a.endsWith(`.${b}`);
}

/** Heuristic: does the path look like it points at an HTML document (not an asset)? */
export function looksLikeHtml(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const ext = path.posix.extname(pathname).toLowerCase();

    if (!ext) {
      return true;
    }

    if (
      ext === ".html" ||
      ext === ".htm" ||
      ext === ".php" ||
      ext === ".asp" ||
      ext === ".aspx" ||
      ext === ".jsp"
    ) {
      return true;
    }

    return !NON_HTML_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

/** Compare two URLs by path only (used for static-directory audits where the host is synthetic). */
export function samePath(a: string, b: string): boolean {
  try {
    return (
      normalizePath(new URL(a).pathname) === normalizePath(new URL(b).pathname)
    );
  } catch {
    return false;
  }
}

/** `/dir/index.html` -> `/dir/`, `/page.html` -> `/page`, trailing slash dropped except root. */
export function normalizePath(pathname: string): string {
  let p = pathname;

  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as-is */
  }

  p = p.replace(/\/index\.html?$/i, "/");
  p = p.replace(/\.html?$/i, "");

  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }

  return p === "" ? "/" : p;
}

export function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
