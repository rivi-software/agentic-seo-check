/**
 * The audit form's failures and its error tracking (issue #96), in Node: `answerAudit` with the
 * website's bindings in memory, Turnstile and PostHog answered here, and the audited site from
 * `routes`. The workerd tests drive the form end to end; these make its own parts fail.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import { onCaughtError } from "../../src/core/errors.ts";
import { hearCaughtError } from "../src/analytics.ts";
import { answerAudit, ON_OUR_SIDE } from "../src/site/audit.ts";
import type { SiteEnv } from "../src/site/audit.ts";

const POSTHOG = "https://posthog.test";
const SITE = "https://agentic-seo.org";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const Batch = z.object({
  batch: z.array(
    z.object({
      event: z.string(),
      properties: z.record(z.string(), z.unknown()),
    })
  ),
});

type Event = z.infer<typeof Batch>["batch"][number];

/** A page of the audited site, by absolute URL. */
interface Route {
  status?: number;
  body: string;
  type?: string;
}

const html = (title: string, body = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title}, a page of the fixture shop for the form's tests."></head><body><h1>${title}</h1>${body}</body></html>`;

/** The test key of RFC 9421, which signing.test.ts checks against Cloudflare's own examples. */
const TEST_KEY = {
  kty: "OKP",
  crv: "Ed25519",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
  d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU",
} as const;

/** The shop the form audits: a homepage that links to two pages. */
const SHOP = {
  "https://shop.example.com/": {
    body: html(
      "The fixture shop",
      '<a href="/about">About</a> <a href="/contact">Contact</a>'
    ),
  },
  "https://shop.example.com/about": { body: html("About the fixture shop") },
  "https://shop.example.com/contact": { body: html("Contact the shop") },
} satisfies Record<string, Route>;

/** The fetch the Worker sees: Turnstile passes, PostHog keeps each request's events, the site answers. */
const serve = (routes: Record<string, Route>) => {
  const batches: Event[][] = [];

  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);

      if (url === SITEVERIFY) {
        return Promise.resolve(Response.json({ success: true }));
      }

      if (url === `${POSTHOG}/batch/`) {
        batches.push(Batch.parse(JSON.parse(String(init?.body))).batch);

        return Promise.resolve(Response.json({ status: 1 }));
      }

      const route = routes[url];

      return Promise.resolve(
        new Response(route?.body ?? html("Not found"), {
          status: route ? (route.status ?? 200) : 404,
          headers: {
            "content-type": route?.type ?? "text/html; charset=utf-8",
          },
        })
      );
    }
  );

  return batches;
};

/** A rate limit binding that lets everything through, or throws for `failing`. */
const limiter = (failing?: (key: string) => boolean): RateLimit => ({
  // oxlint-disable-next-line eslint/require-await -- the binding answers with a promise
  limit: async ({ key }) => {
    if (failing?.(key)) {
      throw new Error("Rate limiting is unavailable.");
    }

    return { success: true };
  },
});

/** What a Durable Object answers while it is being reset. */
const reset = () =>
  Promise.reject(
    new Error("Durable Object reset because its code was updated.")
  );

/** The day's counts as HostedState keeps them, in memory, or an object that fails every call. */
const state = (failing: boolean) => {
  const object = failing
    ? { requests: reset, addRequests: reset, admitSite: reset }
    : {
        requests: () => Promise.resolve(0),
        addRequests: (_day: string, count: number) => Promise.resolve(count),
        admitSite: () => Promise.resolve(true),
      };

  return {
    getByName: () => object,
    jurisdiction: () => ({ getByName: () => object }),
  };
};

/** The website's bindings, as wrangler.site.jsonc sets them, in memory. */
const formEnv = (overrides: Partial<SiteEnv> = {}) => {
  const points: AnalyticsEngineDataPoint[] = [];
  const waiting: Promise<unknown>[] = [];

  const env: SiteEnv = {
    MODE: "open",
    DAILY_REQUESTS: 100_000,
    CALLER_SITES: 10,
    PLATFORM_SITES: 100,
    SITE_REQUESTS: limiter(),
    CALLER_CALLS: limiter(),
    CALLER_CRAWLS: limiter(),
    PLATFORM_CALLS: limiter(),
    PLATFORM_CRAWLS: limiter(),
    CALLS: {
      writeDataPoint: (point) => {
        points.push(point ?? {});
      },
    },
    STATE: state(false),
    STATE_JURISDICTION: "eu",
    POSTHOG_HOST: POSTHOG,
    TURNSTILE_SITE_KEY: "1x00000000000000000000BB",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    ...overrides,
  };

  return {
    env,
    points,
    ctx: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise) },
    settled: () => Promise.all(waiting),
  };
};

