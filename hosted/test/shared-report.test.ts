/**
 * Shared reports: the schema an upload passes, the upload at POST /api/share, the store and the
 * page, in Node with the bucket in memory. test/worker.test.ts uploads and opens one in workerd.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { auditAeoHtml, auditSiteBoth } from "../../src/core/aeo/audit.ts";
import { auditHtml } from "../../src/core/audit.ts";
import { SHARE_DAYS } from "../../src/core/share.ts";
import type { SharedReport } from "../../src/core/share.ts";
import {
  siteRoutes,
  startFixtureServer,
} from "../../test/helpers/fixture-server.ts";
import type { FixtureServer } from "../../test/helpers/fixture-server.ts";
import { keepReport, readReport, REPORT_ID } from "../src/shared-reports.ts";
import type { ReportBucket } from "../src/shared-reports.ts";
import { SharedReportSchema } from "../src/shared-schema.ts";
import { shareUpload } from "../src/site/share-api.ts";
import type { ShareApiEnv } from "../src/site/share-api.ts";
import { sharedReportHtml, sharedReportPage } from "../src/site/shared-page.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../test/fixtures/${name}`, import.meta.url),
    "utf-8"
  );

/** An R2 bucket in memory, with what the store uses of one. */
const memoryBucket = (): ReportBucket & { keys: () => string[] } => {
  const objects = new Map<
    string,
    { body: string; customMetadata: Record<string, string> }
  >();

  return {
    keys: () => [...objects.keys()],
    put: (key, body, { customMetadata }) => {
      objects.set(key, { body, customMetadata });

      return Promise.resolve({});
    },
    get: (key) => {
      const object = objects.get(key);

      return Promise.resolve(
        object
          ? {
              customMetadata: object.customMetadata,
              body: new ReadableStream(),
              text: () => Promise.resolve(object.body),
            }
          : null
      );
    },
  };
};

const limiter = (success: boolean): RateLimit => ({
  limit: () => Promise.resolve({ success }),
});

/**
 * The website's bindings for an upload. The store takes any ReportBucket; SiteEnv names R2's type,
 * whose methods the memory bucket has the part of that the store calls.
 */
const envWith = (bucket?: ReportBucket, success = true) =>
  // SAFETY: shareUpload hands the bucket to keepReport alone, which calls `put` only.
  ({ SHARED_REPORTS: bucket, SHARE_UPLOADS: limiter(success) }) as ShareApiEnv;

