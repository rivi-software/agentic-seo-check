/**
 * The hosted server's limits (issue #35, part 4), in the shape `createMcpServer`'s hosted profile
 * asks for them: per caller or platform before a tool call, per site before each request, per day
 * for every request together, and per day for the sites each caller audits (issue #73). A refusal
 * names the limit, says when to try again and points to the local server, which has none.
 */
import type { RequestGate } from "../../src/core/fetch.js";
import { LOCAL_SERVER } from "../../src/core/hosted.js";
import type {
  HostedCallEnd,
  HostedCallInfo,
  HostedProfile,
} from "../../src/mcp.js";
import { VERSION } from "../../src/version.js";
import type { Caller } from "./callers.js";
import { requestSigner } from "./signing.js";

/** The rate limits of the Worker's configuration by binding name, built in by scripts/defines.ts. */
declare const HOSTED_RATE_LIMITS: Record<
  string,
  { limit: number; period: number }
>;

export const ORIGIN = "https://mcp.agentic-seo.rivi.software";

/**
 * The MCP server's hostname in 0.7.0, which clients may still be set up with: it keeps answering
 * at /mcp, and sends its pages to ORIGIN.
 */
export const FORMER_HOST = "mcp.agentic-seo-check.rivi.software";

/** The project's website, a Worker of its own on a hostname of its own (issue #39, src/site/worker.ts). */
export { WEBSITE_URL as SITE_ORIGIN } from "../../src/brand.js";

/**
 * The User-Agent of every request: the product token that robots.txt groups match, and the page
 * that says what the requests are and how to stop them.
 */
export const USER_AGENT = `Mozilla/5.0 (compatible; agentic-seo-check/${VERSION}; +${ORIGIN}/crawler)`;

export type LimitName =
  | "SITE_REQUESTS"
  | "CALLER_CALLS"
  | "CALLER_CRAWLS"
  | "PLATFORM_CALLS"
  | "PLATFORM_CRAWLS";

/** A rate limit as people read it: 300 a minute. */
export interface RateLimitText {
  limit: number;
  /** "minute" or "10 seconds", the two periods the binding has. */
  period: string;
}

export const rateLimit = (name: LimitName): RateLimitText => {
  const config = HOSTED_RATE_LIMITS[name];

  if (!config) {
    throw new Error(`wrangler.jsonc has no rate limit ${name}.`);
  }

  return {
    limit: config.limit,
    period: config.period === 60 ? "minute" : `${config.period} seconds`,
  };
};

/** When to try again after a limit of `period`: "in a minute", "in 10 seconds". */
const tryAgain = (period: string): string =>
  `Try again in ${period === "minute" ? "a minute" : period}.`;

const NO_LIMITS = `Or use the local server, which has no limits: ${LOCAL_SERVER}`;

/** Who a caller is, in a refusal. */
const PLATFORMS: Record<NonNullable<Caller["platform"]>, string> = {
  anthropic: "claude.ai, Cowork and the Claude apps",
  openai: "ChatGPT",
};

const callsRefusal = (caller: Caller, crawls: boolean): string => {
  const scope = caller.platform ? "PLATFORM" : "CALLER";
  const name: LimitName = `${scope}_${crawls ? "CRAWLS" : "CALLS"}`;

  const { limit, period } = rateLimit(name);
  const what = crawls ? `${limit} crawls` : `${limit} tool calls`;

  const who = caller.platform
    ? `The users of ${PLATFORMS[caller.platform]} have together started ${what} on the hosted server in the last ${period}, its limit for the platform.`
    : `This address has started ${what} on the hosted server in the last ${period}, its limit per caller.`;

  return `${who} ${tryAgain(period)} ${NO_LIMITS}`;
};

const siteRefusal = (host: string): string => {
  const { limit, period } = rateLimit("SITE_REQUESTS");

  return `The hosted server has sent ${host} ${limit} requests in the last ${period}, its limit per site for all its callers together. ${tryAgain(period)} ${NO_LIMITS}`;
};

const dailyRefusal = (limit: number): string =>
  `The hosted server has sent its ${limit.toLocaleString("en")} requests for today, its daily limit for all callers together. Audits that request a site wait until 00:00 UTC; audits of inline HTML and seo_list_rules still work. ${NO_LIMITS}`;

const sitesRefusal = (caller: Caller, limit: number): string => {
  const sites = `${limit} different ${limit === 1 ? "site" : "sites"}`;

  const who = caller.platform
    ? `The users of ${PLATFORMS[caller.platform]} have together audited ${sites} on the hosted server today, its daily limit for the platform. Sites they audited today still work`
    : `This address has audited ${sites} on the hosted server today, its daily limit per caller. Sites it audited today still work`;

  return `${who}; others wait until 00:00 UTC. ${NO_LIMITS}`;
};

/**
 * The site a call's host counts as for the daily cap: example.com and www.example.com are one.
 * The URL parser has already lowercased the host.
 */
export const siteOf = (host: string): string =>
  host.replace(/\.$/u, "").replace(/^www\./u, "");

