/**
 * POST /api/share: where the CLI, the local MCP server and the library upload the two audits of a
 * page or a site to share them (src/core/share.ts). The upload is anyone's JSON, so it is capped,
 * limited per IP address, checked against the schema (shared-schema.ts), and rendered once before
 * it is kept: what cannot be shown is refused now, not when someone opens the link. The answer is
 * JSON: the secret link and when it expires, or `error` in words the CLI prints as they are.
 */
import { PRODUCT_NAME } from "../../../src/brand.js";
import {
  MAX_SHARE_BYTES,
  SHARE_LIMIT_MESSAGE,
} from "../../../src/core/share.js";
import type { ShareLink } from "../../../src/core/share.js";
import { callerOf } from "../callers.js";
import { keepReport } from "../shared-reports.js";
import type { SharedReportsEnv } from "../shared-reports.js";
import { SharedReportSchema } from "../shared-schema.js";
import { sharedReportHtml } from "./shared-page.js";

export interface ShareApiEnv extends SharedReportsEnv {
  /** Uploads one IP address may make a minute. */
  SHARE_UPLOADS: RateLimit;
}

const answer = (
  status: number,
  body: ShareLink | { error: string }
): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

const refuse = (status: number, error: string): Response =>
  answer(status, { error });

/** The body, or null once it is over `max` bytes: it stops reading there. */
const readCapped = async (
  body: ReadableStream<Uint8Array>,
  max: number
): Promise<string | null> => {
  const chunks: Uint8Array[] = [];
  let size = 0;

  // Leaving the loop early cancels the stream: the rest is never read.
  for await (const chunk of body) {
    size += chunk.byteLength;

    if (size > max) {
      return null;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf-8");
};

/** The first problem the schema found, as a path and its message: `seo.findings.3.severity: …`. */
const problemOf = (error: {
  issues: { path: PropertyKey[]; message: string }[];
}): string => {
  const [first] = error.issues;

  return first
    ? `${first.path.map(String).join(".") || "the upload"}: ${first.message}`
    : "not a report";
};

const TOO_LARGE = `A shared report may be ${MAX_SHARE_BYTES / 1_000_000} MB at most: crawl fewer pages.`;

export const shareUpload = async (
  request: Request,
  env: ShareApiEnv
): Promise<Response> => {
  if (!env.SHARED_REPORTS) {
    return refuse(503, "Sharing is switched off on this website.");
  }

  // Keyed as the MCP server keys its callers, so an address shares one budget on both Workers.
  const { key } = callerOf(request.headers.get("cf-connecting-ip"), []);
  const { success } = await env.SHARE_UPLOADS.limit({ key });

  if (!success) {
    return refuse(429, SHARE_LIMIT_MESSAGE);
  }

  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return refuse(415, "Send the report as application/json.");
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_SHARE_BYTES) {
    return refuse(413, TOO_LARGE);
  }

  const text = request.body
    ? await readCapped(request.body, MAX_SHARE_BYTES)
    : "";

  if (text === null) {
    return refuse(413, TOO_LARGE);
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return refuse(400, "The upload is not JSON.");
  }

  const parsed = SharedReportSchema.safeParse(json);

  if (!parsed.success) {
    return refuse(
      400,
      `The upload is not an audit this website can show (${problemOf(parsed.error)}). Share with the same version of ${PRODUCT_NAME} as the website, or a newer one.`
    );
  }

  try {
    sharedReportHtml(parsed.data);
  } catch {
    return refuse(400, "The upload is not an audit this website can show.");
  }

  return answer(
    201,
    await keepReport(env.SHARED_REPORTS, parsed.data, "upload")
  );
};
