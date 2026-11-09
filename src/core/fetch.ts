import { VERSION } from "../version.js";
import type { RedirectHop, ResponseInfo } from "./types.js";

export const DEFAULT_USER_AGENT = `Mozilla/5.0 (compatible; agentic-seo-check/${VERSION}; +https://github.com/rivi-software/agentic-seo-check)`;

const KEPT_HEADERS = [
  "content-type",
  "content-encoding",
  "x-robots-tag",
  "link",
  "content-language",
  "cache-control",
  "last-modified",
  "location",
  "content-length",
  "vary",
  "content-security-policy",
];

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** Stop reading the body after this many bytes. */
  maxBodyBytes?: number;
  /**
   * Return the body as bytes (`bytes`) instead of text (`body` is then ""), for files that are not
   * text, such as a gzip sitemap.
   */
  keepBytes?: boolean;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  redirectChain: RedirectHop[];
  timeMs: number;
  contentType: string | null;
  error?: string;
  /** The body stopped at `maxBodyBytes`; the rest was not read. */
  truncated?: boolean;
  /** The body's bytes, with `keepBytes`. */
  bytes?: Buffer;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const pickHeaders = (headers: Headers) => {
  const out: Record<string, string> = {};

  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);

    if (value !== null) {
      out[name] = value;
    }
  }

  return out;
};

const result = (
  requestedUrl: string,
  finalUrl: string,
  status: number | null,
  headers: Record<string, string>,
  body: string | null,
  chain: RedirectHop[],
  started: number,
  error?: string
): FetchResult => {
  const r: FetchResult = {
    requestedUrl,
    finalUrl,
    status,
    headers,
    body,
    redirectChain: chain,
    timeMs: Math.round(performance.now() - started),
    contentType: headers["content-type"] ?? null,
  };

  if (error) {
    r.error = error;
  }

  return r;
};

interface BodyRead {
  bytes: Buffer;
  truncated: boolean;
}

const readLimited = async (
  res: Response,
  maxBytes: number
): Promise<BodyRead> => {
  if (!res.body) {
    return { bytes: Buffer.alloc(0), truncated: false };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a stream hands over its chunks one after another
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      total += value.byteLength;

      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  }

  if (truncated) {
    await reader.cancel().catch(() => null);
  }

  return { bytes: Buffer.concat(chunks), truncated };
};

/** The body as text, in the charset the Content-Type header names (UTF-8 otherwise). */
const decodeBody = (bytes: Buffer, contentType: string | null): string => {
  const charset = /charset=(?<charset>[\w-]+)/iu.exec(contentType ?? "")?.groups
    ?.charset;

  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

/** What stays the same for every request while one fetch follows its redirects. */
interface RedirectWalk {
  url: string;
  options: FetchOptions;
  readBody: boolean;
  timeoutMs: number;
  started: number;
  chain: RedirectHop[];
}

/** One request of a redirect chain: the final result, or the URL the redirect points to next. */
type HopOutcome = { done: FetchResult } | { next: string };

const fetchHop = async (
  walk: RedirectWalk,
  current: string
): Promise<HopOutcome> => {
  const { url, options, readBody, timeoutMs, started, chain } = walk;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en,*;q=0.5",
        ...options.headers,
      },
    });

    const headers = pickHeaders(res.headers);

    if (REDIRECT_STATUSES.has(res.status) && headers["location"]) {
      chain.push({ url: current, status: res.status });
      let nextUrl: string;

      try {
        nextUrl = new URL(headers["location"], current).href;
      } catch {
        return {
          done: result(
            url,
            current,
            res.status,
            headers,
            null,
            chain,
            started,
            `Invalid Location header: ${headers["location"]}`
          ),
        };
      }

      await res.body?.cancel().catch(() => null);

      if (chain.some((h) => h.url === nextUrl) || nextUrl === current) {
        return {
          done: result(
            url,
            nextUrl,
            res.status,
            headers,
            null,
            chain,
            started,
            "Redirect loop"
          ),
        };
      }

      return { next: nextUrl };
    }

    if (!readBody) {
      await res.body?.cancel().catch(() => null);

      return {
        done: result(url, current, res.status, headers, null, chain, started),
      };
    }

    const read = await readLimited(res, options.maxBodyBytes ?? 5_000_000);

    const done = result(
      url,
      current,
      res.status,
      headers,
      // The caller reads `bytes`; decoding them too would hold the body a second time.
      options.keepBytes
        ? ""
        : decodeBody(read.bytes, res.headers.get("content-type")),
      chain,
      started
    );

    if (read.truncated) {
      done.truncated = true;
    }

    if (options.keepBytes) {
      done.bytes = read.bytes;
    }

    return { done };
  } catch (error) {
    let message = String(error);

    if (error instanceof Error) {
      message =
        error.name === "AbortError"
          ? `Timed out after ${timeoutMs} ms`
          : error.message;
    }

    return {
      done: result(url, current, null, {}, null, chain, started, message),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** GET a URL, following redirects manually so the chain is recorded. */
export const fetchPage = async (
  url: string,
  options: FetchOptions = {},
  readBody = true
): Promise<FetchResult> => {
  const maxRedirects = options.maxRedirects ?? 10;

  const walk: RedirectWalk = {
    url,
    options,
    readBody,
    timeoutMs: options.timeoutMs ?? 15_000,
    started: performance.now(),
    chain: [],
  };

  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each request goes where the one before it redirected
    const outcome = await fetchHop(walk, current);

    if ("done" in outcome) {
      return outcome.done;
    }

    current = outcome.next;
  }

  return result(
    url,
    current,
    null,
    {},
    null,
    walk.chain,
    walk.started,
    `More than ${maxRedirects} redirects`
  );
};

/** Status/redirect check without downloading the body. */
export const probeUrl = (
  url: string,
  options: FetchOptions = {}
): Promise<FetchResult> => fetchPage(url, options, false);

export const toResponseInfo = (r: FetchResult): ResponseInfo => {
  const info: ResponseInfo = {
    status: r.status,
    finalUrl: r.finalUrl,
    redirectChain: r.redirectChain,
    timeMs: r.timeMs,
    contentType: r.contentType,
    headers: r.headers,
  };

  if (r.error) {
    info.error = r.error;
  }

  return info;
};

export const isHtmlResponse = (r: FetchResult): boolean => {
  const ct = r.contentType?.toLowerCase() ?? "";

  if (ct) {
    return ct.includes("text/html") || ct.includes("application/xhtml");
  }

  if (!r.body) {
    return false;
  }

  return /<html|<!doctype/iu.test(r.body.slice(0, 2000));
};
