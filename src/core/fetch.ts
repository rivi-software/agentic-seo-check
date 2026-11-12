import { VERSION } from "../version.js";
import { caughtError, ExpectedError } from "./errors.js";
import type { RedirectHop, ResponseInfo } from "./types.js";

/**
 * The product token of the CLI, the local server and the library, which robots.txt groups match.
 * The hosted server's is `agentic-seo-check` (issue #41): a site can tell the requests a person
 * sends from their own machine from the hosted server's, and Cloudflare's verified bot is the
 * hosted server alone.
 */
export const LOCAL_PRODUCT_TOKEN = "agentic-seo-check-local";

export const DEFAULT_USER_AGENT = `Mozilla/5.0 (compatible; ${LOCAL_PRODUCT_TOKEN}/${VERSION}; +https://github.com/rivi-software/agentic-seo-check)`;

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

/**
 * What kept a request back, from a fixed list, for the hosted server's analytics (issue #84):
 * the hosted address rules, robots.txt (disallowed, unreadable, or a Crawl-delay past the crawl's
 * budget), the site's answer (403, 429, a challenge page), or the Worker's limits (requests per
 * site, and the sites a caller may audit in a day).
 */
export type RefusalReason =
  | "address"
  | "robots_txt"
  | "robots_unreadable"
  | "crawl_delay"
  | "http_403"
  | "http_429"
  | "challenge"
  | "site_requests"
  | "caller_sites"
  | "platform_sites";

/** Why a request was not sent, or why its answer is not the page: see `RequestGate`. */
export interface Refusal {
  /** What happened and what the person who asked for the audit can do, in a sentence or two. */
  message: string;
  /**
   * What it covers: this URL alone, every later request of the audit to the URL's host, or every
   * later request.
   */
  scope: "url" | "host" | "all";
  /** Why, from a fixed list: the message says it to a person, this to the analytics. */
  reason?: RefusalReason;
}

/**
 * A request the gate refused, thrown out of `fetchPage` so that no caller takes it for an answer:
 * a link that was not requested is not checked, never broken.
 */
export class RequestRefusedError extends ExpectedError {
  readonly scope: Refusal["scope"];
  readonly reason: RefusalReason | undefined;
  /** The request that was refused: the URL asked for, or a redirect it led to. */
  readonly url: string;

  constructor(refusal: Refusal, url: string) {
    super(refusal.message);
    this.name = "RequestRefusedError";
    this.scope = refusal.scope;
    this.reason = refusal.reason;
    this.url = url;
  }

  get host(): string {
    return new URL(this.url).hostname;
  }
}

/**
 * Decides what an audit may request: the hosted server's address rules and request limits, and
 * the answers that are a site turning it away. The CLI and the local server have none.
 */
export interface RequestGate {
  /** Asked before every request, the first and each redirect: a refusal stops the fetch. */
  beforeRequest: (
    url: URL
  ) => Promise<Refusal | undefined> | Refusal | undefined;
  /**
   * Shown each answer before its body is read: a refusal when the answer is the site refusing the
   * request (a challenge, a rate limit) rather than the page.
   */
  afterResponse?: (url: URL, response: Response) => Refusal | undefined;
  /** Shown each body once read, for refusals that only the page itself shows (a challenge page). */
  afterBody?: (url: URL, result: FetchResult) => Refusal | undefined;
  /**
   * The robots.txt of `origin` as a gate that obeys robots.txt itself reads it (the hosted
   * server's), once per audit: `loadRobotsTxt` takes it, so the audit's own read is not a second
   * request. It throws what the request threw, a refusal included.
   */
  robotsTxt?: (origin: string) => Promise<FetchResult>;
  /**
   * Told once when a refusal ended a crawl's requests to the site before it was done. The crawl
   * still answers, with the pages it read and `site.crawl-stopped` (`aeo.crawl-stopped`), so no
   * caller sees the refusal thrown: the hosted server notes its reason here (issue #94).
   */
  crawlStopped?: (refusal: RequestRefusedError) => void;
}

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  /**
   * Extra request headers: a staging password, a cookie. They go to the audited origin only (see
   * `headersOrigin`), never to another site a redirect, a link or a sitemap leads to.
   */
  headers?: Record<string, string>;
  /**
   * The origin `headers` are for: the audited one, which the audit functions set from the URL they
   * are given. Unset, it is the origin of the URL a fetch starts at, so a redirect to another
   * origin never carries the headers on.
   */
  headersOrigin?: string;
  maxRedirects?: number;
  /** Stop reading the body after this many bytes. */
  maxBodyBytes?: number;
  /**
   * Return the body as bytes (`bytes`) instead of text (`body` is then ""), for files that are not
   * text, such as a gzip sitemap.
   */
  keepBytes?: boolean;
  /** What the audit may request; `fetchPage` throws RequestRefusedError for what it may not. */
  gate?: RequestGate;
  /**
   * The headers that sign a request (the hosted server's Web Bot Auth signature), asked for each
   * request the gate lets through: the first and every redirect, since a signature covers the
   * host it goes to.
   */
  sign?: (url: URL) => Promise<Record<string, string>> | Record<string, string>;
}

