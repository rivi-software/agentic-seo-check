/**
 * The store of background crawls (issue #209), in Node with the bucket in memory. The Workflow
 * that writes it is tested in workerd.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditSiteBoth } from "../../src/core/aeo/audit.ts";
import type { AeoAudit, SiteAudit } from "../../src/core/types.ts";
import type { BackgroundCrawlOptions } from "../../src/mcp-hosted.ts";
import {
  siteRoutes,
  startFixtureServer,
} from "../../test/helpers/fixture-server.ts";
import type { FixtureServer } from "../../test/helpers/fixture-server.ts";
import {
  CRAWL_DAYS,
  CRAWL_ID,
  crawlOptions,
  endCrawl,
  keepCrawl,
  newCrawlId,
  readCrawl,
} from "../src/crawls.ts";
import type { ReportBucket } from "../src/shared-reports.ts";

/** An R2 bucket in memory, with what the store uses of one, and the keys it was asked for. */
const memoryBucket = () => {
  const objects = new Map<
    string,
    { body: string; customMetadata: Record<string, string> }
  >();

  const asked: string[] = [];

  const bucket: ReportBucket = {
    put: (key, body, { customMetadata }) => {
      objects.set(key, { body, customMetadata });

      return Promise.resolve({});
    },
    get: (key) => {
      asked.push(key);
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

  return { bucket, objects, asked };
};

/** seo_start_crawl's options as the tool parses them. */
const OPTIONS: BackgroundCrawlOptions = {
  url: "https://shop.example.com/",
  maxPages: 20,
  maxDepth: 3,
  concurrency: 4,
  delayMs: 0,
  includeSubdomains: false,
  checkExternalLinks: false,
  pageDetail: "summary",
  fieldData: false,
  includeInfo: false,
};

const START = new Date("2026-11-24T10:00:00.000Z");
const END = new Date("2026-11-24T10:02:00.000Z");
const EXPIRES = new Date(START.getTime() + CRAWL_DAYS * 86_400_000);

/** A value as the bucket gives it back: JSON, which drops the keys whose value is undefined. */
const asKept = <T>(value: T): T =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- a clone would keep those keys
  JSON.parse(JSON.stringify(value));

describe("the store of background crawls", () => {
  let server: FixtureServer;
  let seo: SiteAudit;
  let aeo: AeoAudit;

  beforeAll(async () => {
    server = await startFixtureServer(siteRoutes());
    ({ seo, aeo } = await auditSiteBoth(`${server.origin}/`, {
      pageDetail: "summary",
    }));
  });

  afterAll(async () => {
    await server.close();
  });

  it("keeps a crawl's options while it runs, and drops them when it ends", async () => {
    const { bucket, objects } = memoryBucket();
    const id = newCrawlId();

    const metadata = {
      startedAt: START.toISOString(),
      expiresAt: EXPIRES.toISOString(),
    };

    await expect(keepCrawl(bucket, id, OPTIONS, START)).resolves.toBe(
      START.toISOString()
    );
    await expect(crawlOptions(bucket, id)).resolves.toStrictEqual(OPTIONS);
    expect(objects.get(`crawls/${id}`)?.customMetadata).toStrictEqual(metadata);

    await endCrawl(bucket, id, { seo, aeo }, END);

    // The end keeps the start's times, and none of the options.
    await expect(crawlOptions(bucket, id)).resolves.toBeNull();
    expect({
      metadata: objects.get(`crawls/${id}`)?.customMetadata,
      options: "options" in JSON.parse(objects.get(`crawls/${id}`)?.body ?? ""),
    }).toStrictEqual({ metadata, options: false });
  });

  it("reads running, done and failed, each with its times", async () => {
    const { bucket } = memoryBucket();
    const [running, done, failed] = [newCrawlId(), newCrawlId(), newCrawlId()];
    const failure = { message: "robots.txt disallows it.", refused: true };

    await keepCrawl(bucket, running, OPTIONS, START);
    await keepCrawl(bucket, done, OPTIONS, START);
    await keepCrawl(bucket, failed, OPTIONS, START);
    await endCrawl(bucket, done, { seo, aeo }, END);
    await endCrawl(bucket, failed, { failure }, END);

    await expect(readCrawl(bucket, running, END)).resolves.toStrictEqual({
      status: "running",
      startedAt: START.toISOString(),
    });
    await expect(readCrawl(bucket, done, END)).resolves.toStrictEqual({
      status: "done",
      startedAt: START.toISOString(),
      endedAt: END.toISOString(),
      seo: asKept(seo),
      aeo: asKept(aeo),
    });
    await expect(readCrawl(bucket, failed, END)).resolves.toStrictEqual({
      status: "failed",
      startedAt: START.toISOString(),
      endedAt: END.toISOString(),
      failure,
    });
  });

  it("reads an unknown id, a malformed id and one past 7 days as null", async () => {
    const { bucket, asked } = memoryBucket();
    const id = newCrawlId();

    await keepCrawl(bucket, id, OPTIONS, START);

    await expect(readCrawl(bucket, newCrawlId(), END)).resolves.toBeNull();
    await expect(readCrawl(bucket, id, EXPIRES)).resolves.toBeNull();

    // A malformed id never reaches the bucket.
    asked.length = 0;
    await expect(readCrawl(bucket, "../reports/x", END)).resolves.toBeNull();
    await expect(crawlOptions(bucket, "../reports/x")).resolves.toBeNull();
    expect(asked).toStrictEqual([]);
  });

  it("reads an object that does not parse, or has no status it knows, as null", async () => {
    const { bucket, objects } = memoryBucket();

    const customMetadata = {
      startedAt: START.toISOString(),
      expiresAt: EXPIRES.toISOString(),
    };

    const [broken, paused] = [newCrawlId(), newCrawlId()];

    objects.set(`crawls/${broken}`, { body: "{", customMetadata });
    objects.set(`crawls/${paused}`, {
      body: JSON.stringify({
        status: "paused",
        startedAt: START.toISOString(),
      }),
      customMetadata,
    });

    await expect(readCrawl(bucket, broken, END)).resolves.toBeNull();
    await expect(readCrawl(bucket, paused, END)).resolves.toBeNull();
    await expect(crawlOptions(bucket, broken)).resolves.toBeNull();
  });

  it("makes ids of 22 base64url characters, each new", () => {
    const ids = Array.from({ length: 100 }, newCrawlId);

    expect(CRAWL_ID.source).toBe("^[\\w-]{22}$");
    expect(ids.every((id) => CRAWL_ID.test(id))).toBeTruthy();
    expect(new Set(ids).size).toBe(100);
  });
});
