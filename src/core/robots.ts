import robotsParserModule from "robots-parser";

import { fetchPage } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import type { RobotsTxtInfo } from "./types.js";

/** A robots.txt file as robots-parser reads it: the methods the audit calls. */
interface Robot {
  isAllowed: (url: string, ua?: string) => boolean | undefined;
  getMatchingLineNumber: (url: string, ua?: string) => number;
  getSitemaps: () => string[];
}

type RobotsParser = (url: string, robotstxt: string) => Robot;

/**
 * robots-parser is CommonJS, imported statically so a bundler (the hosted server's) takes it in.
 * Node and bundlers hand a default import its module.exports, the parser function itself; its
 * index.d.ts declares the parser as the module's `default`, so TypeScript's Node resolution types
 * the import as the module and its bundler resolution as the parser. Either way, this is the parser.
 */
const parserOf = (
  imported: RobotsParser | { default: RobotsParser }
): RobotsParser => ("default" in imported ? imported.default : imported);

const robotsParser = parserOf(robotsParserModule);

export interface RobotsResult {
  info: RobotsTxtInfo;
  /**
   * Returns true when robots.txt allows the URL for the audit's User-Agent as robots-parser reads
   * it (unknown/missing robots.txt allows everything). The site rules judge blocked pages by this.
   */
  allows: (url: string) => boolean;
  /**
   * Returns true when this crawler may request the URL: the group for its product token
   * (`agentic-seo-check`), or `*` when there is none (RFC 9309, section 2.2.1). A site can keep
   * the audit out without blocking anyone else.
   */
  crawlerAllows: (url: string) => boolean;
  /** The robots.txt text up to the size crawlers must read (RFC 9309: 500 KiB), or null when there is none. */
  text: string | null;
}

/** The part of a robots.txt file a crawler must read at least (RFC 9309 section 2.5). */
const MAX_ROBOTS_BYTES = 512_000;

/** Short bot token used for robots.txt matching, derived from the full UA string. */
export const robotsUserAgentToken = (userAgent: string): string => {
  const match = /agentic-seo-check|Googlebot|bingbot/iu.exec(userAgent);

  return match ? match[0] : userAgent;
};

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
    return { info, allows: () => true, crawlerAllows: () => true, text: null };
  }

  const robot = robotsParser(url, text);
  info.sitemaps = robot.getSitemaps();
  const token = robotsUserAgentToken(userAgent);

  return {
    info,
    text: text.slice(0, MAX_ROBOTS_BYTES),
    allows: (target: string) => robot.isAllowed(target, userAgent) ?? true,
    // robots-parser keeps what comes before the first "/" of a User-Agent ("Mozilla" for the
    // audit's own), so the product token is passed on its own.
    crawlerAllows: (target: string) => robot.isAllowed(target, token) ?? true,
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
