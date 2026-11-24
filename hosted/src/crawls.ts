import { z } from "zod";

/**
 * Background crawls (issue #209): what seo_start_crawl starts and the Workflow runs, kept in the R2
 * bucket SHARED_REPORTS (EU jurisdiction) under crawls/<id>, beside the shared reports, for
 * CRAWL_DAYS. The start writes the crawl running, with the options the Workflow reads; its end
 * overwrites it with the two audits, or how it failed, and drops the options. The bucket's
 * lifecycle rule on crawls/ deletes a crawl after CRAWL_DAYS; until it does, a crawl past its days
 * reads as gone. Anyone with the id can read the crawl, as anyone with a shared report's link can
 * read the report, so the id is never logged or sent to the analytics.
 */
import type { AeoAudit, SiteAudit } from "../../src/core/types.js";
import type {
  BackgroundCrawlOptions,
  CrawlFailure,
  CrawlState,
} from "../../src/mcp-hosted.js";
import { DAY_MS, newId, REPORT_ID } from "./shared-reports.js";
import type { ReportBucket } from "./shared-reports.js";

/** How many days a crawl is kept: the bucket's lifecycle rule on crawls/ says the same. */
export const CRAWL_DAYS = 7;

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
  failure: z.object({ message: z.string(), refused: z.boolean() }).optional(),
});

type StoredCrawl = z.infer<typeof StoredCrawlSchema>;

/** The crawl's times, which the start writes and the end keeps. */
interface CrawlTimes {
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
 * The crawl kept under `id` with its expiry, or null when the id is malformed, there is none, it
 * has expired or it no longer reads as a crawl. A malformed id never reaches the bucket, so no id
 * names another key.
 */
const readStored = async (
  bucket: ReportBucket,
  id: string,
  now: Date
): Promise<StoredCrawl | null> => {
  if (!CRAWL_ID.test(id)) {
    return null;
  }

  const object = await bucket.get(keyOf(id));

  if (!object) {
    return null;
  }

  const { expiresAt } = object.customMetadata ?? {};

  if (!expiresAt || Date.parse(expiresAt) <= now.getTime()) {
    await object.body.cancel();

    return null;
  }

  try {
    const parsed = StoredCrawlSchema.safeParse(JSON.parse(await object.text()));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
  const expiresAt = new Date(now.getTime() + CRAWL_DAYS * DAY_MS).toISOString();

  await write(
    bucket,
    id,
    { status: "running", startedAt, options },
    { startedAt, expiresAt }
  );

  return startedAt;
};

/** The options a running crawl was started with, or null when there is no such crawl running. */
export const crawlOptions = async (
  bucket: ReportBucket,
  id: string
): Promise<BackgroundCrawlOptions | null> => {
  const stored = await readStored(bucket, id, new Date());

  return stored?.status === "running" && stored.options ? stored.options : null;
};

/**
 * Writes the end of a crawl, its two audits or how it failed, over its start: the options go, and
 * the start's times stay, so the crawl expires when the start said. A crawl whose start is no
 * longer in the bucket is kept from now on, since its result is worth more than its age.
 */
export const endCrawl = async (
  bucket: ReportBucket,
  id: string,
  end: { seo: SiteAudit; aeo: AeoAudit } | { failure: CrawlFailure },
  now = new Date()
): Promise<void> => {
  const start = await bucket.get(keyOf(id));
  const { startedAt, expiresAt } = start?.customMetadata ?? {};

  await start?.body.cancel();

  const times: CrawlTimes =
    startedAt && expiresAt
      ? { startedAt, expiresAt }
      : {
          startedAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + CRAWL_DAYS * DAY_MS
          ).toISOString(),
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

  return stored ? stateOf(stored) : null;
};
