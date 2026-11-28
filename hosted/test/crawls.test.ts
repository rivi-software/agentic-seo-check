/**
 * The store of background crawls (issue #209), in Node with the bucket in memory, and an attempt
 * of the Workflow's step whose bucket fails. The Workflow itself is tested in workerd.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { NonRetryableError } from "cloudflare:workflows";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { auditSiteBoth } from "../../src/core/aeo/audit.ts";
import { CRAWL_DAYS } from "../../src/core/hosted.ts";
import type { AeoAudit, SiteAudit } from "../../src/core/types.ts";
import { runBackgroundCrawl } from "../../src/mcp-hosted.ts";
import type { BackgroundCrawlOptions } from "../../src/mcp-hosted.ts";
import {
  siteRoutes,
  startFixtureServer,
} from "../../test/helpers/fixture-server.ts";
import type { FixtureServer } from "../../test/helpers/fixture-server.ts";
import type { ErrorTask } from "../src/analytics.ts";
import {
  backgroundCrawls,
  CRAWL_ID,
  crawlAttempt,
  endCrawl,
  keepCrawl,
  newCrawlId,
  readCrawl,
  storedCrawlOptions,
} from "../src/crawls.ts";
import type { CrawlEnv } from "../src/crawls.ts";
import type { DayCounter } from "../src/limits.ts";
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
    await expect(storedCrawlOptions(bucket, id)).resolves.toStrictEqual({
      options: OPTIONS,
      times: metadata,
    });
    expect(objects.get(`crawls/${id}`)?.customMetadata).toStrictEqual(metadata);

    await endCrawl(bucket, id, { seo, aeo }, END);

    // The end keeps the start's times, and none of the options.
    await expect(storedCrawlOptions(bucket, id)).resolves.toBeNull();
    expect({
      metadata: objects.get(`crawls/${id}`)?.customMetadata,
      options: "options" in JSON.parse(objects.get(`crawls/${id}`)?.body ?? ""),
    }).toStrictEqual({ metadata, options: false });
  });

  it("reads running, done and failed, each with its times", async () => {
    const { bucket } = memoryBucket();
    const [running, done, failed] = [newCrawlId(), newCrawlId(), newCrawlId()];

    const failure = {
      message: "robots.txt disallows it.",
      type: "permission" as const,
    };

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
    await expect(
      storedCrawlOptions(bucket, "../reports/x")
    ).resolves.toBeNull();
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
    await expect(storedCrawlOptions(bucket, broken)).resolves.toBeNull();
  });

  it("makes ids of 32 hex digits, each new, that a Workflow takes as its instance's", () => {
    const ids = Array.from({ length: 1000 }, newCrawlId);

    expect(CRAWL_ID.source).toBe("^[\\da-f]{32}$");
    expect(ids.every((id) => CRAWL_ID.test(id))).toBeTruthy();
    // The pattern Cloudflare Workflows holds an instance's id to.
    expect(
      ids.every((id) => /^[\w][\w-]*$/u.test(id) && id.length <= 100)
    ).toBeTruthy();
    expect(new Set(ids).size).toBe(1000);
  });
});

/** A `waitUntil` that drops what it is handed: the attempt waits for its own work. */
const IGNORED = {
  waitUntil: (promise: Promise<unknown>) => {
    promise.catch(() => null);
  },
};

/** A rate limiter the attempt never reaches: MODE keeps it out first. */
const unused: RateLimit = {
  limit: () => Promise.reject(new Error("No limit is asked for.")),
};

/** The bindings of an attempt under MODE `closed`, which `readmit` refuses, with `bucket`. */
const closedEnv = (bucket: ReportBucket) => {
  const outcomes: string[] = [];

  const env: CrawlEnv = {
    MODE: "closed",
    DAILY_REQUESTS: 100_000,
    PAID_DAILY_REQUESTS: 100_000,
    CALLER_SITES: 10,
    PLATFORM_SITES: 100,
    SITE_REQUESTS: unused,
    CALLER_CALLS: unused,
    CALLER_CRAWLS: unused,
    PLATFORM_CALLS: unused,
    PLATFORM_CRAWLS: unused,
    SHARE_UPLOADS: unused,
    RENDER_CALLS: unused,
    CALLS: {
      writeDataPoint: (point) => {
        outcomes.push(String(point?.blobs?.[1]));
      },
    },
    STATE: {
      getByName: () => {
        throw new Error("No Durable Object is asked for.");
      },
      jurisdiction: () => ({
        getByName: () => {
          throw new Error("No Durable Object is asked for.");
        },
      }),
    },
    POSTHOG_HOST: "https://posthog.test",
    SHARED_REPORTS: bucket,
  };

  return { env, outcomes };
};

