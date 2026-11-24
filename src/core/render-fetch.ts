import { browserRequestHeaders } from "./browser-headers.js";
import {
  askGate,
  DEFAULT_USER_AGENT,
  forAuditOf,
  MAX_BODY_BYTES,
  RequestRefusedError,
  showGate,
  signatureFor,
  withTimeout,
} from "./fetch.js";
import type { FetchOptions, FetchResult, RequestGate } from "./fetch.js";
import { trackRefusals } from "./refusals.js";
import type { Refusals } from "./refusals.js";

/** A request the browser wants to send, which the audit sends for it instead (issue #230). */
export interface BrowserRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType: string;
  /**
   * The page's own navigation, of its main frame, which the audit's `gate` decides on. Any other
   * request is a subresource of the page, which `subresourceGate` decides on.
   */
  navigation?: boolean;
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
export interface FetchThrough {
  (request: BrowserRequest): Promise<BrowserAnswer>;
  /**
   * Told once the browser has `answer`, so its body no longer counts against the bytes a render
   * holds at once. An answer told twice, or not this function's, changes nothing.
   */
  delivered: (answer: BrowserAnswer) => void;
}

/** What one render may send and hold: see `fetchThroughOptions`. */
export interface RenderRequestLimits {
  /** Requests a render sends, each redirect's hop counted: past it, a request is blocked. */
  maxRequests?: number;
  /**
   * Bytes of answers read and not yet handed to the browser: past it, a request is blocked, so a
   * page's scripts cannot make the audit hold many bodies of `maxBodyBytes` at once.
   */
  maxBytesInFlight?: number;
}

/** The limits of a render without others given (the hosted server gives HOSTED_LIMITS'). */
export const RENDER_REQUEST_LIMITS = {
  maxRequests: 200,
  maxBytesInFlight: 16_000_000,
} as const satisfies Required<RenderRequestLimits>;

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
 * The browser's headers that belong to the origin it asked: a redirect to another origin does not
 * carry them on, as a browser's own redirect would not.
 */
const ORIGIN_HEADERS = new Set(["authorization", "cookie"]);

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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The methods the browser's requests may use. The tools are read-only, and a verified bot does not
 * send a page's form posts or beacons under its signature: anything else is blocked.
 */
const READ_METHODS = new Set(["GET", "HEAD"]);

const fail = (
  reason: "BlockedByClient" | "Failed" | "TimedOut"
): BrowserAnswer => ({ kind: "fail", reason });

/**
 * The browser's headers that the audit's request to `hop` carries on, the HTTP/2 pseudo-headers
 * left out, and its cookie and authorization too once a redirect left the origin it asked.
 */
const browserHeaders = (
  request: BrowserRequest,
  hop: string
): Record<string, string> => {
  const sameOrigin = new URL(hop).origin === new URL(request.url).origin;

  return Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => {
      const key = name.toLowerCase();

      return (
        !name.startsWith(":") &&
        !CONNECTION_HEADERS.has(key) &&
        (sameOrigin || !ORIGIN_HEADERS.has(key))
      );
    })
  );
};

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
  gate: RequestGate | undefined,
  request: BrowserRequest,
  hop: string,
  res: Response,
  bytes: Uint8Array
): void => {
  if (!gate?.afterBody || request.resourceType.toLowerCase() !== "document") {
    return;
  }

  const headers = Object.fromEntries(res.headers);

  const page: FetchResult = {
    requestedUrl: request.url,
    finalUrl: hop,
    status: res.status,
    headers,
    body: new TextDecoder().decode(bytes),
    redirectChain: [],
    timeMs: 0,
    contentType: headers["content-type"] ?? null,
  };

  const refusal = gate.afterBody(new URL(hop), page);

  if (refusal) {
    throw new RequestRefusedError(refusal, hop);
  }
};

/** Where a redirect's answer leads, or null when it is no redirect to follow. */
const redirectTarget = (res: Response, hop: string): string | null => {
  const location = res.headers.get("location");

  if (!REDIRECT_STATUSES.has(res.status) || location === null) {
    return null;
  }

  return URL.canParse(location, hop) ? new URL(location, hop).href : null;
};

