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
}

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
  };

  if (error) {
    info.error = error;
  }

  if (text === null) {
    return { info, allows: () => true };
  }

  const robot = robotsParser(url, text);
  info.sitemaps = robot.getSitemaps();

  return {
    info,
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