/** The UTC date the daily limit counts for. */
const today = (): string => new Date().toISOString().slice(0, 10);

/** The day's counts that the HostedState Durable Object keeps: requests, and each caller's sites. */
export interface DayCounter {
  requests: (day: string) => Promise<number>;
  addRequests: (day: string, count: number) => Promise<number>;
  /** Whether `caller` may audit `site` today, counting it when it is new; see HostedState. */
  admitSite: (
    day: string,
    caller: string,
    site: string,
    limit: number
  ) => Promise<boolean>;
}

/** The daily limits, as the landing page states them. */
export type DailyLimits = Pick<
  LimitsEnv,
  "DAILY_REQUESTS" | "CALLER_SITES" | "PLATFORM_SITES"
>;

/** The bindings and variables the limits use (wrangler.jsonc, and wrangler.site.jsonc alike). */
export interface LimitsEnv {
  MODE: string;
  DAILY_REQUESTS: number;
  /** Different sites one IP address may audit a day. */
  CALLER_SITES: number;
  /** Different sites claude.ai's users, or ChatGPT's, may audit a day, all together. */
  PLATFORM_SITES: number;
  SITE_REQUESTS: RateLimit;
  CALLER_CALLS: RateLimit;
  CALLER_CRAWLS: RateLimit;
  PLATFORM_CALLS: RateLimit;
  PLATFORM_CRAWLS: RateLimit;
  CALLS: AnalyticsEngineDataset;
  STATE: { getByName: (name: string) => DayCounter };
  /**
   * The Ed25519 keys that sign every request (Web Bot Auth, issue #41), a Worker secret: a JSON
   * list of private JWKs, the first signing. Without it the requests go out unsigned.
   */
  WEB_BOT_AUTH_KEYS?: string;
}

/**
 * The day's count as this isolate last read it, by Durable Object binding: the object is asked at
 * most every 30 seconds, since the daily limit is a circuit breaker, not an exact count.
 */
const todayCache = new WeakMap<
  LimitsEnv["STATE"],
  { day: string; count: number; readAt: number }
>();

const requestsToday = async (env: LimitsEnv): Promise<number> => {
  const day = today();
  const cached = todayCache.get(env.STATE);

  if (cached?.day === day && Date.now() - cached.readAt < 30_000) {
    return cached.count;
  }

  const count = await env.STATE.getByName("global").requests(day);
  todayCache.set(env.STATE, { day, count, readAt: Date.now() });

  return count;
};

const countRequests = async (
  env: LimitsEnv,
  requests: number
): Promise<void> => {
  const day = today();
  const count = await env.STATE.getByName("global").addRequests(day, requests);
  todayCache.set(env.STATE, { day, count, readAt: Date.now() });
};

const sitesLimit = (env: LimitsEnv, caller: Caller): number =>
  caller.platform ? env.PLATFORM_SITES : env.CALLER_SITES;

/** Whether `caller` may audit the site of `host` today; a new site counts. */
const admitSite = (
  env: LimitsEnv,
  caller: Caller,
  host: string
): Promise<boolean> =>
  env.STATE.getByName("global").admitSite(
    today(),
    caller.key,
    siteOf(host),
    sitesLimit(env, caller)
  );

/** Throws the refusal of a tool call that the mode or a limit keeps out. */
const admit = async (
  env: LimitsEnv,
  caller: Caller,
  call: HostedCallInfo
): Promise<void> => {
  if (env.MODE === "closed") {
    throw new Error(`The hosted server is paused. ${NO_LIMITS}`);
  }

  if (call.crawl && env.MODE === "no-crawls") {
    throw new Error(
      `The hosted server does not crawl sites at the moment; audits of single pages still work. ${NO_LIMITS}`
    );
  }

  if (call.tool === "seo_list_rules") {
    return;
  }

  const calls = caller.platform ? env.PLATFORM_CALLS : env.CALLER_CALLS;
  const callAllowed = await calls.limit({ key: caller.key });

  if (!callAllowed.success) {
    throw new Error(callsRefusal(caller, false));
  }

  if (call.crawl) {
    const crawls = caller.platform ? env.PLATFORM_CRAWLS : env.CALLER_CRAWLS;
    const crawlAllowed = await crawls.limit({ key: caller.key });

    if (!crawlAllowed.success) {
      throw new Error(callsRefusal(caller, true));
    }
  }

  if (call.fetches && (await requestsToday(env)) >= env.DAILY_REQUESTS) {
    throw new Error(dailyRefusal(env.DAILY_REQUESTS));
  }

  // Last, so that a call another limit refuses uses up no site.
  if (call.fetches && call.host && !(await admitSite(env, caller, call.host))) {
    throw new Error(sitesRefusal(caller, sitesLimit(env, caller)));
  }
};

/** How a call ended, for its record: a limit kept it out ("limited"), or `HostedCallEnd.outcome`. */
export type Outcome = HostedCallEnd["outcome"] | "limited";

/** A call's record as the analytics hear it (analytics.ts): no hostname, which is for abuse reports only. */
export interface CallRecord {
  tool: string;
  outcome: Outcome;
  requests: number;
  pages: number;
}

