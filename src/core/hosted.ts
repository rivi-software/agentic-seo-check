/**
 * The hosted server's rules (hosted/, issue #35): what it reads at most, which URLs it requests,
 * which answers are a site turning it away rather than the site's page, and robots.txt, which it
 * obeys for every request (issue #41). The Worker adds its limits and its signature on top,
 * through `hostedFetch`.
 */
import { challengeTitle } from "./aeo/probe.js";
import { sleep } from "./concurrency.js";
import { fetchPage, RequestRefusedError } from "./fetch.js";
import type {
  FetchOptions,
  FetchResult,
  Refusal,
  RequestGate,
} from "./fetch.js";
import {
  ROBOTS_TIMEOUT_MS,
  robotsOf,
  robotsUserAgentToken,
  ruleLineMatcher,
} from "./robots.js";
import type { RobotsResult } from "./robots.js";

/** The local server, which none of these limits apply to: the way out of every refusal. */
export const LOCAL_SERVER = "npx -y @rivi-software/agentic-seo-check mcp";

const USE_LOCAL = `Use the local server for it, which sends the requests from your machine: ${LOCAL_SERVER}`;

/**
 * What the hosted server reads and requests at most. A Worker isolate has 128 MB of memory: one
 * 2 MB page takes about 80 MB of it to audit, a 5 MB sitemap about 64 MB to parse.
 */
export const HOSTED_LIMITS = {
  /** Bytes of a page (5 MB on the local server). Above document.html-too-large's 1.5 MB. */
  maxBodyBytes: 2_000_000,
  /** Characters of inline `html`. */
  maxHtmlChars: 2_000_000,
  /**
   * Bytes of a request to the server, checked before it is parsed. 2,000,000 characters of HTML
   * are up to 6 MB in UTF-8, and JSON escaping adds to that.
   */
  maxRequestBytes: 8_000_000,
  /**
   * Pages a crawl audits (issue #73). A crawl keeps what it extracted from each page, not its DOM,
   * so its memory grows with `concurrency` rather than with this: 100 pages of 113 KB, both audits,
   * stay under a 128 MB heap.
   */
  maxPages: 100,
  maxDepth: 5,
  /** Requests at a time; a Worker has at most 6 connections waiting for headers. */
  concurrency: 4,
  /** Internal links, sitemap URLs and images a crawl checks, and as many external links. */
  maxLinkChecks: 100,
  timeoutMs: 15_000,
  maxSitemaps: 10,
  maxSitemapBytes: 5_000_000,
  /** `includePatterns` and `excludePatterns` are the caller's regular expressions, run here. */
  maxPatterns: 20,
  maxPatternChars: 200,
  /** `rules` and `disableRules`. */
  maxRuleIds: 500,
  maxRuleIdChars: 100,
  /** `baseline`: the finding ids of an earlier audit. */
  maxBaselineIds: 5000,
  maxBaselineIdChars: 300,
  maxKeywordChars: 200,
  /** `context`, the sentence an agent may write on what a call is for (issue #84). */
  maxContextChars: 1000,
  /** `llm_model`, the model an agent says it runs as (issue #101). */
  maxModelChars: 100,
  /** `conversation_id`: the UUIDv7 the server issued, with room for what an agent wraps it in. */
  maxConversationIdChars: 64,
  /** Each text of `send_feedback` (issue #101). */
  maxFeedbackChars: 2000,
  /**
   * How long robots.txt's Crawl-delay may add to one crawl, the delays of its requests to every
   * site added up: past it, the crawl stops requesting the site it would wait for, rather than keep
   * the caller waiting for minutes. One total, so that links to many sites cannot add more.
   */
  crawlDelayBudgetMs: 30_000,
} as const;

/** Names that only resolve on a local machine or network, never on the public internet. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"];

/** An IPv4 address as the URL parser writes it, which it does for every numeric form. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * What keeps `url` off the public internet, or undefined for an http(s) URL on a public hostname:
 * another scheme, credentials in it, an IP address, or a name that resolves on a machine or a
 * private network only, with `suffixes` as more such name endings. The hosted server's address
 * rules and the field data's (field-data.ts) read it.
 */
export const privateUrlKind = (
  url: URL,
  suffixes: readonly string[] = []
): "scheme" | "credentials" | "ip" | "local" | undefined => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "scheme";
  }

  if (url.username || url.password) {
    return "credentials";
  }

  const host = url.hostname.replace(/\.$/u, "");

  if (IPV4.test(host) || host.startsWith("[")) {
    return "ip";
  }

  return host === "localhost" ||
    !host.includes(".") ||
    [...LOCAL_SUFFIXES, ...suffixes].some((suffix) => host.endsWith(suffix))
    ? "local"
    : undefined;
};

/**
 * Why the hosted server will not request `url`, or undefined when it may: it requests http and
 * https URLs on public hostnames only. A Worker reaches no private network anyway; the rules give
 * a clear answer instead of a failed request.
 */
