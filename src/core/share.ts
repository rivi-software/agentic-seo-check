/**
 * A shared report: the SEO and the AEO audit of a target, uploaded to the website, which keeps them
 * for SHARE_DAYS and answers with a secret link to the report. The CLI's `share`, the local MCP
 * server's seo_share_report and the library all upload through `shareAudits`; the hosted MCP server
 * keeps its own audits in the same place without the upload (hosted/src/shared-reports.ts).
 *
 * The website did not run an uploaded audit, so its report says so: the link is for showing a
 * report to someone, not for proving a score. Anyone with the link can read the report until it
 * expires, so it is as private as the link is.
 */
import { z } from "zod";

import { WEBSITE_URL } from "../brand.js";
import { auditAeoDirectory, auditAeoUrl, auditSiteBoth } from "./aeo/audit.js";
import { auditDirectory, auditUrl, resolveTarget } from "./audit.js";
import type { CrawlOptions } from "./audit.js";
import { ExpectedError } from "./errors.js";
import { DEFAULT_USER_AGENT } from "./fetch.js";
import type { AeoAudit, PageAudit, SiteAudit } from "./types.js";

/** Where an upload goes. */
export const SHARE_ENDPOINT = `${WEBSITE_URL}/api/share`;

/** How long the website keeps a shared report before it deletes it. */
export const SHARE_DAYS = 30;

/** The largest upload the website takes, in bytes of JSON. */
export const MAX_SHARE_BYTES = 5_000_000;

/** What a shared report holds: the two audits of one page, or of one site. */
export type SharedReport =
  | {
      schemaVersion: 1;
      kind: "page";
      seo: PageAudit;
      aeo: AeoAudit;
    }
  | {
      schemaVersion: 1;
      kind: "site";
      seo: SiteAudit;
      aeo: AeoAudit;
      /** The start page's own audits, when the crawl had one; null for a directory. */
      start: { seo: PageAudit; aeo: AeoAudit } | null;
    };

/** The secret link to a shared report, and when the website deletes it. */
export interface ShareLink {
  url: string;
  /** ISO 8601. */
  expiresAt: string;
}

/** An upload the website refused or could not take, with its reason in words. */
export class ShareError extends ExpectedError {
  override name = "ShareError";
}

export interface ShareOptions {
  /** Where to upload; SHARE_ENDPOINT unless a test or a self-hosted website says otherwise. */
  endpoint?: string;
  /** Default 30 seconds. */
  timeoutMs?: number;
}

/** The options `shareTarget` audits with: a crawl's, and `crawl` for a URL. */
export type ShareAuditOptions = CrawlOptions & { crawl?: boolean };

/**
 * An audit as it is uploaded: without its Lighthouse, rendering and baseline results, which the
 * website's report does not show and keeps out of what it stores.
 */
const shareable = (audit: PageAudit): PageAudit => {
  const {
    performance: _performance,
    rendering: _rendering,
    baseline: _baseline,
    ...rest
  } = audit;

  return rest;
};

/** A report as it is uploaded: each page audit trimmed by `shareable`. */
const trimmed = (report: SharedReport): SharedReport => {
  const { baseline: _aeoBaseline, ...aeo } = report.aeo;

  if (report.kind === "page") {
    return { ...report, seo: shareable(report.seo), aeo };
  }

  const { baseline: _seoBaseline, ...seo } = report.seo;

  return {
    ...report,
    seo: { ...seo, pages: seo.pages.map(shareable) },
    aeo,
    start: report.start
      ? { seo: shareable(report.start.seo), aeo: report.start.aeo }
      : null,
  };
};

/**
 * Both audits of `target`, as the website's report shows them: a URL's page, or with `crawl` its
 * site from one crawl, or a directory of built HTML. A single file or stdin has no URL to share.
 */