/** The most of a body an audit reads unless `maxBodyBytes` says otherwise. */
export const MAX_BODY_BYTES = 5_000_000;

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

/**
 * Whether a response's Content-Encoding is the one the site sent. Not in a Cloudflare Worker (the
 * hosted server): Cloudflare's network negotiates compression with the site on its own hop and
 * hands the Worker the page without the header, so every page would look uncompressed. A Worker's
 * navigator names the runtime.
 */
export const seesContentEncoding = (): boolean =>
  // Node has a navigator from version 21 only, and other runtimes may have none.
  typeof navigator === "undefined" ||
  navigator.userAgent !== "Cloudflare-Workers";

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
      // A chunk can be large: keep only what fits, so the cap holds to the byte.
      const room = maxBytes - total;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      total += Math.min(value.byteLength, room);

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

/**
 * Cloudflare's answer for a name that resolves to no site: HTTP 409 with the text "error code:
 * 1001", its DNS resolution error. A Worker gets it where Node's fetch fails to resolve the name,
 * for any name under a zone on Cloudflare, such as the www host of a site that has none.
 * https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-409/
 */
const CLOUDFLARE_DNS_ERROR = /^error code: 1001\s*$/u;

/** The longest body read to tell Cloudflare's DNS resolution error from a 409 of the site's. */
const DNS_ERROR_PEEK_BYTES = 64;

