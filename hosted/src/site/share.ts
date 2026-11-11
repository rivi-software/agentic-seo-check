/**
 * A report's share link (issue #54). The site keeps no report, so the link holds the result
 * itself: the address, the day, the two scores and their counts, in base64url, and an HMAC of
 * them with the Worker secret SHARE_KEY. The share page and its image show a result only when
 * the HMAC matches, so a link cannot claim a score the audit did not give, and the image is only
 * ever drawn for a result the form produced. SHARE_KEY_PREVIOUS is checked too and never signs,
 * so the links made before a new key keep working.
 */
import { z } from "zod";

import { PRODUCT_NAME } from "../../../src/brand.js";
import type {
  AeoAudit,
  PageAudit,
  SiteAudit,
  SeverityCounts,
} from "../../../src/core/types.js";
import { X_ACCOUNT } from "../ui/frame.js";
import { SITE_ORIGIN } from "./layout.js";

export interface ShareEnv {
  /** Signs and checks share links; reports have no Share button without it. */
  SHARE_KEY?: string;
  /** The key before SHARE_KEY, which checks links and never signs. */
  SHARE_KEY_PREVIOUS?: string;
}

/** What a share link holds: the result of one run of the form. */
export interface ShareResult {
  kind: "page" | "site";
  /** The audited address: the page, or the homepage a crawl started from. */
  url: string;
  /** The day of the audit in UTC, as YYYY-MM-DD. */
  day: string;
  seo: { score: number; counts: SeverityCounts };
  aeo: { score: number; counts: SeverityCounts };
  /** The pages a crawl audited; 1 for a page. */
  pages: number;
}

/** A signed result, and where it is shared from. */
export interface ShareLink {
  result: ShareResult;
  /** `<result>.<signature>`, the last part of the share page's path. */
  token: string;
}

/** The version of the link's contents; a link of another version is not opened. */
const VERSION = 1;

/** The signature's bytes: 128 bits of the HMAC-SHA256. */
const SIGNATURE_BYTES = 16;

/** The longest `<result>` the share routes read: a URL of 2,048 characters, in base64url. */
const MAX_RESULT_CHARS = 4096;

/** Signed with the purpose and the version, so the key's HMAC means nothing anywhere else. */
const CONTEXT = `agentic-seo-check share link v${VERSION}\n`;

const Score = z.number().int().min(0).max(100);
const Count = z.number().int().min(0);

/** A result as the link writes it, a JSON array: short, and in a fixed order. */
const Packed = z.tuple([
  z.literal(VERSION),
  z.enum(["p", "s"]),
  z.string().url().max(2048),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  Score,
  Count,
  Count,
  Count,
  Score,
  Count,
  Count,
  Count,
  z.number().int().min(1),
]);

const pack = (r: ShareResult): z.infer<typeof Packed> => [
  VERSION,
  r.kind === "page" ? "p" : "s",
  r.url,
  r.day,
  r.seo.score,
  r.seo.counts.error,
  r.seo.counts.warning,
  r.seo.counts.info,
  r.aeo.score,
  r.aeo.counts.error,
  r.aeo.counts.warning,
  r.aeo.counts.info,
  r.pages,
];

const unpack = ([
  ,
  kind,
  url,
  day,
  seo,
  seoError,
  seoWarning,
  seoInfo,
  aeo,
  aeoError,
  aeoWarning,
  aeoInfo,
  pages,
]: z.infer<typeof Packed>): ShareResult => ({
  kind: kind === "p" ? "page" : "site",
  url,
  day,
  seo: {
    score: seo,
    counts: { error: seoError, warning: seoWarning, info: seoInfo },
  },
  aeo: {
    score: aeo,
    counts: { error: aeoError, warning: aeoWarning, info: aeoInfo },
  },
  pages,
});

/**
 * The result of the form's run, from the audits its report shows. A site's address is the
 * homepage the crawl started from, as the AEO audit has it.
 */
export const shareResult = (
  seo: PageAudit | SiteAudit,
  aeo: AeoAudit
): ShareResult => ({
  kind: seo.kind,
  url: seo.kind === "site" ? aeo.url : seo.url,
  day: seo.auditedAt.slice(0, 10),
  seo: { score: seo.score, counts: seo.counts },
  aeo: { score: aeo.score, counts: aeo.counts },
  pages: seo.kind === "site" ? seo.pages.length : 1,
});

const encoder = new TextEncoder();

/** The HMAC key of a secret, as this isolate imported it: a secret stays the same until a deploy. */
const keys = new Map<string, Promise<CryptoKey>>();

const hmacKey = (secret: string): Promise<CryptoKey> => {
  let key = keys.get(secret);

  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    keys.set(secret, key);
  }

  return key;
};