describe("an attempt of a background crawl", () => {
  it("throws a refusal it cannot write as no retry, once its error's event has gone", async () => {
    const { bucket } = memoryBucket();
    const id = newCrawlId();

    await keepCrawl(bucket, id, OPTIONS);
    // R2 is down from now on.
    bucket.put = () => Promise.reject(new Error("R2 is unavailable."));

    const { env, outcomes } = closedEnv(bucket);
    const sent: string[] = [];

    // PostHog answers late: the attempt must wait for it.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      await sleep(50);
      sent.push(String(input));

      return Response.json({ status: 1 });
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const handed: Promise<unknown>[] = [];
    const attempt = crawlAttempt(env, { waitUntil: (p) => handed.push(p) }, id);

    await expect(attempt).rejects.toBeInstanceOf(NonRetryableError);
    await expect(attempt).rejects.toThrow("The hosted server is paused.");
    // The bucket's error went to PostHog before the attempt ended, and the record says limited.
    expect(sent).toStrictEqual(["https://posthog.test/batch/"]);
    expect(handed.length).toBeGreaterThan(0);
    expect(outcomes).toStrictEqual(["limited"]);
  });

  it("ends a crawl a limit stopped failed, typed as seo_crawl_site types it", async () => {
    const { bucket } = memoryBucket();
    const id = newCrawlId();

    await keepCrawl(bucket, id, OPTIONS, START);

    const { env, outcomes } = closedEnv(bucket);

    await expect(crawlAttempt(env, IGNORED, id)).resolves.toStrictEqual({
      pages: 0,
    });
    await expect(readCrawl(bucket, id, END)).resolves.toMatchObject({
      status: "failed",
      startedAt: START.toISOString(),
      failure: { type: "validation" },
    });
    expect(outcomes).toStrictEqual(["limited"]);
  });
});

/** A rate limiter that allows everything. */
const allow: RateLimit = {
  limit: () => Promise.resolve({ success: true }),
};

/** The bindings of an attempt under MODE `open`, with a day that has room, and `bucket`. */
const openEnv = (bucket: ReportBucket) => {
  const { env, outcomes } = closedEnv(bucket);

  const day: DayCounter = {
    requests: () => Promise.resolve(0),
    addRequests: (_day, count) => Promise.resolve(count),
    paidRequests: () => Promise.resolve(0),
    addPaidRequests: (_day, count) => Promise.resolve(count),
    renders: () => Promise.resolve(0),
    addRenders: (_day, count) => Promise.resolve(count),
    admitSite: () => Promise.resolve(true),
  };

  const open: CrawlEnv = {
    ...env,
    MODE: "open",
    STATE_JURISDICTION: "none",
    SITE_REQUESTS: allow,
    STATE: {
      getByName: () => day,
      jurisdiction: () => ({ getByName: () => day }),
    },
  };

  return { env: open, outcomes };
};

const ROBOTS_TXT = "User-agent: *\nAllow: /\n";

/**
 * Serves shop.example.com in place of the network: its home page links to `/a` and `/b`, which
 * answer `linked`, and PostHog takes events. It answers the URLs of the site it was asked for.
 */
const serveShop = (linked: number) => {
  const asked: string[] = [];

  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === "posthog.test") {
      return Promise.resolve(Response.json({ status: 1 }));
    }

    asked.push(url.pathname);

    if (url.pathname === "/robots.txt") {
      return Promise.resolve(new Response(ROBOTS_TXT));
    }

    if (url.pathname === "/") {
      return Promise.resolve(
        new Response(
          '<!doctype html><html lang="en"><head><title>Shop</title></head><body><a href="/a">A</a><a href="/b">B</a></body></html>',
          { headers: { "content-type": "text/html" } }
        )
      );
    }

    if (url.pathname === "/a" || url.pathname === "/b") {
      return Promise.resolve(
        new Response("<!doctype html><title>Page</title>", {
          status: linked,
          headers: { "content-type": "text/html" },
        })
      );
    }

    return Promise.resolve(new Response("Not found", { status: 404 }));
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  return asked;
};

/** Runs the crawl, then throws, as a bug in building the AEO audit would. */
const buggy: typeof runBackgroundCrawl = async (...args) => {
  await runBackgroundCrawl(...args);

  throw new Error("A bug in building the AEO audit.");
};

