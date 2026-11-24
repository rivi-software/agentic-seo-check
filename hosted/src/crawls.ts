/**
 * Background crawls (issue #209): what seo_start_crawl starts and the Workflow runs, kept in the R2
 * bucket SHARED_REPORTS (EU jurisdiction) under crawls/<id>, beside the shared reports, for
 * CRAWL_DAYS. The start writes the crawl running, with the options the Workflow reads; its end
 * overwrites it with the two audits, or how it failed, and drops the options. The bucket's
 * lifecycle rule on crawls/ deletes a crawl after CRAWL_DAYS; until it does, a crawl past its days
 * reads as gone. Anyone with the id can read the crawl, as anyone with a shared report's link can
 * read the report, so the id is never logged or sent to the analytics.
 */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";

import { WEBSITE_URL } from "../../src/brand.js";
import { ExpectedError } from "../../src/core/errors.js";
import type { RequestGate } from "../../src/core/fetch.js";
import { CRAWL_DAYS, hostedFetch } from "../../src/core/hosted.js";
import type { AeoAudit, SiteAudit } from "../../src/core/types.js";
import { crawlFailure, runBackgroundCrawl } from "../../src/mcp-hosted.js";
import type {
  BackgroundCrawlOptions,
  BackgroundCrawls,
  CrawlFailure,
  CrawlState,
} from "../../src/mcp-hosted.js";
import { inRequest, reportError, reportTask } from "./analytics.js";
import type { AnalyticsEnv, ErrorRoute, ReportTask } from "./analytics.js";
import { cruxOptions } from "./crux.js";
import {
  backgroundCrawl,
  BOT_ORIGIN,
  outcomeOf,
  USER_AGENT,
} from "./limits.js";
import type { LimitsEnv, Outcome } from "./limits.js";
import { expiryAfter, newId, readKept, REPORT_ID } from "./shared-reports.js";
import type { ReportBucket } from "./shared-reports.js";
import { requestSigner } from "./signing.js";

/** A crawl's id: 22 characters of base64url, made as a shared report's is. */
export const CRAWL_ID: RegExp = REPORT_ID;

/** A new crawl id, of 128 random bits, which nobody guesses. */
export const newCrawlId = (): string => newId();

const keyOf = (id: string): string => `crawls/${id}`;

/**
 * Whether a value is an object, as the audits and the options are. The Worker wrote them, so the
 * store checks no more of them than that: an object it cannot read is one it did not write.
 */
const OBJECT = z.looseObject({});

const kept = <T>() =>
  z.custom<T>((value) => OBJECT.safeParse(value).success).optional();