export const hostedUrlProblem = (url: URL): string | undefined => {
  const host = url.hostname.replace(/\.$/u, "");

  switch (privateUrlKind(url)) {
    case "scheme": {
      return `The hosted server requests http and https URLs only, not ${url.protocol} ones (${url.href}).`;
    }

    case "credentials": {
      return `The hosted server does not send credentials in a URL (${url.host}). A site behind a login is one for the local server, which can send your headers: ${LOCAL_SERVER}`;
    }

    case "ip": {
      return `The hosted server requests hostnames only, not IP addresses (${host}). ${USE_LOCAL}`;
    }

    case "local": {
      return `The hosted server cannot reach ${host}: it runs on Cloudflare's network, not on your machine or your network. ${USE_LOCAL}`;
    }

    default: {
      return undefined;
    }
  }
};

/**
 * Why an answer is the site refusing the hosted server rather than its page: a challenge, a rate
 * limit or a 403. A 429 or a challenge holds for every later request to the host; a 403 for the
 * URL alone, since a site may forbid one path to everyone. Undefined for a page.
 *
 * A refusal gives the site's answer and nothing more: the site decides which requests it serves,
 * and the hosted server, as a verified bot, points no way around that (issue #41).
 */
export const siteRefusal = (
  url: URL,
  response: Pick<Response, "status" | "headers">
): Refusal | undefined => {
  // Cloudflare marks every challenge page so (developers.cloudflare.com, "Detect a challenge page").
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
    return {
      scope: "host",
      reason: "challenge",
      message: `${url.hostname} answered the hosted server with a challenge page (cf-mitigated: challenge), so the hosted server did not audit it.`,
    };
  }

  if (response.status === 429) {
    return {
      scope: "host",
      reason: "http_429",
      message: `${url.hostname} answered the hosted server with HTTP 429 (Too Many Requests), so the hosted server sent it no more requests.`,
    };
  }

  if (response.status === 403) {
    return {
      scope: "url",
      reason: "http_403",
      message: `${url.href} answered the hosted server with HTTP 403 (Forbidden), so the hosted server did not audit it.`,
    };
  }

  return undefined;
};

/**
 * The statuses a challenge page comes with besides 403 and 429, which `siteRefusal` answers from
 * the status alone: 503 (an "under attack" check) and 405 (AWS WAF's CAPTCHA). A 401 or 404 page
 * titled "Access denied" is the site's own.
 */
const CHALLENGE_STATUSES = new Set([405, 503]);

/** An error page that is a CDN's or bot protection's interstitial rather than the site's own. */
const challengeRefusal = (
  url: URL,
  result: FetchResult
): Refusal | undefined => {
  if (
    result.status === null ||
    !CHALLENGE_STATUSES.has(result.status) ||
    !result.body
  ) {
    return undefined;
  }

  const title = challengeTitle(result.body.slice(0, 10_000));

  return title === null
    ? undefined
    : {
        scope: "host",
        reason: "challenge",
        message: `${url.hostname} answered the hosted server with a challenge page ("${title}", HTTP ${result.status}), so the hosted server did not audit it.`,
      };
};

/** A refusal of the hosted address rules (`hostedUrlProblem`), for the URL alone. */
const addressRefusal = (problem: string): Refusal => ({
  scope: "url",
  reason: "address",
  message: problem,
});

/**
 * The URL rules and the site refusals, then the Worker's own gate (its request limits), which only
 * sees requests the rules allow. robots.txt is requested through this gate alone.
 */
const siteGate = (limits?: RequestGate): RequestGate => ({
  beforeRequest: (url) => {
    const problem = hostedUrlProblem(url);

    return problem ? addressRefusal(problem) : limits?.beforeRequest(url);
  },
  afterResponse: (url, response) =>
    siteRefusal(url, response) ?? limits?.afterResponse?.(url, response),
  afterBody: (url, result) =>
    challengeRefusal(url, result) ?? limits?.afterBody?.(url, result),
});

/** What the Worker gives a hosted call's requests (hosted/src/limits.ts). */
export interface HostedRequests {
  /** The User-Agent of every request, with the hosted server's product token, agentic-seo-check. */
  userAgent: string;
  /** Signs each request (Web Bot Auth). */
  sign?: FetchOptions["sign"];
  /** The Worker's request limits, asked after the hosted server's own rules. */
  limits?: RequestGate;
  /** The call crawls a site, so it keeps the Crawl-delay robots.txt asks for. */
  crawl: boolean;
}

/**
 * Why robots.txt keeps the hosted server from `url`, or undefined when it may request it: the
 * group for its product token, or `*` without one, as a crawl reads it (RFC 9309).
 */
const disallowed = (
  url: URL,
  robots: RobotsResult,
  token: string
): Refusal | undefined => {
  // RFC 9309, section 2.3.1.4: a server error or no answer means the crawler may request nothing.
  const { status, error } = robots.info;

  if (status === null || status >= 500) {
    const answer =
      status === null
        ? `could not be read (${error})`
        : `answered HTTP ${status}`;

    return {
      scope: "host",
      reason: "robots_unreadable",
      message: `${robots.info.url} ${answer}, and a crawler that cannot read robots.txt takes it to disallow everything (RFC 9309), so the hosted server did not request ${url.href}.`,
    };
  }

  if (robots.crawlerAllows(url.href) || robots.text === null) {
    return undefined;
  }

  const line = ruleLineMatcher(robots.info.url, robots.text)(url.href, token);
  const rule = robots.text.split(/\r?\n/u)[line - 1]?.trim().slice(0, 120);

  return {
    scope: "url",
    reason: "robots_txt",
    message: `${robots.info.url} keeps ${token} from ${url.href}${rule ? ` (line ${line}: "${rule}")` : ""}, so the hosted server did not request it.`,
  };
};

