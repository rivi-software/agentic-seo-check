/**
 * The audit form's answer (POST /audit, issue #39): the SEO and AEO audits of one page, run as a
 * hosted tool call is, or of a whole site when the address is its homepage (issue #45), run as a
 * hosted crawl is. Cloudflare Turnstile checks that a person sent the form, the hosted limits
 * count the run for its address, and every request goes through the hosted gate. The answer is the
 * homepage with the report, or with the reason there is none. Nothing of it is stored.
 */
import { z } from "zod";

import { auditAeoUrl, auditSiteBoth } from "../../../src/core/aeo/audit.js";
import type { SiteAudits } from "../../../src/core/aeo/audit.js";
import { auditUrl } from "../../../src/core/audit.js";
import type { ProgressEvent } from "../../../src/core/audit.js";
import { RequestRefusedError } from "../../../src/core/fetch.js";
import type { FetchOptions } from "../../../src/core/fetch.js";
import {
  HOSTED_LIMITS,
  hostedFetch,
  hostedUrlProblem,
} from "../../../src/core/hosted.js";
import type {
  AeoAudit,
  PageAudit,
  SiteAudit,
} from "../../../src/core/types.js";
import type { HostedCall } from "../../../src/mcp.js";
import { reportError } from "../analytics.js";
import type { AnalyticsEnv } from "../analytics.js";
import { callerOf } from "../callers.js";
import { hostedProfile } from "../limits.js";
import type { LimitsEnv } from "../limits.js";
import type { FailureKind, HomeState } from "./home.js";
import { renderReport } from "./report.js";
import { shareMenu } from "./share-page.js";
import { shareResult, signShare } from "./share.js";
import type { ShareEnv } from "./share.js";
import {
  progressClose,
  progressLine,
  progressOpen,
  renderSiteReport,
} from "./site-report.js";

/** The Worker's bindings and variables the audit form uses, beside the limits' and sharing's. */
export interface SiteEnv extends LimitsEnv, ShareEnv, AnalyticsEnv {
  /** Turnstile's public site key (wrangler.site.jsonc); empty until the widget exists. */
  TURNSTILE_SITE_KEY: string;
  /** Turnstile's secret key, a Worker secret (`wrangler secret put TURNSTILE_SECRET_KEY`). */
  TURNSTILE_SECRET_KEY?: string;
}

/** The name the record of a run has where a tool call's has the tool. */
export const WEB_AUDIT = "web_audit_page";

/** The name the record of a crawl from the form has. */
export const WEB_CRAWL = "web_crawl_site";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** A form with one URL in it is small; a larger body is not the form. */
const MAX_FORM_BYTES = 16_384;

const MAX_URL_CHARS = 2048;

/** The form is on when Turnstile is set up and the server is not paused: it never runs unchecked. */
export const formOpen = (env: SiteEnv): boolean =>
  env.MODE !== "closed" &&
  Boolean(env.TURNSTILE_SITE_KEY) &&
  Boolean(env.TURNSTILE_SECRET_KEY);

/** The form crawls a site from its homepage, unless crawls are off (`MODE: "no-crawls"`). */
export const formCrawls = (env: SiteEnv): boolean =>
  formOpen(env) && env.MODE !== "no-crawls";

/**
 * An address with no path and no query is a site's homepage, the start of a crawl. Any other
 * address is one page: a person who enters a path asks about that page.
 */
export const isHomepage = (url: URL): boolean =>
  url.pathname === "/" && url.search === "";

/** The form's crawl: the caps and defaults of the hosted seo_crawl_site. */
const SITE_CRAWL = {
  maxPages: HOSTED_LIMITS.maxPages,
  maxDepth: HOSTED_LIMITS.maxDepth,
  concurrency: HOSTED_LIMITS.concurrency,
  maxLinkChecks: HOSTED_LIMITS.maxLinkChecks,
  maxSitemaps: HOSTED_LIMITS.maxSitemaps,
  maxSitemapBytes: HOSTED_LIMITS.maxSitemapBytes,
  respectRobots: true,
  pageDetail: "summary",
} as const;

const Siteverify = z.object({ success: z.boolean() });

/** Asks Turnstile whether `token` is one it gave this site's form, and has not been used. */
const personSent = async (
  env: SiteEnv,
  token: string,
  ip: string | null
): Promise<boolean> => {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY ?? "",
    response: token,
  });

  if (ip) {
    body.set("remoteip", ip);
  }

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    const answer = Siteverify.safeParse(await res.json());

    return res.ok && answer.success && answer.data.success;
  } catch {
    // Turnstile not answering is not a person passing the check.
    return false;
  }
};

