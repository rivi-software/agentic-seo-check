import { createRequire } from "node:module";

import type robotsParserModule from "robots-parser";

import { fetchPage } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import type { RobotsTxtInfo } from "./types.js";

// robots-parser is CommonJS; require() avoids ESM default-export interop mismatches.
// SAFETY: require() returns the package's module.exports, which is the parser function that its
// index.d.ts declares as the default export.
const robotsParser = createRequire(import.meta.url)(
  "robots-parser"
) as (typeof robotsParserModule)["default"];

export interface RobotsResult {
  info: RobotsTxtInfo;
  /** Returns true when crawling the URL is allowed (unknown/missing robots.txt allows everything). */
  allows: (url: string) => boolean;
  /** The robots.txt text up to the size crawlers must read (RFC 9309: 500 KiB), or null when there is none. */
  text: string | null;
}

/** The part of a robots.txt file a crawler must read at least (RFC 9309 section 2.5). */
const MAX_ROBOTS_BYTES = 512_000;

/**
 * Whether robots.txt at `url` lets the crawler with product token `agent` fetch `target`. A URL
 * on another origin is allowed: this robots.txt has no say over it.
 */
export const agentMatcher = (
  url: string,
  text: string
): ((target: string, agent: string) => boolean) => {
  const robot = robotsParser(url, text.slice(0, MAX_ROBOTS_BYTES));

  return (target, agent) => robot.isAllowed(target, agent) ?? true;
};

/**
 * The line of robots.txt at `url` (1-based) whose rule decides whether `agent` may fetch `target`,
 * or -1 when no rule matches, so a fix can quote the Disallow line that blocks a URL.
 */
export const ruleLineMatcher = (
  url: string,
  text: string
): ((target: string, agent: string) => number) => {
  const robot = robotsParser(url, text.slice(0, MAX_ROBOTS_BYTES));

  return (target, agent) => robot.getMatchingLineNumber(target, agent);
};

export const buildRobots = (
  url: string,
  status: number | null,
  error: string | undefined,
  text: string | null,
  userAgent: string
): RobotsResult => {
  const info: RobotsTxtInfo = {
    url,
    status,
    found: text !== null,
    sitemaps: [],
    text: text ? text.slice(0, 20_000) : null,
    bytes: text === null ? null : Buffer.byteLength(text),
  };

  if (error) {
    info.error = error;
  }

  if (text === null) {
    return { info, allows: () => true, text: null };
  }

  const robot = robotsParser(url, text);
  info.sitemaps = robot.getSitemaps();

  return {
    info,
    text: text.slice(0, MAX_ROBOTS_BYTES),
    allows: (target: string) => {
      const allowed = robot.isAllowed(target, userAgent);

      return allowed === undefined ? true : allowed;
    },
  };
};

export const loadRobotsTxt = async (
  origin: string,
  userAgent: string,
  options: FetchOptions = {}
): Promise<RobotsResult> => {
  const url = new URL("/robots.txt", origin).href;

  const res = await fetchPage(url, {
    ...options,
    timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000),
  });

  const found =
    res.status === 200 &&
    res.body !== null &&
    !res.error &&
    !/<html/iu.test(res.body.slice(0, 500));

  return buildRobots(
    url,
    res.status,
    res.error,
    found ? res.body : null,
    userAgent
  );
};

/** Short bot token used for robots.txt matching, derived from the full UA string. */
export const robotsUserAgentToken = (userAgent: string): string => {
  const match = /agentic-seo-check|Googlebot|bingbot/iu.exec(userAgent);

  return match ? match[0] : userAgent;
};
