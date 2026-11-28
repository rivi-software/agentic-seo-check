import { createHmac, randomBytes } from "node:crypto";

import { WEBSITE_URL } from "../../src/brand.js";
import { RequestRefusedError } from "../../src/core/fetch.js";
import type { RequestGate } from "../../src/core/fetch.js";
import { LOCAL_SERVER } from "../../src/core/hosted.js";
/**
 * The hosted server's limits (issue #35, part 4), in the shape `createMcpServer`'s hosted profile
 * asks for them: per caller or platform before a tool call, per site before each request, per day
 * for every request together, and per day for the sites each caller audits (issue #73). A refusal
 * names the limit, says when to try again and points to the local server, which has none.
 */
import { SHARE_LIMIT_MESSAGE } from "../../src/core/share.js";
import { CallLimitError } from "../../src/mcp-hosted.js";
import type {
  HostedCallEnd,
  HostedCallInfo,
  HostedProfile,
} from "../../src/mcp.js";
import { VERSION } from "../../src/version.js";
import type { ReportTask } from "./analytics.js";
import type { Caller } from "./callers.js";
import { cruxOptions } from "./crux.js";
import type { CruxEnv } from "./crux.js";
import type { PsiEnv } from "./psi.js";
import { DIRECTORY_PATH, requestSigner } from "./signing.js";
import { globalState } from "./state.js";
import type { StateEnv } from "./state.js";

/** The rate limits of the Worker's configuration by binding name, built in by scripts/defines.ts. */
declare const HOSTED_RATE_LIMITS: Record<
  string,
  { limit: number; period: number }
>;

/**
 * The one hostname of the website and the MCP server (issue #168). The website's Worker has it as
 * its custom domain (src/site/worker.ts); the MCP server's Worker takes routes on it for its own
 * paths (wrangler.jsonc), which Cloudflare puts before the custom domain.
 */
export {
  MCP_URL,
  WEBSITE_URL as ORIGIN,
  WEBSITE_URL as SITE_ORIGIN,
} from "../../src/brand.js";

/**
 * The MCP server's own paths on ORIGIN, which its Worker's routes take (wrangler.jsonc); the
 * website's Worker has the rest. configs.test.ts holds the routes to this list.
 */
export const SERVER_PATHS: readonly string[] = [
  "/mcp",
  "/crawler",
  DIRECTORY_PATH,
  "/.well-known/openai-apps-challenge",
];

/**
 * The MCP server's hostnames before issue #168: mcp.agentic-seo.rivi.software, and
 * mcp.agentic-seo-check.rivi.software from 0.7.0. Clients may still be set up with either, so
 * both keep answering at /mcp and send everything else to ORIGIN (index.ts).
 */
export const FORMER_SERVER_HOSTS: ReadonlySet<string> = new Set([
  "mcp.agentic-seo.rivi.software",
  "mcp.agentic-seo-check.rivi.software",
]);

/**
 * The premium server's hostname (issue #229): the same tools behind an account's sign-in, with
 * OAuth's endpoints and discovery documents, which ORIGIN never serves (src/premium/). The MCP
 * server's Worker has it as a custom domain.
 */
export const PREMIUM_HOST = "premium.agentic-seo.org";

export const PREMIUM_ORIGIN = `https://${PREMIUM_HOST}`;

/** The website's hostname before issue #168, which sends every request to ORIGIN (site/routes.ts). */
export const FORMER_SITE_HOST = "agentic-seo.rivi.software";

/**
 * The origin the bot names in its User-Agent and its Signature-Agent, whose key directory
 * Cloudflare's verified-bot registration names (issue #41). It stays on the former hostname, which
 * keeps serving the directory, until the registration names ORIGIN's.
 */
export const BOT_ORIGIN = "https://mcp.agentic-seo.rivi.software";

/**
 * The User-Agent of every request: the product token that robots.txt groups match, and the page
 * that says what the requests are and how to stop them.
 */
export const USER_AGENT = `Mozilla/5.0 (compatible; agentic-seo-check/${VERSION}; +${BOT_ORIGIN}/crawler)`;

/**
 * `request` sent on to the same path and query on ORIGIN, or to `path` there: 301 for a GET or a
 * HEAD, which search engines read as a move, and 308 for anything else, which keeps a POST a POST.
 */
export const movedToOrigin = (request: Request, path?: string): Response => {
  const { pathname, search } = new URL(request.url);
  const read = request.method === "GET" || request.method === "HEAD";

  return new Response(null, {
    status: read ? 301 : 308,
    headers: { location: `${WEBSITE_URL}${path ?? pathname}${search}` },
  });
};