/** One request of a walk: where it goes, and the walk it belongs to. */
interface Hop {
  options: FetchOptions;
  headersOrigin: string;
  request: BrowserRequest;
  url: string;
}

/** Sends one hop, with no redirect followed, and shows the gate its answer. */
const sendHop = async (
  { options, headersOrigin, request, url }: Hop,
  signal: AbortSignal
): Promise<Response> => {
  // A request that cannot be signed is not sent: it fails as any other request does.
  const signature = options.sign ? await signatureFor(options.sign, url) : {};

  const own = browserRequestHeaders(
    browserHeaders(request, url),
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

  const res = await fetch(url, {
    method: request.method.toUpperCase(),
    // Each hop is asked for here, so the gate and the signature see it: Playwright hands a
    // redirect's next request to the browser's own network, past the route.
    redirect: "manual",
    signal,
    headers,
  });

  await showGate(options.gate, url, res);

  return res;
};

/** A render's count of requests and of the bytes it holds, shared by all its requests. */
interface RenderBudget {
  sent: number;
  bytes: number;
  maxRequests: number;
  maxBytesInFlight: number;
  /** The origins a gate that reads robots.txt has been asked about, each one request more. */
  robotsRead: Set<string>;
}

/** A read stopped because the render holds as much as it may: the request is blocked. */
class OverBudgetError extends Error {
  override name = "OverBudgetError";
}

/** What `readBudgeted` read: the body, or null when it is over `maxBytes`. */
type BudgetedRead = Uint8Array | null;

/** The body's length as Content-Length gives it, when that is the length fetch hands over. */
const declaredLength = (res: Response): number | null => {
  const encoding = res.headers.get("content-encoding");
  const length = res.headers.get("content-length");

  // fetch decodes a compressed body, so its Content-Length is not the length read.
  if ((encoding !== null && encoding !== "identity") || length === null) {
    return null;
  }

  return /^\d{1,15}$/u.test(length.trim()) ? Number(length.trim()) : null;
};

/**
 * Reads the body up to `maxBytes` (null past it), counting its bytes against the render's budget
 * as they arrive, so bodies read side by side never hold more than `maxBytesInFlight` together:
 * the chunk that would pass it stops the read with `OverBudgetError`. A body whose Content-Length
 * is known is reserved whole before it is read, and read into one buffer of that length; any other
 * is copied once from its chunks. What the read had counted is let go when it fails, and whatever
 * it counted past the body it returns. The body returned stays counted until `delivered`.
 */
const readBudgeted = async (
  res: Response,
  maxBytes: number,
  budget: RenderBudget
): Promise<BudgetedRead> => {
  let reserved = 0;

  const reserve = (total: number): void => {
    if (total <= reserved) {
      return;
    }

    if (budget.bytes + total - reserved > budget.maxBytesInFlight) {
      throw new OverBudgetError("The render holds as much as it may.");
    }

    budget.bytes += total - reserved;
    reserved = total;
  };

  const settle = (total: number): void => {
    budget.bytes -= reserved - total;
    reserved = total;
  };

  const declared = declaredLength(res);

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => null);

    return null;
  }

  if (!res.body) {
    return new Uint8Array(0);
  }

  const reader = res.body.getReader();
  let whole: Uint8Array | null = null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;

  try {
    if (declared !== null) {
      reserve(declared);
      whole = new Uint8Array(declared);
    }

    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream hands over its chunks one after another
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const next = total + value.byteLength;

      if (next > maxBytes) {
        over = true;
        break;
      }

      reserve(next);

      if (whole && next <= whole.byteLength) {
        whole.set(value, total);
      } else {
        // More than Content-Length said: what came so far joins the chunks.
        if (whole) {
          chunks.push(whole.subarray(0, total));
          whole = null;
        }

        chunks.push(value);
      }

      total = next;
    }
  } catch (error) {
    await reader.cancel().catch(() => null);
    settle(0);
    throw error;
  }

  if (over) {
    await reader.cancel().catch(() => null);
    settle(0);

    return null;
  }

  settle(total);

  if (whole) {
    return total === whole.byteLength ? whole : whole.slice(0, total);
  }

  const body = new Uint8Array(total);
  let at = 0;

  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }

  return body;
};

