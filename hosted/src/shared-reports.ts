/**
 * Shared reports: the two audits of a page or a site, kept in the R2 bucket SHARED_REPORTS (EU
 * jurisdiction) under a random id for SHARE_DAYS, and shown at /report/<id> to anyone who has the
 * link. The website keeps what the CLI, the local MCP server and the library upload (site/share-api.ts),
 * and the MCP server what its own seo_share_report audited. The bucket's lifecycle rule deletes a
 * report after SHARE_DAYS; until it does, a report past its day reads as gone.
 */
import type { z } from "zod";

import { SHARE_DAYS } from "../../src/core/share.js";
import type { ShareLink, SharedReport } from "../../src/core/share.js";
import { ORIGIN } from "./limits.js";
import { SharedReportSchema } from "./shared-schema.js";
import type { CheckedReport } from "./shared-schema.js";

/** What the store uses of an R2 bucket, which a test can keep in memory. */
export interface ReportBucket {
  put: (
    key: string,
    value: string,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    }
  ) => Promise<object | null>;
  get: (key: string) => Promise<{
    customMetadata?: Record<string, string>;
    body: ReadableStream;
    text: () => Promise<string>;
  } | null>;
}

export interface SharedReportsEnv {
  /** Where shared reports are kept; without it, sharing is off. */
  SHARED_REPORTS?: R2Bucket;
}

/**
 * Who made the report: someone's own run of the tool, uploaded, or the hosted MCP server, which
 * requested the pages itself.
 */
export type ReportSource = "upload" | "hosted";

/** A shared report as the page shows it. */
export interface StoredReport {
  id: string;
  report: CheckedReport;
  source: ReportSource;
  sharedAt: string;
  expiresAt: string;
}

/** The id's bytes: 128 random bits, which nobody guesses. */
const ID_BYTES = 16;

/** An id as /report/<id> has it: 22 characters of base64url. */
export const REPORT_ID = /^[\w-]{22}$/u;

const DAY_MS = 86_400_000;

/** When something kept `now` for `days` days expires, as its metadata has it. */
export const expiryAfter = (days: number, now: Date): string =>
  new Date(now.getTime() + days * DAY_MS).toISOString();

/** A new id of ID_BYTES random bytes, in base64url as REPORT_ID reads it. */
export const newId = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(ID_BYTES))).toString(
    "base64url"
  );

/** The path of a shared report's page. */
export const reportPath = (id: string): string => `/report/${id}`;

const keyOf = (id: string): string => `reports/${id}`;

/** Keeps `report` for SHARE_DAYS and answers with its secret link. */
export const keepReport = async (
  bucket: ReportBucket,
  report: SharedReport | CheckedReport,
  source: ReportSource,
  now = new Date()
): Promise<ShareLink> => {
  const id = newId();

  const expiresAt = expiryAfter(SHARE_DAYS, now);

  await bucket.put(keyOf(id), JSON.stringify(report), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source,
      kind: report.kind,
      sharedAt: now.toISOString(),
      expiresAt,
    },
  });

  return { url: `${ORIGIN}${reportPath(id)}`, expiresAt };
};

/** What `readKept` found: the value, checked, the metadata the reader took, and the expiry. */
export interface Kept<T, M> {
  value: T;
  metadata: M;
  expiresAt: string;
}

/**
 * The object kept under `key(id)`, its JSON checked against `schema`, or null when the id is
 * malformed, there is none, `metadata` reads its metadata as null, it has expired, or it does not
 * parse. A malformed id never reaches the bucket, so no id names another key. Shared reports and
 * background crawls read their objects through it.
 */
export const readKept = async <T, M>(
  bucket: ReportBucket,
  id: string,
  {
    key,
    schema,
    metadata: readMetadata,
    now,
  }: {
    key: (id: string) => string;
    schema: z.ZodType<T>;
    metadata: (metadata: Record<string, string>) => M | null;
    now: Date;
  }
): Promise<Kept<T, M> | null> => {
  if (!REPORT_ID.test(id)) {
    return null;
  }

  const object = await bucket.get(key(id));

  if (!object) {
    return null;
  }

  const kept = object.customMetadata ?? {};
  const { expiresAt } = kept;
  const metadata = readMetadata(kept);

  if (
    !expiresAt ||
    metadata === null ||
    Date.parse(expiresAt) <= now.getTime()
  ) {
    await object.body.cancel();

    return null;
  }

  try {
    const parsed = schema.safeParse(JSON.parse(await object.text()));

    return parsed.success ? { value: parsed.data, metadata, expiresAt } : null;
  } catch {
    return null;
  }
};

/** Who shared a report and when, from its metadata, or null when it lacks either. */
const reportMetadata = ({
  source,
  sharedAt,
}: Record<string, string>): { source: ReportSource; sharedAt: string } | null =>
  sharedAt && (source === "upload" || source === "hosted")
    ? { source, sharedAt }
    : null;

/**
 * The report kept under `id`, checked against the schema again, or null when there is none, it has
 * expired, or it no longer reads as a report.
 */
export const readReport = async (
  bucket: ReportBucket,
  id: string,
  now = new Date()
): Promise<StoredReport | null> => {
  const kept = await readKept(bucket, id, {
    key: keyOf,
    schema: SharedReportSchema,
    metadata: reportMetadata,
    now,
  });

  return kept
    ? { id, report: kept.value, ...kept.metadata, expiresAt: kept.expiresAt }
    : null;
};
