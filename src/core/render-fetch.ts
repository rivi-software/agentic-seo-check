import { browserRequestHeaders } from "./browser-headers.js";
import {
  askGate,
  DEFAULT_USER_AGENT,
  forAuditOf,
  MAX_BODY_BYTES,
  readLimited,
  RequestRefusedError,
  showGate,
  signatureFor,
  withTimeout,
} from "./fetch.js";
import type { FetchOptions, FetchResult } from "./fetch.js";
import { trackRefusals } from "./refusals.js";
import type { Refusals } from "./refusals.js";

/** A request the browser wants to send, which the audit sends for it instead (issue #230). */
export interface BrowserRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType: string;
}

/** What the browser gets back: the answer to hand it, or the network error to give it. */
export type BrowserAnswer =
  | {
      kind: "fulfil";
      status: number;
      headers: { name: string; value: string }[];
      body: Uint8Array;
    }
  | { kind: "fail"; reason: "BlockedByClient" | "Failed" | "TimedOut" };

/** Sends one of the browser's requests, so the browser itself fetches nothing. */
export type FetchThrough = (request: BrowserRequest) => Promise<BrowserAnswer>;

/**
 * Headers the runtime's fetch sets itself, or that describe the browser's own connection: a value
 * the browser chose would be wrong, or refused, on the audit's request.
 */
const CONNECTION_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

/**
 * Headers of an answer that describe how it came over the wire, not the body handed on: fetch has
 * already taken the body out of its encoding and its chunks.
 */
const WIRE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

const fail = (
  reason: "BlockedByClient" | "Failed" | "TimedOut"
): BrowserAnswer => ({ kind: "fail", reason });

/** The browser's headers that the audit's request carries on, the HTTP/2 pseudo-headers left out. */
const browserHeaders = (
  headers: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !name.startsWith(":") && !CONNECTION_HEADERS.has(name.toLowerCase())
    )
  );

/** Every header of an answer, each `set-cookie` on its own, but the wire's. */
const answerHeaders = (headers: Headers): { name: string; value: string }[] => {
  const out: { name: string; value: string }[] = [];

  for (const [name, value] of headers) {
    if (name !== "set-cookie" && !WIRE_HEADERS.has(name)) {
      out.push({ name, value });
    }
  }

  for (const value of headers.getSetCookie()) {
    out.push({ name: "set-cookie", value });
  }

  return out;
};

/**
 * Shows the gate a page the browser loads as a document, as `fetchPage` does, for the refusals only
 * a page shows (a challenge page). A script or an image is no page.
 */
const showGateBody = (
  options: FetchOptions,
  request: BrowserRequest,
  res: Response,
  bytes: Uint8Array
): void => {
  if (!options.gate?.afterBody || request.resourceType !== "document") {
    return;
  }

  const headers = Object.fromEntries(res.headers);

  const page: FetchResult = {
    requestedUrl: request.url,
    finalUrl: request.url,
    status: res.status,
    headers,
    body: new TextDecoder().decode(bytes),
    redirectChain: [],
    timeMs: 0,
    contentType: headers["content-type"] ?? null,
  };

  const refusal = options.gate.afterBody(new URL(request.url), page);

  if (refusal) {
    throw new RequestRefusedError(refusal, request.url);
  }
};