/**
 * Sends a hop and reads its answer up to the cap, within `timeoutMs`, or answers where its redirect
 * leads. The answer's bytes are counted as held while they are read (`readBudgeted`), so answers
 * read side by side cannot pass the cap together; `delivered` lets them go.
 */
const answerHop = (
  hop: Hop,
  budget: RenderBudget,
  timeoutMs: number
): Promise<BrowserAnswer | { next: string }> =>
  withTimeout(timeoutMs, async (signal) => {
    const { options, request, url } = hop;
    const res = await sendHop(hop, signal);
    const next = redirectTarget(res, url);

    if (next !== null) {
      await res.body?.cancel().catch(() => null);

      return { next };
    }

    let body: BudgetedRead;

    try {
      body = await readBudgeted(
        res,
        options.maxBodyBytes ?? MAX_BODY_BYTES,
        budget
      );
    } catch (error) {
      if (error instanceof OverBudgetError) {
        return fail("BlockedByClient");
      }

      throw error;
    }

    if (body === null) {
      return fail("Failed");
    }

    try {
      showGateBody(options.gate, request, url, res, body);
    } catch (error) {
      budget.bytes -= body.byteLength;
      throw error;
    }

    return {
      kind: "fulfil",
      status: res.status,
      headers: answerHeaders(res.headers),
      body,
    };
  });

/**
 * Walks the request's redirects as `fetchPage` does, asking the gate before each hop and signing
 * it, and answers with the last: the browser sees the redirect's target under the URL it asked
 * for. A redirect it may not follow (past `maxRedirects`, a loop) fails.
 */
const walk = async (
  options: FetchOptions,
  headersOrigin: string,
  request: BrowserRequest,
  budget: RenderBudget
): Promise<BrowserAnswer> => {
  const maxRedirects = options.maxRedirects ?? 10;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const seen = new Set<string>();
  let { url } = request;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { origin } = new URL(url);
    // A gate that reads robots.txt (the hosted server's) requests it for an origin it has not read
    // yet, out of this file's sight: the first hop to each origin counts as two requests. The
    // page's own origin counts so too, though the audit may have read its robots.txt already.
    const robots = options.gate?.robotsTxt && !budget.robotsRead.has(origin);
    const cost = robots ? 2 : 1;

    if (
      budget.sent + cost > budget.maxRequests ||
      budget.bytes >= budget.maxBytesInFlight
    ) {
      return fail("BlockedByClient");
    }

    // robots.txt is requested while the gate is asked, whatever it answers; the hop only once the
    // gate lets it go.
    if (robots) {
      budget.robotsRead.add(origin);
      budget.sent += 1;
    }

    seen.add(url);
    // oxlint-disable-next-line eslint/no-await-in-loop -- each hop goes where the one before it led
    await askGate(options.gate, url);
    budget.sent += 1;

    // oxlint-disable-next-line eslint/no-await-in-loop -- as above
    const answer = await answerHop(
      { options, headersOrigin, request, url },
      budget,
      timeoutMs
    );

    if (!("next" in answer)) {
      return answer;
    }

    if (
      seen.has(answer.next) ||
      !/^https?:$/u.test(new URL(answer.next).protocol)
    ) {
      return fail("Failed");
    }

    url = answer.next;
  }

  return fail("Failed");
};

/** What `fetchThroughOptions` takes besides the audit's options. */
export interface FetchThroughSettings extends RenderRequestLimits {
  /** The audit's refusals, so a refusal of the browser's requests is the audit's too. */
  refusals?: Refusals;
}