/** A crawl as the bucket keeps it: the options while it runs, then the audits or the failure. */
const StoredCrawlSchema = z.object({
  status: z.enum(["running", "done", "failed"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  options: kept<BackgroundCrawlOptions>(),
  seo: kept<SiteAudit>(),
  aeo: kept<AeoAudit>(),
  failure: z
    .object({
      message: z.string(),
      type: z.enum(["validation", "permission", "rate_limited", "internal"]),
    })
    .optional(),
});

type StoredCrawl = z.infer<typeof StoredCrawlSchema>;

/** The crawl's times, which the start writes and the end keeps. */
export interface CrawlTimes {
  startedAt: string;
  expiresAt: string;
}

const write = (
  bucket: ReportBucket,
  id: string,
  crawl: StoredCrawl,
  times: CrawlTimes
): Promise<object | null> =>
  bucket.put(keyOf(id), JSON.stringify(crawl), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { ...times },
  });

/**
 * The crawl kept under `id` and its times, or null when the id is malformed, there is none, it has
 * expired or it no longer reads as a crawl.
 */
const readStored = async (
  bucket: ReportBucket,
  id: string,
  now: Date
): Promise<{ crawl: StoredCrawl; times: CrawlTimes | undefined } | null> => {
  const stored = await readKept(bucket, id, {
    key: keyOf,
    schema: StoredCrawlSchema,
    metadata: ({ startedAt }) => ({ startedAt }),
    now,
  });

  if (!stored) {
    return null;
  }

  const { startedAt } = stored.metadata;

  return {
    crawl: stored.value,
    times: startedAt ? { startedAt, expiresAt: stored.expiresAt } : undefined,
  };
};

/** What `stored` says of where the crawl stands, or null when it lacks what its status needs. */
const stateOf = (stored: StoredCrawl): CrawlState | null => {
  const { status, startedAt, endedAt } = stored;

  if (status === "running") {
    return { status, startedAt };
  }

  if (endedAt === undefined) {
    return null;
  }

  if (status === "done" && stored.seo && stored.aeo) {
    return { status, startedAt, endedAt, seo: stored.seo, aeo: stored.aeo };
  }

  if (status === "failed" && stored.failure) {
    return { status, startedAt, endedAt, failure: stored.failure };
  }

  return null;
};

/**
 * Keeps a new crawl running under `id`, with the options the Workflow reads, for CRAWL_DAYS, and
 * answers when it started.
 */
export const keepCrawl = async (
  bucket: ReportBucket,
  id: string,
  options: BackgroundCrawlOptions,
  now = new Date()
): Promise<string> => {
  const startedAt = now.toISOString();
  const expiresAt = expiryAfter(CRAWL_DAYS, now);

  await write(
    bucket,
    id,
    { status: "running", startedAt, options },
    { startedAt, expiresAt }
  );

  return startedAt;
};

/**
 * The options a running crawl was started with, and its times, which its end keeps, or null when
 * there is no such crawl running.
 */
export const storedCrawlOptions = async (
  bucket: ReportBucket,
  id: string
): Promise<{
  options: BackgroundCrawlOptions;
  times: CrawlTimes | undefined;
} | null> => {
  const stored = await readStored(bucket, id, new Date());

  return stored?.crawl.status === "running" && stored.crawl.options
    ? { options: stored.crawl.options, times: stored.times }
    : null;
};

/** The times the start of the crawl under `id` wrote, read from the bucket, or undefined. */
const startTimes = async (
  bucket: ReportBucket,
  id: string
): Promise<CrawlTimes | undefined> => {
  const start = await bucket.get(keyOf(id));
  const { startedAt, expiresAt } = start?.customMetadata ?? {};

  await start?.body.cancel();

  return startedAt && expiresAt ? { startedAt, expiresAt } : undefined;
};

/**
 * Writes the end of a crawl, its two audits or how it failed, over its start: the options go, and
 * the start's times stay, so the crawl expires when the start said. `startedWith` is those times
 * when the caller read them already; without them, the end reads them. A crawl whose start is no
 * longer in the bucket is kept from now on, since its result is worth more than its age.
 */
export const endCrawl = async (
  bucket: ReportBucket,
  id: string,
  end: { seo: SiteAudit; aeo: AeoAudit } | { failure: CrawlFailure },
  now = new Date(),
  startedWith?: CrawlTimes
): Promise<void> => {
  const times: CrawlTimes = startedWith ??
    (await startTimes(bucket, id)) ?? {
      startedAt: now.toISOString(),
      expiresAt: expiryAfter(CRAWL_DAYS, now),
    };

  const endedAt = now.toISOString();

  await write(
    bucket,
    id,
    "failure" in end
      ? {
          status: "failed",
          startedAt: times.startedAt,
          endedAt,
          failure: end.failure,
        }
      : {
          status: "done",
          startedAt: times.startedAt,
          endedAt,
          seo: end.seo,
          aeo: end.aeo,
        },
    times
  );
};

/** Where the crawl under `id` stands, or null for an unknown, malformed or expired id. */
export const readCrawl = async (
  bucket: ReportBucket,
  id: string,
  now = new Date()
): Promise<CrawlState | null> => {
  const stored = await readStored(bucket, id, now);

  return stored ? stateOf(stored.crawl) : null;
};

/** What a crawl's Workflow is given: the crawl's id, whose options wait in the bucket. */
interface CrawlParams {
  id: string;
}

/**
 * The port seo_start_crawl and seo_crawl_result use, or undefined without the bucket or the
 * Workflow, when both tools say background crawls are off. `report` hears a crawl's end that could
 * not be written.
 */
export const backgroundCrawls = (
  env: {
    SHARED_REPORTS?: ReportBucket;
    CRAWLS?: Pick<Workflow<CrawlParams>, "create">;
  },
  report?: ReportTask
): BackgroundCrawls | undefined => {
  const { SHARED_REPORTS: bucket, CRAWLS: workflow } = env;

  if (!bucket || !workflow) {
    return undefined;
  }

  return {
    start: async (options) => {
      const id = newCrawlId();
      // Kept first, so the Workflow finds its options however soon it runs.
      const startedAt = await keepCrawl(bucket, id, options);

      try {
        await workflow.create({ id, params: { id } });
      } catch (error) {
        // A crawl that never runs would read as running for CRAWL_DAYS: it ends now, and the call
        // answers the error, the Workflow's and not the bucket's.
        try {
          await endCrawl(bucket, id, { failure: crawlFailure(error) });
        } catch (error_) {
          report?.(error_, "crawl_end");
        }

        throw error;
      }

      return { id, startedAt };
    },
    read: (id) => readCrawl(bucket, id),
  };
};

/** Where a crawl's errors happened, as their events name it: never the crawl's id or site. */
const CRAWL_ROUTE: ErrorRoute = "server:crawl";

/**
 * One retry, half a minute later, for an error of the Worker's own (a site's refusal or a limit
 * ends the crawl at once); a crawl at the caps takes well under the timeout.
 */
const CRAWL_STEP = {
  retries: { limit: 1, delay: "30 seconds", backoff: "constant" },
  timeout: "10 minutes",
} as const;

/**
 * A `waitUntil` that keeps what it is handed, and `settle`, which waits for all of it, and for what
 * that adds in turn. Nothing says work a step hands to `waitUntil` outlives the step, so an
 * attempt waits for its own: the day's count, which the daily cap reads, and its errors' events.
 */
const heldWork = (ctx: Pick<ExecutionContext, "waitUntil">) => {
  const pending: Promise<unknown>[] = [];

  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
        ctx.waitUntil(promise);
      },
    },
    settle: async (): Promise<void> => {
      while (pending.length > 0) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- what settles may hand over more
        await Promise.allSettled(pending.splice(0));
      }
    },
  };
};