/** The form as a browser sends it, for `url`. */
const form = (url: string): Request => {
  const body = new URLSearchParams({
    url,
    "cf-turnstile-response": "a-person",
  }).toString();

  return new Request(`${SITE}/audit`, {
    method: "POST",
    body,
    headers: {
      origin: SITE,
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(body.length),
      "cf-connecting-ip": "203.0.113.9",
    },
  });
};

/** Reads a crawl's streamed lines and keeps none: these tests read the answer's state. */
const discard = (_line: string): void => {
  // Nothing to keep.
};

const exceptions = (batches: Event[][]) =>
  batches.flat().filter((event) => event.event === "$exception");

describe("the audit form's failures (issue #96)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    onCaughtError(undefined);
  });

  it("owns a failure of the shared state, which is no limit, and reports it", async () => {
    const batches = serve(SHOP);
    const { env, ctx, settled, points } = formEnv({ STATE: state(true) });

    const answer = await answerAudit(form("shop.example.com/about"), env, ctx);

    await settled();

    expect([
      answer.status,
      answer.state.failure,
      answer.state.error,
    ]).toStrictEqual([503, "error", ON_OUR_SIDE]);
    expect(points).toMatchObject([
      { blobs: ["web_audit_page", "error", "shop.example.com"] },
    ]);
    expect(exceptions(batches)).toMatchObject([
      {
        properties: {
          surface: "hosted",
          route: "website:/audit",
          tool: "web_audit_page",
          outcome: "error",
          $exception_list: [
            {
              type: "Error",
              value: "Durable Object reset because its code was updated.",
            },
          ],
        },
      },
    ]);
  });

  it("owns a failure of a page audit, says nothing of the error, and reports it with the run", async () => {
    const batches = serve(SHOP);

    // The rate limit for the site's requests fails: a failure of ours, not the site's.
    const { env, ctx, settled } = formEnv({
      SITE_REQUESTS: limiter(() => true),
    });

    const answer = await answerAudit(form("shop.example.com/about"), env, ctx);

    await settled();

    expect([
      answer.status,
      answer.state.failure,
      answer.state.error,
    ]).toStrictEqual([500, "error", ON_OUR_SIDE]);
    expect(exceptions(batches)).toMatchObject([
      {
        properties: {
          route: "website:/audit",
          tool: "web_audit_page",
          outcome: "error",
          requests: 0,
          pages: 0,
          $exception_list: [{ value: "Rate limiting is unavailable." }],
        },
      },
    ]);
    expect(JSON.stringify(batches)).not.toContain("shop.example.com");
  });

  it("sends the errors the core caught in a run in one request when the run ends, one per bug", async () => {
    const batches = serve(SHOP);

    onCaughtError(hearCaughtError);

    // Every signature fails: a bug of ours, which the core catches for each request it fails, and
    // the crawl then ends as robots.txt that could not be read ends it, the site's refusal.
    const signing = vi
      .spyOn(crypto.subtle, "sign")
      .mockRejectedValue(
        new DOMException("Key usage not permitted", "InvalidAccessError")
      );

    onTestFinished(() => signing.mockRestore());

    const { env, ctx, settled } = formEnv({
      WEB_BOT_AUTH_KEYS: JSON.stringify([TEST_KEY]),
    });

    const answer = await answerAudit(form("shop.example.com"), env, ctx);

    await answer.rest?.(discard);
    await settled();

    expect([answer.status, answer.state.failure]).toStrictEqual([
      502,
      "refused",
    ]);
    expect(signing.mock.calls.length).toBeGreaterThan(0);
    expect(batches).toHaveLength(1);
    expect(exceptions(batches)).toMatchObject([
      {
        properties: {
          route: "website:/audit",
          tool: "web_crawl_site",
          outcome: "refused",
          task: "request_signature",
          occurrences: signing.mock.calls.length,
          $exception_list: [
            { type: "InvalidAccessError", mechanism: { handled: true } },
          ],
        },
      },
    ]);
  });

  it("names a crawl the site's robots.txt keeps out as the site's refusal, and reports nothing", async () => {
    const batches = serve({
      ...SHOP,
      "https://shop.example.com/robots.txt": {
        body: "User-agent: agentic-seo-check\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
        type: "text/plain",
      },
    });

    const { env, ctx, settled } = formEnv();
    const answer = await answerAudit(form("shop.example.com"), env, ctx);

    await answer.rest?.(discard);
    await settled();

    expect([answer.status, answer.state.failure]).toStrictEqual([
      502,
      "refused",
    ]);
    expect(answer.state.error).toContain("asks agentic-seo-check not to crawl");
    expect(exceptions(batches)).toStrictEqual([]);
  });
});