/**
 * The browser's network for the audit of `pageUrl`: each request it makes is sent here, as the
 * audit's own requests are. The page's own navigation goes through the audit's `gate`, anything
 * else through `subresourceGate` (or `gate` without one). The gate is asked before each hop (a
 * refusal is a request the browser is told was blocked, and is never sent), each hop is signed and
 * goes with the audit's User-Agent, the user's headers go to the audited origin only, the body
 * stops at `maxBodyBytes`, and each hop times out at `timeoutMs`. Only GET and HEAD are sent, and a
 * render sends at most `maxRequests` and holds at most `maxBytesInFlight`: anything else is blocked.
 */
export const fetchThroughOptions = (
  options: FetchOptions,
  pageUrl: string,
  settings: FetchThroughSettings = {}
): FetchThrough & { held: () => number } => {
  const refusals = settings.refusals ?? trackRefusals();
  // The gate also refuses a host already refused, so a site that answered 429 or a challenge to
  // one request is sent nothing more: no retry.
  const audit = refusals.guard(forAuditOf(options, pageUrl));

  const subresources = audit.subresourceGate
    ? refusals.guard({ ...audit, gate: audit.subresourceGate })
    : audit;

  const headersOrigin =
    audit.headersOrigin ??
    (URL.canParse(pageUrl) ? new URL(pageUrl).origin : pageUrl);

  const budget: RenderBudget = {
    sent: 0,
    bytes: 0,
    maxRequests: settings.maxRequests ?? RENDER_REQUEST_LIMITS.maxRequests,
    maxBytesInFlight:
      settings.maxBytesInFlight ?? RENDER_REQUEST_LIMITS.maxBytesInFlight,
    robotsRead: new Set(),
  };

  /** The bytes each answer still holds, until the browser has it. */
  const held = new WeakMap<BrowserAnswer, number>();

  const through = async (request: BrowserRequest): Promise<BrowserAnswer> => {
    // A data:, blob: or file: URL never reaches this far in a browser; anything else is no request
    // the audit sends.
    if (
      !URL.canParse(request.url) ||
      !/^https?:$/u.test(new URL(request.url).protocol)
    ) {
      return fail("Failed");
    }

    if (!READ_METHODS.has(request.method.toUpperCase())) {
      return fail("BlockedByClient");
    }

    const own = request.navigation ? audit : subresources;

    try {
      // A refusal is recorded, as for the audit's own requests, and the browser told it was blocked.
      const answer = await refusals.run(request.url, () =>
        walk(own, headersOrigin, request, budget)
      );

      // Its bytes were counted as they were read (`readBudgeted`).
      if (answer?.kind === "fulfil") {
        held.set(answer, answer.body.byteLength);
      }

      return answer ?? fail("BlockedByClient");
    } catch (error) {
      return fail(
        error instanceof Error && error.name === "AbortError"
          ? "TimedOut"
          : "Failed"
      );
    }
  };

  return Object.assign(through, {
    delivered: (answer: BrowserAnswer) => {
      const bytes = held.get(answer);

      if (bytes !== undefined) {
        held.delete(answer);
        budget.bytes -= bytes;
      }
    },
    /** The bytes the render holds now: read or being read, and not yet delivered. */
    held: () => budget.bytes,
  });
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
  resourceType: () => string;
  isNavigationRequest: () => boolean;
  frame: () => { parentFrame: () => object | null };
}

/** Playwright's error codes for `route.abort`, which the browser sees as its own network error. */
const ABORT_CODES = {
  BlockedByClient: "blockedbyclient",
  Failed: "failed",
  TimedOut: "timedout",
} as const;

/** Whether `request` navigates the page's main frame; a service worker's request has no frame. */
const navigatesPage = (request: RequestLike): boolean => {
  if (!request.isNavigationRequest()) {
    return false;
  }

  try {
    return request.frame().parentFrame() === null;
  } catch {
    return false;
  }
};

/** The request as `FetchThrough` takes it. */
export const browserRequestOf = async (
  request: RequestLike
): Promise<BrowserRequest> => ({
  url: request.url(),
  method: request.method(),
  headers: await request.allHeaders(),
  resourceType: request.resourceType(),
  navigation: navigatesPage(request),
});

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