/** What one attempt of a crawl reads: the limits', the analytics' and the store's bindings. */
export interface CrawlEnv extends LimitsEnv, AnalyticsEnv {
  SHARED_REPORTS: ReportBucket;
}

/**
 * One attempt of the background crawl `id` (issue #209), the Workflow's step: it runs the crawl as
 * seo_crawl_site runs one, with the server's User-Agent, signature and key, under the limits of
 * `backgroundCrawl`, writes its end to the bucket, and answers the number of pages it read, all
 * the step keeps. A site's refusal or a limit ends the crawl failed at once, as the hosted server
 * asks a site nothing again once it refused: when that end cannot be written either, the attempt
 * throws a NonRetryableError, so the Workflow writes it once and asks the site nothing more. So
 * does any error once a site answered a request with a refusal (a 403, a 429, a challenge), which
 * a crawl does not throw, or once the crawl is over, its end's write included: a retry would ask
 * the sites again. Any other error is reported and thrown, for the step's one retry. It resolves
 * once the work it handed to `waitUntil` is done. `run` runs the crawl; a test hands its own.
 */
export const crawlAttempt = (
  env: CrawlEnv,
  outer: Pick<ExecutionContext, "waitUntil">,
  id: string,
  run: typeof runBackgroundCrawl = runBackgroundCrawl
): Promise<{ pages: number }> => {
  const { ctx, settle } = heldWork(outer);
  const bucket = env.SHARED_REPORTS;
  const report = reportTask(env, ctx, CRAWL_ROUTE);

  const attempt = async (): Promise<{ pages: number }> => {
    const stored = await storedCrawlOptions(bucket, id);

    // The crawl ended or expired: there is nothing left to run.
    if (!stored) {
      return { pages: 0 };
    }

    const { options, times } = stored;

    const limits = backgroundCrawl(
      env,
      ctx,
      new URL(options.url).hostname,
      report
    );

    const started = Date.now();

    /**
     * Writes the crawl's end, then its record. An end that cannot be written is reported, and the
     * attempt throws `unkept` as a NonRetryableError, for the Workflow to write: never a retry.
     */
    const finish = async (
      end: Parameters<typeof endCrawl>[2],
      outcome: Outcome,
      pages: number,
      unkept: string
    ): Promise<{ pages: number }> => {
      try {
        await endCrawl(bucket, id, end, new Date(), times);
      } catch (error) {
        report(error, "crawl_end");
        limits.end(
          outcome === "ok" ? "error" : outcome,
          0,
          Date.now() - started
        );

        throw new NonRetryableError(unkept);
      }

      limits.end(outcome, pages, Date.now() - started);

      return { pages };
    };

    /** Whether a site refused a request of the crawl: then the attempt is never retried. */
    let refused = false;
    /** Whether the crawl ended, so only its end is left to write. */
    let crawled = false;

    const noted = <T>(refusal: T): T => {
      if (refusal) {
        refused = true;
      }

      return refusal;
    };

    /** The crawl's gate, which notes each refusal a site answered with, and the one that stopped it. */
    const noticing = (gate: RequestGate): RequestGate => ({
      ...gate,
      afterResponse:
        gate.afterResponse &&
        ((url, response) => noted(gate.afterResponse?.(url, response))),
      afterBody:
        gate.afterBody &&
        ((url, result) => noted(gate.afterBody?.(url, result))),
      crawlStopped: (refusal) => {
        refused = true;
        gate.crawlStopped?.(refusal);
      },
    });

    try {
      await limits.readmit();

      const fetch = hostedFetch({
        userAgent: USER_AGENT,
        sign: requestSigner(env.WEB_BOT_AUTH_KEYS, BOT_ORIGIN, (problem) =>
          report(problem, "signing_keys")
        ),
        limits: limits.gate,
        crawl: true,
      });

      const audits = await run(
        options,
        { ...fetch, gate: fetch.gate && noticing(fetch.gate) },
        cruxOptions(env, WEBSITE_URL)
      );

      // The crawl is over and has asked the sites all it will: from here on, no error retries.
      crawled = true;

      return await finish(
        audits,
        "ok",
        audits.seo.pages.length,
        "The hosted server could not keep the crawl's result."
      );
    } catch (error) {
      if (error instanceof NonRetryableError) {
        throw error;
      }

      if (!(error instanceof ExpectedError)) {
        // The attempt's record counts what it sent.
        limits.end("error", 0, Date.now() - started);

        // A site refused the crawl, or the crawl was over: a retry would ask that site again.
        if (refused || crawled) {
          void reportError(env, ctx, error, CRAWL_ROUTE);

          throw new NonRetryableError(
            error instanceof Error ? error.message : String(error)
          );
        }

        // The step tries once more.
        throw error;
      }

      // The site's answer, or the limit's: the crawl ends failed, never retried.
      return await finish(
        { failure: crawlFailure(error) },
        outcomeOf(error),
        0,
        error.message
      );
    }
  };

  return inRequest({ env, ctx, route: CRAWL_ROUTE }, async () => {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof NonRetryableError)) {
        void reportError(env, ctx, error, CRAWL_ROUTE);
      }

      throw error;
    } finally {
      await settle();
    }
  });
};

/**
 * Runs a background crawl (issue #209) in one step, `crawlAttempt`, which a Worker's error gets
 * one retry of. Once the step has failed for good, the crawl ends failed.
 */
export class CrawlWorkflow extends WorkflowEntrypoint<Env, CrawlParams> {
  override async run(
    event: WorkflowEvent<CrawlParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { id } = event.payload;
    // CRUX_API_KEY among them, a secret that `wrangler types` does not see.
    const env: CrawlEnv = this.env;

    try {
      await step.do("crawl", CRAWL_STEP, () => crawlAttempt(env, this.ctx, id));
    } catch (error) {
      // Each attempt reported its error as it threw it.
      await step.do("fail", () =>
        endCrawl(env.SHARED_REPORTS, id, { failure: crawlFailure(error) })
      );
    }
  }
}