export type LimitName =
  | "SITE_REQUESTS"
  | "CALLER_CALLS"
  | "CALLER_CRAWLS"
  | "PLATFORM_CALLS"
  | "PLATFORM_CRAWLS"
  | "RENDER_CALLS"
  | "LAB_CALLS";

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

/** Whose limit a caller is under: its own, or its platform's, which all its users share. */
const scopeOf = (caller: Caller): "caller" | "platform" =>
  caller.platform ? "platform" : "caller";

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

const paidDailyRefusal = (limit: number): string =>
  `The premium server has sent its ${limit.toLocaleString("en")} requests for subscribers today, its daily limit for all accounts together. Audits that request a site wait until 00:00 UTC; audits of inline HTML and seo_list_rules still work. ${NO_LIMITS}`;

const renderCallsRefusal = (): string => {
  const { limit, period } = rateLimit("RENDER_CALLS");

  return `This account has asked for ${limit} renders on the premium server in the last ${period}, its limit per account. ${tryAgain(period)} ${NO_LIMITS}`;
};

const labCallsRefusal = (): string => {
  const { limit, period } = rateLimit("LAB_CALLS");

  return `This account has asked for ${limit} lab runs on the premium server in the last ${period}, its limit per account. ${tryAgain(period)} ${NO_LIMITS}`;
};

const dailyRendersRefusal = (limit: number): string =>
  `The premium server has rendered its ${limit.toLocaleString("en")} pages for today, its daily limit for all accounts together. Rendering waits until 00:00 UTC; audits without \`render\` still work. ${NO_LIMITS}`;

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

/**
 * The day's counts that the HostedState Durable Object keeps: requests, subscribers' requests and
 * rendered pages (issue #230), and each caller's sites.
 */