/**
 * Analytics Engine throws for an index longer than this many bytes, and a hostname can have 253
 * characters. Hostnames are ASCII (a URL holds a Unicode name in punycode), so cutting characters
 * cuts bytes; the whole hostname is in `blob3`.
 */
export const MAX_INDEX_BYTES = 96;

/**
 * One record per tool call in Analytics Engine, which keeps it for three months: the tool, the
 * outcome, the duration, the requests sent and pages audited, and the target hostname, so that an
 * abuse report about a site can be checked against what was sent to it. Never a path, a query, the
 * caller's address or anything the caller sent. A record that cannot be written is logged, and
 * never fails the call it is about.
 */
const record = (
  env: LimitsEnv,
  call: HostedCallInfo,
  outcome: Outcome,
  numbers: { durationMs: number; requests: number; pages: number }
): void => {
  try {
    env.CALLS.writeDataPoint({
      indexes: [(call.host ?? call.tool).slice(0, MAX_INDEX_BYTES)],
      blobs: [call.tool, outcome, call.host ?? ""],
      doubles: [numbers.durationMs, numbers.requests, numbers.pages],
    });
  } catch (error) {
    console.error(
      `Could not record a ${call.tool} call: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * Requests are added to the day's count as they go, in batches of this many, so a call that is cut
 * off before it ends still counts nearly all it sent.
 */
const COUNT_BATCH = 25;

/** The requests one call sent, and how many of them the day's count has. */
interface Sent {
  requests: number;
  counted: number;
}

/** Adds what `sent` has not counted yet to the day's count. */
const countSent = (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  sent: Sent
): void => {
  const uncounted = sent.requests - sent.counted;

  if (uncounted > 0) {
    sent.counted = sent.requests;
    ctx.waitUntil(countRequests(env, uncounted));
  }
};

/**
 * The sites a call that audits one page may request: its own, and each other site a redirect of
 * the page leads to, which counts as a site of the day too. A page audit requests nothing else
 * (robots.txt and llms.txt are its own site's), so without this a redirect from a site the caller
 * controls would audit any number of others. A crawl leaves out what redirects off its site, and
 * its other requests to other hosts are link checks, so it has no such check.
 */
const pageSites = (
  env: LimitsEnv,
  caller: Caller,
  host: string
): ((hostname: string) => Promise<boolean>) => {
  const sites = new Map([[siteOf(host), Promise.resolve(true)]]);

  return (hostname) => {
    const site = siteOf(hostname);
    let admitted = sites.get(site);

    if (!admitted) {
      admitted = admitSite(env, caller, hostname);
      sites.set(site, admitted);
    }

    return admitted;
  };
};

/**
 * The gate of one call: the sites a page audit may reach (`reaches`), the limit per site, and a
 * count of the requests it lets through.
 */
const siteGate = (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  sent: Sent,
  reaches?: { caller: Caller; site: (hostname: string) => Promise<boolean> }
): RequestGate => ({
  beforeRequest: async (url) => {
    if (reaches && !(await reaches.site(url.hostname))) {
      return {
        scope: "host",
        message: `The page led to ${url.hostname}, another site than the one audited. ${sitesRefusal(reaches.caller, sitesLimit(env, reaches.caller))}`,
      };
    }

    const allowed = await env.SITE_REQUESTS.limit({ key: url.hostname });

    if (!allowed.success) {
      return { scope: "host", message: siteRefusal(url.hostname) };
    }

    sent.requests += 1;

    if (sent.requests - sent.counted >= COUNT_BATCH) {
      countSent(env, ctx, sent);
    }
  },
});

/**
 * The hosted profile of one request to /mcp: its caller's limits, and the Worker's bindings.
 * `observe` hears each call's record as it is written.
 */
export const hostedProfile = (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  caller: Caller,
  observe?: (record: CallRecord) => void
): HostedProfile => {
  const keep = (
    call: HostedCallInfo,
    outcome: Outcome,
    numbers: { durationMs: number; requests: number; pages: number }
  ): void => {
    record(env, call, outcome, numbers);
    observe?.({
      tool: call.tool,
      outcome,
      requests: numbers.requests,
      pages: numbers.pages,
    });
  };

  return {
    userAgent: USER_AGENT,
    sign: requestSigner(env.WEB_BOT_AUTH_KEYS, ORIGIN),
    startCall: async (call) => {
      const started = Date.now();

      try {
        await admit(env, caller, call);
      } catch (error) {
        keep(call, "limited", {
          durationMs: Date.now() - started,
          requests: 0,
          pages: 0,
        });

        throw error;
      }

      const sent: Sent = { requests: 0, counted: 0 };

      return {
        gate: siteGate(
          env,
          ctx,
          sent,
          call.host && !call.crawl
            ? { caller, site: pageSites(env, caller, call.host) }
            : undefined
        ),
        end: ({ outcome, pages }) => {
          keep(call, outcome, {
            durationMs: Date.now() - started,
            requests: sent.requests,
            pages,
          });

          countSent(env, ctx, sent);
        },
      };
    },
  };
};