const signature = async (secret: string, data: string): Promise<string> => {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${CONTEXT}${data}`)
  );

  return Buffer.from(mac.slice(0, SIGNATURE_BYTES)).toString("base64url");
};

/** Compares two strings in a time that does not depend on where they differ. */
const same = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < a.length; index += 1) {
    // oxlint-disable-next-line no-bitwise -- a constant-time comparison is made of bit operations
    diff |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
  }

  return diff === 0;
};

/**
 * The result's share link, or null when the site has no SHARE_KEY, or when openShare would refuse
 * the link: an address over 2,048 characters, which a redirect or the percent-encoding of a typed
 * path can make. A Share button whose link answers 404 is worse than none.
 */
export const signShare = async (
  env: ShareEnv,
  result: ShareResult
): Promise<ShareLink | null> => {
  const packed = Packed.safeParse(pack(result));

  if (!env.SHARE_KEY || !packed.success) {
    return null;
  }

  const data = Buffer.from(JSON.stringify(packed.data)).toString("base64url");

  if (data.length > MAX_RESULT_CHARS) {
    return null;
  }

  return {
    result,
    token: `${data}.${await signature(env.SHARE_KEY, data)}`,
  };
};

/** `<result>.<signature>`, as a share route's path ends. */
export const TOKEN = /^(?<data>[\w-]{1,4096})\.(?<signed>[\w-]{22})$/u;

/** The result `token` holds, when one of the keys signed it; null for any other token. */
export const openShare = async (
  env: ShareEnv,
  token: string
): Promise<ShareResult | null> => {
  const { data, signed } = TOKEN.exec(token)?.groups ?? {};

  if (!data || !signed || data.length > MAX_RESULT_CHARS) {
    return null;
  }

  const secrets = [env.SHARE_KEY, env.SHARE_KEY_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret)
  );

  // Every key is tried, so the time taken does not say which one signed it.
  const matches = await Promise.all(
    secrets.map(async (secret) => same(await signature(secret, data), signed))
  );

  if (!matches.includes(true)) {
    return null;
  }

  try {
    const packed = Packed.safeParse(
      JSON.parse(Buffer.from(data, "base64url").toString("utf-8"))
    );

    return packed.success ? unpack(packed.data) : null;
  } catch {
    return null;
  }
};

/** The share page's path, and its image's. */
export const sharePath = (token: string): string => `/share/${token}`;

export const shareImagePath = (token: string): string =>
  `${sharePath(token)}.png`;

/**
 * The Cache API's key for the share image at `url`: its path and the Worker's version, never its
 * query. The route ignores the query, so `….png?1` and `….png?2` are one image, drawn once; a key
 * with the query would let anyone with one link make the Worker draw it on every request.
 */
export const shareImageCacheKey = (url: string, version: string): string => {
  const { origin, pathname } = new URL(url);

  return `${origin}${pathname}?v=${encodeURIComponent(version)}`;
};

/** The day of the audit as people read it: 11 November 2026. */
export const dayText = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** The most characters of an address the post's text quotes. */
const MAX_ADDRESS_CHARS = 60;

/** The address without its scheme, cut to fit a post. */
export const shortAddress = (url: string): string => {
  const { hostname, pathname, search } = new URL(url);
  const path = pathname === "/" && !search ? "" : `${pathname}${search}`;
  const address = `${hostname}${path}`;

  return address.length > MAX_ADDRESS_CHARS
    ? `${address.slice(0, MAX_ADDRESS_CHARS - 1)}…`
    : address;
};

/** What the page or the site is, as the post and the share page's title name it. */
export const subject = (result: ShareResult): string =>
  result.kind === "site"
    ? `${new URL(result.url).hostname}, ${result.pages} ${result.pages === 1 ? "page" : "pages"}`
    : shortAddress(result.url);

/** The scores as a post says them: `SEO 82, AEO 93`. */
export const scoresText = (result: ShareResult): string =>
  `SEO ${result.seo.score}, AEO ${result.aeo.score}`;

/** The text of a post, before the link. */
export const shareText = (result: ShareResult): string =>
  `${subject(result)}: ${scoresText(result)} in ${PRODUCT_NAME}`;

/** Where each network's own page for a new post starts, with the post filled in. */
export const shareTargets = (link: ShareLink) => {
  const url = `${SITE_ORIGIN}${sharePath(link.token)}`;
  const text = shareText(link.result);

  return {
    url,
    text,
    x: `https://x.com/intent/post?${new URLSearchParams({ text, url, via: X_ACCOUNT })}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}`,
    bluesky: `https://bsky.app/intent/compose?${new URLSearchParams({ text: `${text} ${url}` })}`,
  };
};

/** What the result's card says, as its og:image:alt. */
export const shareImageAlt = (result: ShareResult): string =>
  `RIVI ${PRODUCT_NAME}: ${result.kind === "site" ? `site audit of ${result.pages} pages` : "page audit"} of ${new URL(result.url).hostname} on ${dayText(result.day)}. SEO ${result.seo.score} and AEO ${result.aeo.score} out of 100.`;