export const auditForShare = async (
  target: string,
  options: ShareAuditOptions = {}
): Promise<SharedReport> => {
  const resolved = await resolveTarget(target);

  if (resolved.kind === "url" && options.crawl) {
    const { seo, aeo, start } = await auditSiteBoth(resolved.url, options);

    return { schemaVersion: 1, kind: "site", seo, aeo, start };
  }

  if (resolved.kind === "url") {
    const [seo, aeo] = await Promise.all([
      auditUrl(resolved.url, options),
      auditAeoUrl(resolved.url, options),
    ]);

    return { schemaVersion: 1, kind: "page", seo, aeo };
  }

  if (resolved.kind === "directory") {
    const [seo, aeo] = await Promise.all([
      auditDirectory(resolved.path, options),
      auditAeoDirectory(resolved.path, options),
    ]);

    return { schemaVersion: 1, kind: "site", seo, aeo, start: null };
  }

  throw new ShareError(
    `Share a URL or a directory of built HTML: "${target}" is a single file or stdin, which has no address of its own.`,
    { reason: "target" }
  );
};

/** The website's answer to an upload it took. */
const ShareAnswer = z.object({ url: z.string().url(), expiresAt: z.string() });

/** The website's answer to an upload it refused. */
const ShareRefusal = z.object({ error: z.string() });

/** The website's reason for refusing an upload, from its JSON answer, or its status alone. */
const refusal = async (response: Response): Promise<string> => {
  const body = ShareRefusal.safeParse(await response.json().catch(() => null));

  return body.success
    ? body.data.error
    : `The website answered HTTP ${response.status}.`;
};

/**
 * Uploads both audits to the website and answers with the secret link to their report. Throws a
 * ShareError when the website refuses the upload (too large, too many, not an audit) or cannot be
 * reached.
 */
export const shareAudits = async (
  report: SharedReport,
  options: ShareOptions = {}
): Promise<ShareLink> => {
  const body = JSON.stringify(trimmed(report));
  const bytes = Buffer.byteLength(body, "utf-8");

  if (bytes > MAX_SHARE_BYTES) {
    throw new ShareError(
      `The report is ${Math.ceil(bytes / 1_000_000)} MB, over the ${MAX_SHARE_BYTES / 1_000_000} MB a shared report may be: crawl fewer pages (--max-pages).`,
      { reason: "too_large" }
    );
  }

  let response: Response;

  try {
    response = await fetch(options.endpoint ?? SHARE_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": DEFAULT_USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new ShareError(
      `Could not reach ${new URL(options.endpoint ?? SHARE_ENDPOINT).host} to share the report: ${error instanceof Error ? error.message : String(error)}`,
      { reason: "unreachable", cause: error }
    );
  }

  if (!response.ok) {
    throw new ShareError(
      `The report was not shared: ${await refusal(response)}`,
      {
        reason: "refused",
      }
    );
  }

  const link = ShareAnswer.safeParse(await response.json().catch(() => null));

  if (!link.success) {
    throw new ShareError(
      "The website shared the report but did not answer with its link."
    );
  }

  return link.data;
};

/** What the CLI's `--format json` and seo_share_report's `structuredContent` say of a share. */
export const shareSummary = (report: SharedReport, link: ShareLink) => ({
  url: link.url,
  expiresAt: link.expiresAt,
  kind: report.kind,
  seo: { score: report.seo.score, counts: report.seo.counts },
  aeo: { score: report.aeo.score, counts: report.aeo.counts },
});

/** The words the website and the MCP server refuse one share too many with. */
export const SHARE_LIMIT_MESSAGE =
  "Too many reports shared from this address: try again in a minute.";

/** Audits `target` as `auditForShare` does, uploads both audits, and answers with the link. */
export const shareTarget = async (
  target: string,
  options: ShareAuditOptions & { share?: ShareOptions } = {}
): Promise<{ report: SharedReport; link: ShareLink }> => {
  const report = await auditForShare(target, options);

  return { report, link: await shareAudits(report, options.share) };
};