/** Whether `res` is Cloudflare's DNS resolution error, read from a copy so the body stays unread. */
const isCloudflareDnsError = async (res: Response): Promise<boolean> => {
  const type = res.headers.get("content-type") ?? "";

  if (res.status !== 409 || !type.toLowerCase().startsWith("text/plain")) {
    return false;
  }

  const { bytes } = await readLimited(res.clone(), DNS_ERROR_PEEK_BYTES);

  return CLOUDFLARE_DNS_ERROR.test(new TextDecoder().decode(bytes));
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

/** The port a URL names, or its scheme's own. */
const portOf = (url: URL): string =>
  url.port || (url.protocol === "https:" ? "443" : "80");

/**
 * Whether a request to `url` may carry the user's `headers`, which are for `origin`: the same
 * origin, or the same host over https where `origin` is http, since a site that upgrades its
 * visitors to https is still the site the user named. Another host, another port and a step down
 * from https to http are someone else's server, or a wire anyone can read.
 */
export const headersGoTo = (url: string, origin: string): boolean => {
  if (!URL.canParse(url) || !URL.canParse(origin)) {
    return false;
  }

  const target = new URL(url);
  const audited = new URL(origin);

  if (target.origin === audited.origin) {
    // A file: or data: URL has the origin "null", which is no origin to send a secret to.
    return target.origin !== "null";
  }

  return (
    audited.protocol === "http:" &&
    target.protocol === "https:" &&
    target.hostname === audited.hostname &&
    portOf(audited) === "80" &&
    portOf(target) === "443"
  );
};

/**
 * `options` with its `headers` held to the origin of `url`, the URL an audit was asked for. Every
 * request of that audit then sends them to that origin only: its redirects, its link checks, its
 * sitemaps and the origin a redirect ended at.
 */
export const forAuditOf = <T extends FetchOptions>(
  options: T,
  url: string
): T =>
  options.headers && !options.headersOrigin && URL.canParse(url)
    ? { ...options, headersOrigin: new URL(url).origin }
    : options;

/**
 * The user's headers for a request to `current`, of a fetch that started at `start`: none when a
 * redirect or a link led to another origin than the audited one, which must not be handed them.
 */
const ownHeaders = (
  options: FetchOptions,
  current: string,
  start: string
): Record<string, string> =>
  options.headers && headersGoTo(current, options.headersOrigin ?? start)
    ? options.headers
    : {};

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

/**
 * The headers that sign a request to `current`. A signature that fails is the tool's own failure,
 * not the site's (issue #93): error tracking hears it, and the request then fails as any other.
 */
const signatureFor = async (
  sign: NonNullable<FetchOptions["sign"]>,
  current: string
): Promise<Record<string, string>> => {
  try {
    return await sign(new URL(current));
  } catch (error) {
    caughtError(error, { task: "request_signature" });
    throw error;
  }
};

/** Asks the gate before a request, and throws its refusal. */
const askGate = async (
  gate: RequestGate | undefined,
  current: string
): Promise<void> => {
  // A URL that does not parse fails in fetch(), with an answer that says so.
  if (!gate || !URL.canParse(current)) {
    return;
  }

  const refusal = await gate.beforeRequest(new URL(current));

  if (refusal) {
    throw new RequestRefusedError(refusal, current);
  }
};

/** Shows the gate an answer, and throws its refusal once the body is let go. */
const showGate = async (
  gate: RequestGate | undefined,
  current: string,
  res: Response
): Promise<void> => {
  const refusal = gate?.afterResponse?.(new URL(current), res);

  if (refusal) {
    await res.body?.cancel().catch(() => null);

    throw new RequestRefusedError(refusal, current);
  }
};

/** The answer with its body read, up to `maxBodyBytes`. */
const readAnswer = async (
  walk: RedirectWalk,
  current: string,
  res: Response,
  headers: Record<string, string>
): Promise<FetchResult> => {
  const { url, options, started, chain } = walk;
  const read = await readLimited(res, options.maxBodyBytes ?? MAX_BODY_BYTES);

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

  const refusal = options.gate?.afterBody?.(new URL(current), done);

  if (refusal) {
    throw new RequestRefusedError(refusal, current);
  }

  return done;
};

const fetchHop = async (
  walk: RedirectWalk,
  current: string
): Promise<HopOutcome> => {
  const asked = performance.now();
  await askGate(walk.options.gate, current);
  // The time the gate held the request (robots.txt first, a Crawl-delay) is not the site's: it
  // stays out of the response time, which response.slow judges.
  walk.started += performance.now() - asked;
  const { url, options, readBody, timeoutMs, started, chain } = walk;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // A request that cannot be signed is not sent: it fails as any other request does.
    const signature =
      options.sign && URL.canParse(current)
        ? await signatureFor(options.sign, current)
        : {};

    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en,*;q=0.5",
        ...ownHeaders(options, current, url),
        ...signature,
      },
    });

    await showGate(options.gate, current, res);

    // A name that does not resolve fails here as it does in Node, rather than answering 409.
    if (await isCloudflareDnsError(res)) {
      await res.body?.cancel().catch(() => null);

      return {
        done: result(
          url,
          current,
          null,
          {},
          null,
          chain,
          started,
          `DNS resolution error: ${new URL(current).hostname} does not resolve (Cloudflare error 1001)`
        ),
      };
    }

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

    return { done: await readAnswer(walk, current, res, headers) };
  } catch (error) {
    // A refusal is no failure of the request: it goes to the caller as it is.
    if (error instanceof RequestRefusedError) {
      throw error;
    }

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

  if (r.truncated) {
    info.truncated = true;
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