/** What the form's answer shows, and the HTTP status it comes with. */
export interface AuditAnswer {
  status: number;
  state: Pick<HomeState, "url" | "error" | "failure" | "report" | "crawling">;
  /**
   * The rest of a crawl's answer, which comes in place of the report: `write` gets the progress so
   * far and each line as it comes, then the report or why there is none. Settles once all is
   * written. A crawl that gives up before its first page has none, but a refusal.
   */
  rest?: (write: (html: string) => void) => Promise<void>;
}

/** The kind of each refusal by its status, for the page's `audit_failed` event. */
const FAILURES = new Map<number, FailureKind>([
  [400, "address"],
  [403, "check"],
  [429, "limit"],
  [502, "fetch"],
  [503, "paused"],
]);

const refuse = (
  status: number,
  error: string,
  url?: string,
  failure: FailureKind = FAILURES.get(status) ?? "fetch"
): AuditAnswer => ({
  status,
  state: { url, error, failure },
});

/** The address as typed, with https:// before a bare hostname, or null when it is not a URL. */
const targetOf = (typed: string): URL | null => {
  const address = /^[a-z][a-z0-9+.-]*:\/\//iu.test(typed)
    ? typed
    : `https://${typed}`;

  return URL.canParse(address) ? new URL(address) : null;
};

/** The report's Share menu, or nothing when the site has no key to sign a share link with. */
const shareFor = async (
  env: ShareEnv,
  seo: PageAudit | SiteAudit,
  aeo: AeoAudit
): Promise<string> => {
  const link = await signShare(env, shareResult(seo, aeo));

  return link ? shareMenu(link) : "";
};

/** The two audits of the page `target`, as a report. */
const runAudits = async (
  target: URL,
  fetchOptions: FetchOptions,
  env: ShareEnv
): Promise<string> => {
  const [seo, aeo] = await Promise.all([
    auditUrl(target.href, { fetch: fetchOptions }),
    auditAeoUrl(target.href, { fetch: fetchOptions }),
  ]);

  return renderReport(
    seo,
    aeo,
    isHomepage(target),
    await shareFor(env, seo, aeo)
  );
};

/** A site's report, with its Share menu. */
const siteReport = async (audits: SiteAudits, env: ShareEnv): Promise<string> =>
  renderSiteReport(audits, await shareFor(env, audits.seo, audits.aeo));

/** Why a run gave no report, in the words the form shows. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
const failure = (what: string, target: URL, error: unknown): string =>
  error instanceof RequestRefusedError
    ? error.message
    : `The ${what} of ${target.hostname} failed: ${error instanceof Error ? error.message : String(error)}`;

/** The kind of a run that failed: the site refused a request it needed, or anything else. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until this reads it
const failureKind = (error: unknown): FailureKind =>
  error instanceof RequestRefusedError ? "refused" : "fetch";

/** How the form's crawl ended: both audits, or why there are none. */
type CrawlOutcome =
  | { audits: SiteAudits }
  | { error: string; kind: FailureKind };

/**
 * The crawl's progress as lines of HTML. Lines wait in `kept` until the answer pipes them to its
 * body; `firstPage` settles once the crawl has a page.
 */
const progressFeed = () => {
  const kept: string[] = [];
  let paged: (() => void) | undefined;

  // oxlint-disable-next-line promise/avoid-new -- the wait ends on a call the crawl's progress makes, which only a new Promise can await
  const firstPage = new Promise<void>((resolve) => {
    paged = resolve;
  });

  let send = (line: string): void => {
    kept.push(line);
  };

  return {
    firstPage,
    add: (event: ProgressEvent): void => {
      send(progressLine(event));

      if (event.phase === "crawl") {
        paged?.();
      }
    },
    /** Sends the lines kept so far to `write`, and each line after them as it comes. */
    pipe: (write: (html: string) => void): void => {
      for (const line of kept.splice(0)) {
        write(line);
      }

      send = write;
    },
  };
};

/**
 * Crawls the site from its homepage `target` and builds both audits from the one crawl. The answer
 * waits for the crawl's first page: a crawl the site refuses from the start gets a refusal with its
 * status, as a page audit does. Once a page is in, the answer streams, since a crawl takes tens of
 * seconds: the top of the page, a line for each step, then the report.
 */