export interface DayCounter {
  requests: (day: string) => Promise<number>;
  addRequests: (day: string, count: number) => Promise<number>;
  paidRequests: (day: string) => Promise<number>;
  addPaidRequests: (day: string, count: number) => Promise<number>;
  renders: (day: string) => Promise<number>;
  addRenders: (day: string, count: number) => Promise<number>;
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
export interface LimitsEnv extends StateEnv<DayCounter>, CruxEnv, PsiEnv {
  MODE: string;
  DAILY_REQUESTS: number;
  /** Requests a day for paid calls, all accounts together (issue #230), apart from DAILY_REQUESTS. */
  PAID_DAILY_REQUESTS: number;
  /**
   * Pages the premium server may render a day, all accounts together (issue #230). The website's
   * Worker renders nothing and has none.
   */
  DAILY_RENDERS?: number;
  /** Different sites one IP address may audit a day. */
  CALLER_SITES: number;
  /** Different sites claude.ai's users, or ChatGPT's, may audit a day, all together. */
  PLATFORM_SITES: number;
  SITE_REQUESTS: RateLimit;
  CALLER_CALLS: RateLimit;
  CALLER_CRAWLS: RateLimit;
  PLATFORM_CALLS: RateLimit;
  PLATFORM_CRAWLS: RateLimit;
  /** Reports one address may share a minute: uploads to the website, and seo_share_report. */
  SHARE_UPLOADS: RateLimit;
  /** Pages one account may render a minute on the premium server (issue #230). */
  RENDER_CALLS: RateLimit;
  /** Calls with `lighthouse` one account may make a minute on the premium server (issue #222). */
  LAB_CALLS: RateLimit;
  CALLS: AnalyticsEngineDataset;
  /**
   * The Ed25519 keys that sign every request (Web Bot Auth, issue #41), a Worker secret: a JSON
   * list of private JWKs, the first signing. Without it the requests go out unsigned.
   */
  WEB_BOT_AUTH_KEYS?: string;
}

/** The day's requests: the free ones, or those of paid calls (issue #230). */
type Budget = "free" | "paid";

/**
 * The day's count as this isolate last read it, by budget and Durable Object binding: the object is
 * asked at most every 30 seconds, since the daily limit is a circuit breaker, not an exact count.
 */
const todayCache: Record<
  Budget,
  WeakMap<LimitsEnv["STATE"], { day: string; count: number; readAt: number }>
> = { free: new WeakMap(), paid: new WeakMap() };

const requestsToday = async (
  env: LimitsEnv,
  budget: Budget = "free"
): Promise<number> => {
  const day = today();
  const cache = todayCache[budget];
  const cached = cache.get(env.STATE);

  if (cached?.day === day && Date.now() - cached.readAt < 30_000) {
    return cached.count;
  }

  const state = globalState(env);

  const count = await (budget === "paid"
    ? state.paidRequests(day)
    : state.requests(day));

  cache.set(env.STATE, { day, count, readAt: Date.now() });

  return count;
};

const countRequests = async (
  env: LimitsEnv,
  requests: number,
  budget: Budget = "free"
): Promise<void> => {
  const day = today();
  const state = globalState(env);

  const count = await (budget === "paid"
    ? state.addPaidRequests(day, requests)
    : state.addRequests(day, requests));

  todayCache[budget].set(env.STATE, { day, count, readAt: Date.now() });
};

const sitesLimit = (env: LimitsEnv, caller: Caller): number =>
  caller.platform ? env.PLATFORM_SITES : env.CALLER_SITES;

/** The admissions an isolate keeps at most; the oldest goes first. */
export const ADMITTED_ENTRIES = 4096;

/**
 * The sites the object admitted for a caller today, as this isolate saw it answer (issue #204). An
 * admission holds until 00:00 UTC, so the isolate asks the object, in the EU, only about a site it
 * has not seen admitted; a refusal is never kept, since another site may still fit. Like the
 * object, it keeps no caller or site: each pair is hashed with a random key made for the day, which
 * goes with the day's entries.
 */
interface AdmittedSites {
  day: string;
  key: Buffer;
  /** The hashed pairs, oldest first: a Set keeps insertion order. */
  entries: Set<string>;
}

const admittedSites = new WeakMap<LimitsEnv["STATE"], AdmittedSites>();

const admittedToday = (env: LimitsEnv, day: string): AdmittedSites => {
  const cached = admittedSites.get(env.STATE);

  if (cached?.day === day) {
    return cached;
  }

  const fresh = { day, key: randomBytes(32), entries: new Set<string>() };
  admittedSites.set(env.STATE, fresh);

  return fresh;
};

const admissionId = (
  admitted: AdmittedSites,
  caller: string,
  site: string
): string =>
  createHmac("sha256", admitted.key)
    .update(`${caller}\n${site}`)
    .digest("base64url");

/** Whether `caller` may audit the site of `host` today; a new site counts. */
const admitSite = async (
  env: LimitsEnv,
  caller: Caller,
  host: string
): Promise<boolean> => {
  const day = today();
  const site = siteOf(host);
  const admitted = admittedToday(env, day);
  const id = admissionId(admitted, caller.key, site);

  if (admitted.entries.delete(id)) {
    admitted.entries.add(id);

    return true;
  }

  const allowed = await globalState(env).admitSite(
    day,
    caller.key,
    site,
    sitesLimit(env, caller)
  );

  // The day may have turned while the object answered: keep it only for the day it was asked for.
  if (allowed && admittedSites.get(env.STATE) === admitted) {
    admitted.entries.add(id);

    if (admitted.entries.size > ADMITTED_ENTRIES) {
      const [oldest = ""] = admitted.entries;
      admitted.entries.delete(oldest);
    }
  }

  return allowed;
};

/** Throws the refusal of a call, or a crawl, that MODE keeps out. */
const checkMode = (env: LimitsEnv, crawl: boolean): void => {
  if (env.MODE === "closed") {
    throw new CallLimitError(
      `The hosted server is paused. ${NO_LIMITS}`,
      "paused"
    );
  }

  if (crawl && env.MODE === "no-crawls") {
    throw new CallLimitError(
      `The hosted server does not crawl sites at the moment; audits of single pages still work. ${NO_LIMITS}`,
      "no_crawls"
    );
  }
};

/** Throws the refusal of a call that requests sites once the day's requests are sent. */
const checkDay = async (
  env: LimitsEnv,
  budget: Budget = "free"
): Promise<void> => {
  if (budget === "paid") {
    if ((await requestsToday(env, "paid")) >= env.PAID_DAILY_REQUESTS) {
      throw new CallLimitError(
        paidDailyRefusal(env.PAID_DAILY_REQUESTS),
        "paid_daily_requests"
      );
    }

    return;
  }

  if ((await requestsToday(env)) >= env.DAILY_REQUESTS) {
    throw new CallLimitError(
      dailyRefusal(env.DAILY_REQUESTS),
      "daily_requests"
    );
  }
};

/**
 * Throws the refusal of a render past the account's renders a minute or the day's renders. The
 * day's count is asked each time, not cached: a render is rare, and the cap guards a bill.
 */
const checkRender = async (env: LimitsEnv, caller: Caller): Promise<void> => {
  const allowed = await env.RENDER_CALLS.limit({ key: caller.key });

  if (!allowed.success) {
    throw new CallLimitError(renderCallsRefusal(), "render_calls");
  }

  const limit = env.DAILY_RENDERS ?? 0;

  if ((await globalState(env).renders(today())) >= limit) {
    throw new CallLimitError(dailyRendersRefusal(limit), "daily_renders");
  }
};

/** Throws the refusal of a tool call that the mode or a limit keeps out. */
const admit = async (
  env: LimitsEnv,
  caller: Caller,
  call: HostedCallInfo,
  budget: Budget
): Promise<void> => {
  checkMode(env, call.crawl);

  if (call.tool === "seo_list_rules") {
    return;
  }

  const calls = caller.platform ? env.PLATFORM_CALLS : env.CALLER_CALLS;
  const callAllowed = await calls.limit({ key: caller.key });

  const scope = scopeOf(caller);

  if (!callAllowed.success) {
    throw new CallLimitError(callsRefusal(caller, false), `${scope}_calls`);
  }

  if (call.crawl) {
    const crawls = caller.platform ? env.PLATFORM_CRAWLS : env.CALLER_CRAWLS;
    const crawlAllowed = await crawls.limit({ key: caller.key });

    if (!crawlAllowed.success) {
      throw new CallLimitError(callsRefusal(caller, true), `${scope}_crawls`);
    }
  }

  // An address shares as many reports a minute on the server as it may upload to the website;
  // claude.ai and ChatGPT, one caller each for all their users, are held by their calls a minute.
  if (call.shares && !caller.platform) {
    const shareAllowed = await env.SHARE_UPLOADS.limit({ key: caller.key });

    if (!shareAllowed.success) {
      throw new CallLimitError(SHARE_LIMIT_MESSAGE, "caller_shares");
    }
  }

  if (call.render) {
    await checkRender(env, caller);
  }

  // Each run is a PageSpeed Insights query, from a quota RIVI's key shares among all accounts.
  if (call.lab) {
    const labAllowed = await env.LAB_CALLS.limit({ key: caller.key });

    if (!labAllowed.success) {
      throw new CallLimitError(labCallsRefusal(), "lab_calls");
    }
  }

  if (call.fetches) {
    await checkDay(env, budget);
  }

  // Last, so that a call another limit refuses uses up no site.
  if (call.fetches && call.host && !(await admitSite(env, caller, call.host))) {
    throw new CallLimitError(
      sitesRefusal(caller, sitesLimit(env, caller)),
      `${scope}_sites`
    );
  }

  // Once every limit let the call through, so a refused call uses up no render.
  if (call.render) {
    await globalState(env).addRenders(today(), 1);
  }
};

/**
 * How a call ended, for its record: a limit kept it out ("limited"), or `HostedCallEnd.outcome`. A
 * call the limits could not judge, as when the Durable Object fails, is an "error" (issue #93).
 */
export type Outcome = HostedCallEnd["outcome"] | "limited";

/** The outcome of a call `error` ended: a limit's, a site's refusal, or any other error. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
export const outcomeOf = (error: unknown): Outcome => {
  if (error instanceof CallLimitError) {
    return "limited";
  }

  return error instanceof RequestRefusedError ? "refused" : "error";
};

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
 * Why a record names a hostname other than the one its call audits, a comparison's competitor's
 * site or where a page redirected, or that it is no call's but a background crawl's end (issue
 * #209), which the Workflow writes after the call that started it has ended.
 */
type HostRole = "competitor" | "redirect" | "background";

/**
 * One record per tool call in Analytics Engine, which keeps it for three months: the tool, the
 * outcome, the duration, the requests sent and pages audited, and the target hostname, so that an
 * abuse report about a site can be checked against what was sent to it. A call that audits pages
 * rather than a site adds one record for each other hostname it sent requests to, with the requests
 * that hostname got (issue #129): `competitor` for a comparison's competitor's site, `redirect` for
 * where a page led. Never a path, a query, the caller's address or anything the caller sent. A
 * record that cannot be written is logged and reported, and never fails the call it is about.
 */
const record = (
  env: LimitsEnv,
  call: HostedCallInfo,
  outcome: Outcome,
  numbers: { durationMs: number; requests: number; pages: number },
  report: ReportTask | undefined,
  role?: HostRole
): void => {
  try {
    env.CALLS.writeDataPoint({
      indexes: [(call.host ?? call.tool).slice(0, MAX_INDEX_BYTES)],
      blobs: [call.tool, outcome, call.host ?? "", ...(role ? [role] : [])],
      doubles: [numbers.durationMs, numbers.requests, numbers.pages],
    });
  } catch (error) {
    console.error(
      `Could not record a ${call.tool} call: ${error instanceof Error ? error.message : String(error)}`
    );
    report?.(error, "call_record");
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
  /** The requests by hostname, for the records of the other hostnames a call reached. */
  byHost: Map<string, number>;
}

/**
 * Adds what `sent` has not counted yet to the day's count, after the answer. A count that fails is
 * logged and reported (issue #93): the daily limit then counts fewer requests than went out.
 */
const countSent = (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  sent: Sent,
  report: ReportTask | undefined,
  budget: Budget = "free"
): void => {
  const uncounted = sent.requests - sent.counted;

  if (uncounted > 0) {
    sent.counted = sent.requests;

    const count = async (): Promise<void> => {
      try {
        await countRequests(env, uncounted, budget);
      } catch (error) {
        console.error(
          `Could not count ${uncounted} requests: ${error instanceof Error ? error.message : String(error)}`
        );
        report?.(error, "request_count");
      }
    };

    ctx.waitUntil(count());
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

/** The sites a call that audits one page may reach, and the competitors' among them (issue #129). */
interface Reaches {
  caller: Caller;
  site: (hostname: string) => Promise<boolean>;
  /** The sites of a comparison's competitors, which are no redirect of the page's. */
  competitors: ReadonlySet<string>;
}

/** What one gate of a call holds its requests to, besides each site's requests a minute. */
interface GateRules {
  /** The sites a page audit may reach, each a site of the day. */
  reaches?: Reaches;
  /** The day's budget the requests count against. */
  budget?: Budget;
  /**
   * Whether the requests count by hostname, for a record of each other hostname the call reached.
   * A render's subresources do not: a font's host is no site the call audited.
   */
  byHost?: boolean;
}

/**
 * The gate of one call: the sites a page audit may reach (`reaches`), the limit per site, and a
 * count of the requests it lets through.
 */
const siteGate = (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  sent: Sent,
  report: ReportTask | undefined,
  { reaches, budget = "free", byHost = true }: GateRules = {}
): RequestGate => ({
  beforeRequest: async (url) => {
    if (reaches && !(await reaches.site(url.hostname))) {
      const whose = reaches.competitors.has(siteOf(url.hostname))
        ? `${url.hostname} is a competitor's site, one more for today.`
        : `The page led to ${url.hostname}, another site than the one audited.`;

      return {
        scope: "host",
        reason: `${scopeOf(reaches.caller)}_sites`,
        message: `${whose} ${sitesRefusal(reaches.caller, sitesLimit(env, reaches.caller))}`,
      };
    }

    const allowed = await env.SITE_REQUESTS.limit({ key: url.hostname });

    if (!allowed.success) {
      return {
        scope: "host",
        reason: "site_requests",
        message: siteRefusal(url.hostname),
      };
    }

    sent.requests += 1;

    if (byHost) {
      sent.byHost.set(url.hostname, (sent.byHost.get(url.hostname) ?? 0) + 1);
    }

    if (sent.requests - sent.counted >= COUNT_BATCH) {
      countSent(env, ctx, sent, report, budget);
    }
  },
});

/** What `backgroundCrawl` gives one attempt of a background crawl. */
export interface BackgroundCrawlLimits {
  /** Throws a CallLimitError under MODE closed or no-crawls, or past the day's requests. */
  readmit: () => Promise<void>;
  gate: RequestGate;
  /**
   * Writes the crawl's record (tool seo_start_crawl, role "background") and counts what it sent:
   * "limited" for an attempt `readmit` refused, so the records show what MODE and the day's cap
   * stopped.
   */
  end: (outcome: Outcome, pages: number, durationMs: number) => void;
}

/**
 * The limits of one attempt of a background crawl (issue #209), which seo_start_crawl admitted: it
 * took the caller's crawl and the site of the day then, so an attempt, the first or a rerun after
 * a retry or a deploy, takes neither again. It does check MODE and the day's requests again before
 * it requests anything (`readmit`), so MODE stays a kill switch for a crawl that has not run yet.
 * Its gate holds it to the site's requests a minute and counts what it sends, as a crawl's does in
 * a call, and its end writes the crawl's record, under the tool that started it.
 */
export const backgroundCrawl = (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  host: string,
  report?: ReportTask,
  paid?: HostedProfile["paid"]
): BackgroundCrawlLimits => {
  const sent: Sent = { requests: 0, counted: 0, byHost: new Map() };
  // A subscriber's crawl counts against the subscribers' day, as its call did (issue #230).
  const budget: Budget = paid ? "paid" : "free";

  return {
    readmit: async () => {
      checkMode(env, true);
      await checkDay(env, budget);
    },
    gate: siteGate(env, ctx, sent, report, { budget }),
    end: (outcome, pages, durationMs) => {
      record(
        env,
        { tool: "seo_start_crawl", fetches: true, crawl: true, host },
        outcome,
        { durationMs, requests: sent.requests, pages },
        report,
        "background"
      );
      countSent(env, ctx, sent, report, budget);
    },
  };
};

/** Who hears what a profile's calls do, beside Analytics Engine. */
export interface ProfileListeners {
  /** Hears each call's record as it is written. */
  observe?: (record: CallRecord) => void;
  /**
   * Hears the errors of the work around the calls (issue #93): a day's count or a record that
   * failed, and signing keys that do not parse.
   */
  report?: ReportTask;
  /** How the call is paid for, on the premium host. */
  paid?: HostedProfile["paid"];
}

/** The hosted profile of one request to /mcp: its caller's limits, and the Worker's bindings. */
export const hostedProfile = (
  env: LimitsEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  caller: Caller,
  { observe, report, paid }: ProfileListeners = {}
): HostedProfile => {
  const keep = (
    call: HostedCallInfo,
    outcome: Outcome,
    numbers: { durationMs: number; requests: number; pages: number }
  ): void => {
    record(env, call, outcome, numbers, report);
    observe?.({
      tool: call.tool,
      outcome,
      requests: numbers.requests,
      pages: numbers.pages,
    });
  };

  // A paid call's requests count against the subscribers' day, not the free one (issue #230).
  const budget: Budget = paid ? "paid" : "free";

  const profile: HostedProfile = {
    userAgent: USER_AGENT,
    sign: requestSigner(
      env.WEB_BOT_AUTH_KEYS,
      BOT_ORIGIN,
      report && ((error) => report(error, "signing_keys"))
    ),
    fieldData: cruxOptions(env, WEBSITE_URL),
    startCall: async (call) => {
      const started = Date.now();

      try {
        await admit(env, caller, call, budget);
      } catch (error) {
        // A limit, or the limits' own failure, which is no limit (issue #93).
        keep(call, outcomeOf(error), {
          durationMs: Date.now() - started,
          requests: 0,
          pages: 0,
        });

        throw error;
      }

      const sent: Sent = { requests: 0, counted: 0, byHost: new Map() };
      const competitors = new Set((call.competitors ?? []).map(siteOf));

      return {
        gate: siteGate(env, ctx, sent, report, {
          reaches:
            call.host && !call.crawl
              ? {
                  caller,
                  site: pageSites(env, caller, call.host),
                  competitors,
                }
              : undefined,
          budget,
        }),
        // A render's scripts, stylesheets, fonts and images: requests of the call, which count, but
        // no site it audits, so none spends a site of the day or gets a record of its own.
        ...(call.render && {
          subresourceGate: siteGate(env, ctx, sent, report, {
            budget,
            byHost: false,
          }),
        }),
        end: ({ outcome, pages }) => {
          const durationMs = Date.now() - started;

          keep(call, outcome, { durationMs, requests: sent.requests, pages });

          // Each other hostname the call reached, so an abuse report about it finds what was sent
          // there: a comparison's competitors' sites, and where a page or a competitor redirected.
          // A crawl's other hostnames are link checks, which its own record counts.
          for (const [host, requests] of call.crawl ? [] : sent.byHost) {
            if (host !== call.host) {
              record(
                env,
                { ...call, host },
                outcome,
                { durationMs, requests, pages: 0 },
                report,
                competitors.has(siteOf(host)) ? "competitor" : "redirect"
              );
            }
          }

          countSent(env, ctx, sent, report, budget);
        },
      };
    },
  };

  if (paid !== undefined) {
    profile.paid = paid;
  }

  return profile;
};
