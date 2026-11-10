/**
 * The hosted server's rules (hosted/, issue #35): what it reads at most, which URLs it requests,
 * and which answers are a site turning it away rather than the site's page. The Worker adds its
 * limits on top, through the gate it passes to `hostedGate`.
 */
import { challengeTitle } from "./aeo/probe.js";
import type { FetchResult, Refusal, RequestGate } from "./fetch.js";

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
  maxPages: 25,
  maxDepth: 3,
  /** Requests at a time; a Worker has at most 6 connections waiting for headers. */
  concurrency: 4,
  /** Internal links, sitemap URLs and images a crawl checks, and as many external links. */
  maxLinkChecks: 50,
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
} as const;

/** Names that only resolve on a local machine or network, never on the public internet. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"];

/** An IPv4 address as the URL parser writes it, which it does for every numeric form. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * Why the hosted server will not request `url`, or undefined when it may: it requests http and
 * https URLs on public hostnames only. A Worker reaches no private network anyway; the rules give
 * a clear answer instead of a failed request.
 */
export const hostedUrlProblem = (url: URL): string | undefined => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `The hosted server requests http and https URLs only, not ${url.protocol} ones (${url.href}).`;
  }

  if (url.username || url.password) {
    return `The hosted server does not send credentials in a URL (${url.host}). A site behind a login is one for the local server, which can send your headers: ${LOCAL_SERVER}`;
  }

  const host = url.hostname.replace(/\.$/u, "");

  if (IPV4.test(host) || host.startsWith("[")) {
    return `The hosted server requests hostnames only, not IP addresses (${host}). ${USE_LOCAL}`;
  }

  if (
    host === "localhost" ||
    !host.includes(".") ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return `The hosted server cannot reach ${host}: it runs on Cloudflare's network, not on your machine or your network. ${USE_LOCAL}`;
  }

  return undefined;
};

const REFUSED_BY_SITE = `Many sites turn away requests from Cloudflare Workers, which the hosted server runs on, while they serve the page to everyone else. ${USE_LOCAL}`;

/**
 * Why an answer is the site refusing the hosted server rather than its page: a challenge, a rate
 * limit or a 403. A 429 or a challenge holds for every later request to the host; a 403 for the
 * URL alone, since a site may forbid one path to everyone. Undefined for a page.
 */
export const siteRefusal = (
  url: URL,
  response: Pick<Response, "status" | "headers">
): Refusal | undefined => {
  // Cloudflare marks every challenge page so (developers.cloudflare.com, "Detect a challenge page").
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
    return {
      scope: "host",
      message: `${url.hostname} answered the hosted server with a challenge page (cf-mitigated: challenge). ${REFUSED_BY_SITE}`,
    };
  }

  if (response.status === 429) {
    return {
      scope: "host",
      message: `${url.hostname} answered the hosted server with HTTP 429 (Too Many Requests). A site that counts requests per address counts every Cloudflare Worker as one. Try again later, or use the local server, which sends the requests from your machine: ${LOCAL_SERVER}`,
    };
  }

  if (response.status === 403) {
    return {
      scope: "url",
      message: `${url.href} answered the hosted server with HTTP 403 (Forbidden). ${REFUSED_BY_SITE}`,
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
        message: `${url.hostname} answered the hosted server with a challenge page ("${title}", HTTP ${result.status}). ${REFUSED_BY_SITE}`,
      };
};

/**
 * The gate of a hosted tool call: the URL rules and the site refusals, then the Worker's own gate
 * (its request limits), which only sees requests the rules allow.
 */
export const hostedGate = (limits?: RequestGate): RequestGate => ({
  beforeRequest: (url) => {
    const problem = hostedUrlProblem(url);

    return problem
      ? { scope: "url", message: problem }
      : limits?.beforeRequest(url);
  },
  afterResponse: (url, response) =>
    siteRefusal(url, response) ?? limits?.afterResponse?.(url, response),
  afterBody: (url, result) =>
    challengeRefusal(url, result) ?? limits?.afterBody?.(url, result),
});