const upload = (env: ShareApiEnv, body: string, headers = {}) =>
  shareUpload(
    new Request("https://agentic-seo.org/api/share", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
    env
  );

const Link = z.object({ url: z.string(), expiresAt: z.string() });
const Refusal = z.object({ error: z.string() });

const idOf = (url: string): string => url.split("/").pop() ?? "";

/** A report as the wire has it: JSON text, without the keys whose value is undefined. */
const asSent = (report: SharedReport): string => JSON.stringify(report);

/** A report as an upload brings it, through the schema. */
const throughJson = (report: SharedReport): SharedReport =>
  SharedReportSchema.parse(JSON.parse(asSent(report)));

describe("shared reports", () => {
  let pageReport: Extract<SharedReport, { kind: "page" }>;
  let siteReport: SharedReport;
  let server: FixtureServer;

  beforeAll(async () => {
    const url = "https://shop.example.com/pricing";

    const [seo, aeo] = await Promise.all([
      auditHtml(fixture("bad-page.html"), { url, source: "url", target: url }),
      auditAeoHtml(fixture("aeo-bad-page.html"), { url, target: url }),
    ]);

    pageReport = { schemaVersion: 1, kind: "page", seo, aeo };

    server = await startFixtureServer(siteRoutes());

    const site = await auditSiteBoth(`${server.origin}/`, {
      pageDetail: "summary",
    });

    siteReport = { schemaVersion: 1, kind: "site", ...site };
  });

  afterAll(async () => {
    await server.close();
  });

  /** Whether the schema takes the page report once `change` has been made to a copy of it. */
  const passes = (
    change: (report: Extract<SharedReport, { kind: "page" }>) => void
  ): boolean => {
    const copy = structuredClone(pageReport);
    change(copy);

    return SharedReportSchema.safeParse(copy).success;
  };

  describe("the schema", () => {
    it("keeps everything the report shows: a real audit renders the same after it", () => {
      for (const report of [pageReport, siteReport]) {
        expect(sharedReportHtml(throughJson(report))).toBe(
          sharedReportHtml(SharedReportSchema.parse(report))
        );
      }
    });

    it("keeps every key of a real audit, so the JSON and Markdown downloads lose nothing", () => {
      for (const report of [pageReport, siteReport]) {
        // The values, not the order of the keys: a crawl's pages have `response` last, a page
        // audit has it after `auditedAt`, and the schema can follow only one of them.
        expect(JSON.parse(asSent(throughJson(report)))).toStrictEqual(
          JSON.parse(asSent(report))
        );
      }
    });

    it("takes a real audit, and refuses text where the report writes a number or a name as it is", () => {
      expect(
        passes((r) => {
          r.seo.score = 50;
        })
      ).toBeTruthy();
      expect(
        passes((r) => {
          Object.assign(r.seo, { score: '<img src=x onerror="alert(1)">' });
        })
      ).toBeFalsy();
      expect(
        passes((r) => {
          Object.assign(r.seo.findings[0] ?? {}, {
            severity: 'error"><script>',
          });
        })
      ).toBeFalsy();
      expect(
        passes((r) => {
          Object.assign(r.seo.counts, { error: "1<b>" });
        })
      ).toBeFalsy();
      expect(
        passes((r) => {
          Object.assign(r.seo, { auditedAt: "yesterday" });
        })
      ).toBeFalsy();
    });

    it("drops the keys it does not name", () => {
      const parsed = SharedReportSchema.parse({
        ...pageReport,
        extra: "<script>",
      });

      expect(parsed).not.toHaveProperty("extra");
    });
  });

  describe("POST /api/share", () => {
    it("keeps an upload for 30 days and answers with its secret link", async () => {
      const bucket = memoryBucket();

      const response = await upload(
        envWith(bucket),
        JSON.stringify(pageReport)
      );

      expect(response.status).toBe(201);

      const link = Link.parse(await response.json());

      expect(link.url).toMatch(
        /^https:\/\/agentic-seo\.org\/report\/[\w-]{22}$/u
      );
      expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(
        (SHARE_DAYS - 1) * 86_400_000
      );

      const stored = await readReport(bucket, idOf(link.url));

      expect(stored?.source).toBe("upload");
      expect(stored?.report).toStrictEqual(throughJson(pageReport));
    });

    it("refuses what is not JSON, or not an audit", async () => {
      const env = envWith(memoryBucket());

      const notJson = await upload(env, "{");

      expect(Refusal.parse(await notJson.json()).error).toBe(
        "The upload is not JSON."
      );

      const wrong = await upload(
        env,
        JSON.stringify({ ...pageReport, kind: "site" })
      );

      expect(wrong.status).toBe(400);
      expect(Refusal.parse(await wrong.json()).error).toContain(
        "not an audit this website can show"
      );
    });

    it("refuses an upload too large, one too many, or with sharing off", async () => {
      const large = await upload(
        envWith(memoryBucket()),
        JSON.stringify(pageReport),
        { "content-length": "6000000" }
      );

      const limited = await upload(envWith(memoryBucket(), false), "{}");
      const off = await upload(envWith(), "{}");

      expect([large.status, limited.status, off.status]).toStrictEqual([
        413, 429, 503,
      ]);

      await Promise.all(
        [large, limited, off].map((response) => response.body?.cancel())
      );
    });
  });

  describe("the page", () => {
    it("shows the report under a note that says who ran it, kept out of search", async () => {
      const bucket = memoryBucket();
      const link = await keepReport(bucket, siteReport, "upload");
      const stored = await readReport(bucket, idOf(link.url));

      expect(REPORT_ID.test(idOf(link.url))).toBeTruthy();
      expect(bucket.keys()).toStrictEqual([`reports/${idOf(link.url)}`]);

      const html = stored ? sharedReportPage(stored) : "";

      expect(html).toContain("Site audit report");
      expect(html).toContain("did not request the pages itself");
      expect(html).toContain('content="noindex');
    });

    it("reads as gone once it has expired, or with an id nobody issued", async () => {
      const bucket = memoryBucket();

      const link = await keepReport(
        bucket,
        pageReport,
        "hosted",
        new Date("2026-01-01T00:00:00Z")
      );

      const id = idOf(link.url);

      await expect(
        readReport(bucket, id, new Date("2026-01-30T00:00:00Z"))
      ).resolves.not.toBeNull();
      await expect(
        readReport(bucket, id, new Date("2026-02-01T00:00:00Z"))
      ).resolves.toBeNull();
      await expect(readReport(bucket, "A".repeat(22))).resolves.toBeNull();
      await expect(readReport(bucket, "../reports/x")).resolves.toBeNull();
    });
  });
});
