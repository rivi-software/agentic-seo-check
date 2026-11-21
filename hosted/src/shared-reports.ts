/**
 * Shared reports: the two audits of a page or a site, kept in the R2 bucket SHARED_REPORTS (EU
 * jurisdiction) under a random id for SHARE_DAYS, and shown at /report/<id> to anyone who has the
 * link. The website keeps what the CLI, the local MCP server and the library upload (site/share-api.ts),
 * and the MCP server what its own seo_share_report audited. The bucket's lifecycle rule deletes a
 * report after SHARE_DAYS; until it does, a report past its day reads as gone.
 */
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
  const id = Buffer.from(
    crypto.getRandomValues(new Uint8Array(ID_BYTES))
  ).toString("base64url");

  const expiresAt = new Date(now.getTime() + SHARE_DAYS * DAY_MS).toISOString();

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

/**
 * The report kept under `id`, checked against the schema again, or null when there is none, it has
 * expired, or it no longer reads as a report.
 */
export const readReport = async (
  bucket: ReportBucket,
  id: string,
  now = new Date()
): Promise<StoredReport | null> => {
  if (!REPORT_ID.test(id)) {
    return null;
  }

  const object = await bucket.get(keyOf(id));

  if (!object) {
    return null;
  }

  const { source, sharedAt, expiresAt } = object.customMetadata ?? {};

  if (
    !(sharedAt && expiresAt) ||
    (source !== "upload" && source !== "hosted") ||
    Date.parse(expiresAt) <= now.getTime()
  ) {
    await object.body.cancel();

    return null;
  }

  let parsed: ReturnType<typeof SharedReportSchema.safeParse>;

  try {
    parsed = SharedReportSchema.safeParse(JSON.parse(await object.text()));
  } catch {
    return null;
  }

  return parsed.success
    ? { id, report: parsed.data, source, sharedAt, expiresAt }
    : null;
};