describe("an attempt of a background crawl that has asked the site", () => {
  it("never retries once the crawl is over, when its end cannot be written", async () => {
    const { bucket } = memoryBucket();
    const id = newCrawlId();

    await keepCrawl(bucket, id, OPTIONS);
    bucket.put = () => Promise.reject(new Error("R2 is unavailable."));
    serveShop(200);

    const { env, outcomes } = openEnv(bucket);
    const attempt = crawlAttempt(env, IGNORED, id);

    await expect(attempt).rejects.toBeInstanceOf(NonRetryableError);
    await expect(attempt).rejects.toThrow("could not keep the crawl's result");
    expect(outcomes).toStrictEqual(["error"]);
  });

  it("never retries an error after a site refused the crawl partway", async () => {
    const { bucket } = memoryBucket();
    const id = newCrawlId();

    // One request at a time, so the 429 comes before the crawl asks for the next page.
    await keepCrawl(bucket, id, { ...OPTIONS, concurrency: 1 });
    const asked = serveShop(429);

    const { env, outcomes } = openEnv(bucket);
    const attempt = crawlAttempt(env, IGNORED, id, buggy);

    await expect(attempt).rejects.toBeInstanceOf(NonRetryableError);
    await expect(attempt).rejects.toThrow("A bug in building the AEO audit.");
    // The site answered 429 to a page the crawl asked for, and was asked nothing after it.
    expect(asked.filter((path) => path === "/a" || path === "/b")).toHaveLength(
      1
    );
    expect(outcomes).toStrictEqual(["error"]);
  });

  it("counts a subscriber's crawl against the subscribers' day, as its call was (issue #230)", async () => {
    const { bucket } = memoryBucket();
    const free = newCrawlId();
    const paid = newCrawlId();
    const created: string[] = [];

    const crawls = backgroundCrawls(
      {
        SHARED_REPORTS: bucket,
        CRAWLS: {
          create: ({ id } = {}) => {
            created.push(String(id));

            // SAFETY: start reads nothing of the instance the Workflow answers with.
            return Promise.resolve({} as WorkflowInstance);
          },
        },
      },
      undefined,
      "subscription"
    );

    const started = await crawls?.start(OPTIONS);

    await expect(
      storedCrawlOptions(bucket, String(started?.id))
    ).resolves.toMatchObject({ paid: "subscription" });

    await keepCrawl(bucket, free, OPTIONS);
    await keepCrawl(bucket, paid, OPTIONS, START, "subscription");
    serveShop(200);

    const counted = { free: 0, paid: 0 };
    const { env } = openEnv(bucket);
    const day = env.STATE.getByName("global");

    day.addRequests = (_day, count) => {
      counted.free += count;

      return Promise.resolve(counted.free);
    };

    day.addPaidRequests = (_day, count) => {
      counted.paid += count;

      return Promise.resolve(counted.paid);
    };

    await crawlAttempt(env, IGNORED, free);
    const freeCount = counted.free;

    await crawlAttempt(env, IGNORED, paid);

    expect(freeCount).toBeGreaterThan(0);
    expect(counted).toStrictEqual({ free: freeCount, paid: freeCount });
    expect(created).toHaveLength(1);
  });

  it("leaves an error before any refusal to the step's retry", async () => {
    const { bucket } = memoryBucket();
    const id = newCrawlId();

    await keepCrawl(bucket, id, OPTIONS);
    serveShop(200);

    const { env } = openEnv(bucket);

    const attempt = crawlAttempt(env, IGNORED, id, () =>
      Promise.reject(new Error("A bug before any request."))
    );

    await expect(attempt).rejects.toThrow("A bug before any request.");
    await expect(attempt).rejects.not.toBeInstanceOf(NonRetryableError);
  });
});

describe("the background crawls of a server", () => {
  it("answers the Workflow's error when the crawl it could not start cannot be ended either", async () => {
    const { bucket } = memoryBucket();
    const put = bucket.put.bind(bucket);
    let puts = 0;

    // The start's write goes in; the end's fails.
    bucket.put = (...args) => {
      puts += 1;

      return puts === 1
        ? put(...args)
        : Promise.reject(new Error("R2 is down."));
    };

    const heard: ErrorTask[] = [];

    const crawls = backgroundCrawls(
      {
        SHARED_REPORTS: bucket,
        CRAWLS: {
          create: () => Promise.reject(new Error("Workflows are down.")),
        },
      },
      (_error, task) => heard.push(task)
    );

    await expect(crawls?.start(OPTIONS)).rejects.toThrow("Workflows are down.");
    expect(heard).toStrictEqual(["crawl_end"]);
  });

  it("is off without the bucket or the Workflow", () => {
    expect(backgroundCrawls({})).toBeUndefined();
  });
});