/**
 * The fetch options of a hosted tool call: the User-Agent, the cap on a body, the signature, and a
 * gate that obeys robots.txt before every request but robots.txt itself, reads each site's
 * robots.txt once, and in a crawl waits between requests to a site as its Crawl-delay asks. The
 * gate's robots.txt is the audit's too (`RequestGate.robotsTxt`), so it costs no second request.
 */
export const hostedFetch = (requests: HostedRequests): FetchOptions => {
  const { userAgent, sign, limits, crawl } = requests;
  const token = robotsUserAgentToken(userAgent);
  const base = siteGate(limits);
  const files = new Map<string, Promise<FetchResult>>();
  const parsed = new Map<string, Promise<RobotsResult>>();
  /** When each origin's robots.txt was requested. */
  const sentRobots = new Map<string, number>();
  /**
   * Each origin's requests under Crawl-delay, one after another: when the last of them went. A
   * request waits for the one before it to go, then for the delay, so a timer that fires late
   * never shortens the next gap.
   */
  const lanes = new Map<string, Promise<number>>();
  /** The delay Crawl-delay has added to the crawl so far, every site's together. */
  let delayedMs = 0;

  const robotsTxt = (origin: string): Promise<FetchResult> => {
    let pending = files.get(origin);

    if (!pending) {
      sentRobots.set(origin, Date.now());
      pending = fetchPage(new URL("/robots.txt", origin).href, {
        userAgent,
        sign,
        maxBodyBytes: HOSTED_LIMITS.maxBodyBytes,
        timeoutMs: ROBOTS_TIMEOUT_MS,
        gate: base,
      });
      files.set(origin, pending);
    }

    return pending;
  };

  const robotsFor = (origin: string): Promise<RobotsResult> => {
    let pending = parsed.get(origin);

    if (!pending) {
      const url = new URL("/robots.txt", origin).href;
      pending = robotsTxt(origin).then((res) => robotsOf(url, res, userAgent));
      parsed.set(origin, pending);
    }

    return pending;
  };

  /** Waits for the request's turn under Crawl-delay, or refuses it past the crawl's budget. */
  const pace = async (
    url: URL,
    robots: RobotsResult
  ): Promise<Refusal | undefined> => {
    if (!crawl || robots.crawlDelay === null) {
      return undefined;
    }

    const delayMs = robots.crawlDelay * 1000;

    // Each request costs the crawl one delay, however slow the site is to answer.
    if (delayedMs + delayMs > HOSTED_LIMITS.crawlDelayBudgetMs) {
      return {
        scope: "host",
        reason: "crawl_delay",
        message: `${robots.info.url} asks ${token} to wait ${robots.crawlDelay} s between requests (Crawl-delay), and a crawl on the hosted server waits at most ${HOSTED_LIMITS.crawlDelayBudgetMs / 1000} s in all for Crawl-delay, so it sent ${url.hostname} no more requests.`,
      };
    }

    delayedMs += delayMs;

    const previous =
      lanes.get(url.origin) ??
      Promise.resolve(sentRobots.get(url.origin) ?? Date.now());

    const turn = previous.then(async (went) => {
      await sleep(went + delayMs - Date.now());

      return Date.now();
    });

    lanes.set(url.origin, turn);
    await turn;

    return undefined;
  };

  /** robots.txt's say on `url`: a refusal, or undefined once it may go. */
  const obeyRobots = async (url: URL): Promise<Refusal | undefined> => {
    let robots: RobotsResult;

    try {
      robots = await robotsFor(url.origin);
    } catch (error) {
      if (!(error instanceof RequestRefusedError)) {
        throw error;
      }

      // A robots.txt the site forbids (a 403) is one there is none of, as a 4xx is (RFC 9309):
      // the page's own answer decides. A refusal of the host or of everything holds for the page.
      return error.scope === "url"
        ? undefined
        : { scope: error.scope, message: error.message, reason: error.reason };
    }

    return disallowed(url, robots, token) ?? pace(url, robots);
  };

  const gate: RequestGate = {
    ...base,
    beforeRequest: async (url) => {
      const problem = hostedUrlProblem(url);

      if (problem) {
        return addressRefusal(problem);
      }

      const refusal =
        url.pathname === "/robots.txt" ? undefined : await obeyRobots(url);

      return refusal ?? limits?.beforeRequest(url);
    },
    robotsTxt,
  };

  return {
    userAgent,
    sign,
    maxBodyBytes: HOSTED_LIMITS.maxBodyBytes,
    gate,
  };
};