const runCrawl = async (
  target: URL,
  typed: string,
  fetchOptions: FetchOptions,
  call: HostedCall,
  env: ShareEnv,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is unknown until exceptions.ts reads it
  reportFailure: (error: unknown) => void
): Promise<AuditAnswer> => {
  const feed = progressFeed();

  /** The crawl and both audits, and the record of the call once they are done. */
  const audit = async (): Promise<CrawlOutcome> => {
    try {
      const audits = await auditSiteBoth(target.href, {
        ...SITE_CRAWL,
        fetch: fetchOptions,
        onProgress: feed.add,
      });

      call.end?.({ outcome: "ok", pages: audits.seo.pages.length });

      return { audits };
    } catch (error) {
      call.end?.({
        outcome: error instanceof RequestRefusedError ? "refused" : "error",
        pages: 0,
      });
      reportFailure(error);

      return {
        error: failure("crawl", target, error),
        kind: failureKind(error),
      };
    }
  };

  const outcome = audit();
  const first = await Promise.race([feed.firstPage, outcome]);

  if (first && "error" in first) {
    return refuse(502, first.error, typed, first.kind);
  }

  // The crawl was done before it had a page to show: nothing to stream.
  if (first) {
    return {
      status: 200,
      state: { url: target.href, report: await siteReport(first.audits, env) },
    };
  }

  return {
    status: 200,
    state: { url: target.href, crawling: true },
    rest: async (write) => {
      write(progressOpen(target.href));
      feed.pipe(write);
      const done = await outcome;

      // The status is sent: a crawl that fails now says why in the page.
      write(
        "error" in done ? progressClose(done.error, done.kind) : progressClose()
      );

      if ("audits" in done) {
        write(await siteReport(done.audits, env));
      }
    },
  };
};

/** The field `name` of a form, when it is text. */
const field = (form: FormData, name: string): string => {
  const value = z.string().safeParse(form.get(name));

  return value.success ? value.data.trim() : "";
};

/**
 * Reads the form, or null for a body that is not one. A browser sends a form with its length; a
 * body without a length, or with one that is not a number, could be any size, and reading it
 * would buffer all of it before Turnstile or a limit has had a say.
 */
export const readForm = async (request: Request): Promise<FormData | null> => {
  const length = request.headers.get("content-length");

  if (
    length === null ||
    !/^\d+$/u.test(length) ||
    Number(length) > MAX_FORM_BYTES
  ) {
    return null;
  }

  try {
    return await request.formData();
  } catch {
    return null;
  }
};

/** Answers the audit form: checks it, runs the audits within the hosted limits, renders the report. */
export const answerAudit = async (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<AuditAnswer> => {
  // A browser names the page a form was sent from: only this site's own form is answered.
  const origin = request.headers.get("origin");

  if (origin && origin !== new URL(request.url).origin) {
    return refuse(403, "The audit form answers this site's own page only.");
  }

  const form = await readForm(request);

  if (!form) {
    return refuse(400, "That was not the audit form. Enter an address below.");
  }

  const typed = field(form, "url");

  if (!typed) {
    return refuse(
      400,
      "Enter the address of a page, such as https://example.com/pricing."
    );
  }

  const target =
    typed.length > MAX_URL_CHARS ? null : targetOf(typed.slice(0, 4096));

  if (!target) {
    return refuse(
      400,
      "That is not an address the audit can request. Enter one such as https://example.com/pricing.",
      typed.slice(0, MAX_URL_CHARS)
    );
  }

  const problem = hostedUrlProblem(target);

  if (problem) {
    return refuse(400, problem, typed);
  }

  if (!formOpen(env)) {
    return refuse(503, "The audit is switched off at the moment.", typed);
  }

  const ip = request.headers.get("cf-connecting-ip");

  if (!(await personSent(env, field(form, "cf-turnstile-response"), ip))) {
    return refuse(
      403,
      "The check that keeps bots out did not pass, or it ran out. Run the audit again.",
      typed
    );
  }

  const crawl = isHomepage(target) && formCrawls(env);

  const info = {
    tool: crawl ? WEB_CRAWL : WEB_AUDIT,
    fetches: true,
    crawl,
    host: target.hostname,
  };

  let call: HostedCall;
  // A browser is never claude.ai's or ChatGPT's connector, so no platform ranges apply.
  const profile = hostedProfile(env, ctx, callerOf(ip, []));

  try {
    call = await profile.startCall(info);
  } catch (error) {
    return refuse(
      429,
      error instanceof Error ? error.message : String(error),
      typed
    );
  }

  const fetchOptions = {
    ...hostedFetch({
      userAgent: profile.userAgent,
      sign: profile.sign,
      limits: call.gate,
      crawl,
    }),
    timeoutMs: HOSTED_LIMITS.timeoutMs,
  };

  if (crawl) {
    return runCrawl(target, typed, fetchOptions, call, env, (thrown) => {
      reportError(env, ctx, thrown, "website:/audit");
    });
  }

  try {
    const report = await runAudits(target, fetchOptions, env);

    call.end?.({ outcome: "ok", pages: 1 });

    return { status: 200, state: { url: target.href, report } };
  } catch (error) {
    call.end?.({
      outcome: error instanceof RequestRefusedError ? "refused" : "error",
      pages: 0,
    });
    reportError(env, ctx, error, "website:/audit");

    return refuse(
      502,
      failure("audit", target, error),
      typed,
      failureKind(error)
    );
  }
};