/** Sends the request once, with no redirect followed, and reads its answer up to the cap. */
const send = async (
  options: FetchOptions,
  headersOrigin: string,
  request: BrowserRequest,
  signal: AbortSignal
): Promise<BrowserAnswer> => {
  const { url } = request;
  const maxBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  // A request that cannot be signed is not sent: it fails as any other request does.
  const signature = options.sign ? await signatureFor(options.sign, url) : {};

  const own = browserRequestHeaders(
    browserHeaders(request.headers),
    url,
    options.headers ?? {},
    headersOrigin
  );

  const headers = new Headers({
    "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
  });

  for (const { name, value } of own) {
    headers.set(name, value);
  }

  for (const [name, value] of Object.entries(signature)) {
    headers.set(name, value);
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const res = await fetch(url, {
    method,
    // A redirect goes back to the browser as the redirect, so the gate sees the next hop too.
    redirect: "manual",
    signal,
    headers,
    body: hasBody ? request.postData : undefined,
  });

  await showGate(options.gate, url, res);

  // One byte past the cap tells a body over it from one that fills it.
  const read = await readLimited(res, maxBytes + 1);

  if (read.bytes.byteLength > maxBytes) {
    return fail("Failed");
  }

  showGateBody(options, request, res, read.bytes);

  return {
    kind: "fulfil",
    status: res.status,
    headers: answerHeaders(res.headers),
    body: read.bytes,
  };
};

/**
 * The browser's network for the audit of `pageUrl`: each request it makes is sent here, one hop at
 * a time, as the audit's own requests are. The gate is asked first (a refusal is a request the
 * browser is told was blocked, and is never sent), the request is signed and goes with the audit's
 * User-Agent, the user's headers go to the audited origin only, the body stops at `maxBodyBytes`,
 * and the request times out at `timeoutMs`.
 */
export const fetchThroughOptions = (
  options: FetchOptions,
  pageUrl: string,
  refusals: Refusals = trackRefusals()
): FetchThrough => {
  // The gate also refuses a host already refused, so a site that answered 429 or a challenge to
  // one request is sent nothing more: no retry.
  const audit = refusals.guard(forAuditOf(options, pageUrl));

  const headersOrigin =
    audit.headersOrigin ??
    (URL.canParse(pageUrl) ? new URL(pageUrl).origin : pageUrl);

  const timeoutMs = audit.timeoutMs ?? 15_000;

  return async (request) => {
    // A data:, blob: or file: URL never reaches this far in a browser; anything else is no request
    // the audit sends.
    if (
      !URL.canParse(request.url) ||
      !/^https?:$/u.test(new URL(request.url).protocol)
    ) {
      return fail("Failed");
    }

    try {
      // A refusal is recorded, as for the audit's own requests, and the browser told it was blocked.
      const answer = await refusals.run(request.url, async () => {
        await askGate(audit.gate, request.url);

        return withTimeout(timeoutMs, (signal) =>
          send(audit, headersOrigin, request, signal)
        );
      });

      return answer ?? fail("BlockedByClient");
    } catch (error) {
      return fail(
        error instanceof Error && error.name === "AbortError"
          ? "TimedOut"
          : "Failed"
      );
    }
  };
};

/** The part of Playwright's `Route` that answers a request. */
export interface RouteLike {
  fulfill: (options: {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }) => Promise<void>;
  abort: (errorCode?: string) => Promise<void>;
}

/** The part of Playwright's `Request` a `BrowserRequest` is read from. */
export interface RequestLike {
  url: () => string;
  method: () => string;
  allHeaders: () => Promise<Record<string, string>>;
  postData: () => string | null;
  resourceType: () => string;
}

/** Playwright's error codes for `route.abort`, which the browser sees as its own network error. */
const ABORT_CODES = {
  BlockedByClient: "blockedbyclient",
  Failed: "failed",
  TimedOut: "timedout",
} as const;

/** The request as `FetchThrough` takes it. */
export const browserRequestOf = async (
  request: RequestLike
): Promise<BrowserRequest> => {
  const browser: BrowserRequest = {
    url: request.url(),
    method: request.method(),
    headers: await request.allHeaders(),
    resourceType: request.resourceType(),
  };

  const postData = request.postData();

  if (postData !== null) {
    browser.postData = postData;
  }

  return browser;
};

/**
 * Answers a Playwright route with `answer`. Playwright takes one value per header name, and splits
 * a `set-cookie` value on new lines, so each cookie stays its own.
 */
export const answerRoute = (
  route: RouteLike,
  answer: BrowserAnswer
): Promise<void> => {
  if (answer.kind === "fail") {
    return route.abort(ABORT_CODES[answer.reason]);
  }

  const headers: Record<string, string> = {};

  for (const { name, value } of answer.headers) {
    const key = name.toLowerCase();
    const earlier = headers[key];
    const separator = key === "set-cookie" ? "\n" : ", ";
    headers[key] =
      earlier === undefined ? value : `${earlier}${separator}${value}`;
  }

  return route.fulfill({
    status: answer.status,
    headers,
    body: Buffer.from(
      answer.body.buffer,
      answer.body.byteOffset,
      answer.body.byteLength
    ),
  });
};
