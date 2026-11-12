import { describe, expect, it, onTestFinished, vi } from "vitest";

import { CallLimitError } from "../../src/mcp-hosted.ts";
import type { HostedCallInfo } from "../../src/mcp.ts";
import type { Caller } from "../src/callers.ts";
import { hostedProfile, MAX_INDEX_BYTES, USER_AGENT } from "../src/limits.ts";
import type { LimitsEnv } from "../src/limits.ts";

/** A rate limiter that allows `limit` calls per key, and never forgets them. */
const limiter = (limit: number): RateLimit => {
  const counts = new Map<string, number>();

  return {
    // oxlint-disable-next-line eslint/require-await -- the binding answers with a promise
    limit: async ({ key }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);

      return { success: count <= limit };
    },
  };
};

/** The Worker's bindings, as wrangler.jsonc sets them, in memory. */
const fakeEnv = (overrides: Partial<LimitsEnv> = {}) => {
  const points: AnalyticsEngineDataPoint[] = [];
  const waiting: Promise<unknown>[] = [];
  let stored = { day: "", count: 0 };
  /** The sites each caller audited, by day and caller, as HostedState counts them. */
  const sites = new Map<string, Set<string>>();
  /** The objects the limits asked for, as "jurisdiction/name", "/name" without one. */
  const objects: string[] = [];

  const counter = {
    // oxlint-disable-next-line eslint/require-await -- the Durable Object answers with a promise
    requests: async (day: string) => (stored.day === day ? stored.count : 0),
    // oxlint-disable-next-line eslint/require-await -- the Durable Object answers with a promise
    addRequests: async (day: string, count: number) => {
      stored = {
        day,
        count: (stored.day === day ? stored.count : 0) + count,
      };

      return stored.count;
    },
    // oxlint-disable-next-line eslint/require-await -- the Durable Object answers with a promise
    admitSite: async (
      day: string,
      caller: string,
      site: string,
      limit: number
    ) => {
      const known = sites.get(`${day} ${caller}`) ?? new Set<string>();
      sites.set(`${day} ${caller}`, known);

      if (known.has(site)) {
        return true;
      }

      if (known.size >= limit) {
        return false;
      }

      known.add(site);

      return true;
    },
  };

  const object = (jurisdiction: string) => (name: string) => {
    objects.push(`${jurisdiction}/${name}`);

    return counter;
  };

  const env: LimitsEnv = {
    MODE: "open",
    DAILY_REQUESTS: 100_000,
    CALLER_SITES: 10,
    PLATFORM_SITES: 100,
    SITE_REQUESTS: limiter(600),
    CALLER_CALLS: limiter(30),
    CALLER_CRAWLS: limiter(3),
    PLATFORM_CALLS: limiter(300),
    PLATFORM_CRAWLS: limiter(30),
    CALLS: {
      // As Analytics Engine does, throw for an index longer than it holds.
      writeDataPoint: (point) => {
        if (
          point?.indexes?.some(
            (index) => String(index ?? "").length > MAX_INDEX_BYTES
          )
        ) {
          throw new TypeError("An index is longer than 96 bytes.");
        }

        points.push(point ?? {});
      },
    },
    STATE: {
      getByName: object(""),
      jurisdiction: (jurisdiction) => ({ getByName: object(jurisdiction) }),
    },
    ...overrides,
  };

  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      waiting.push(promise);
    },
  };

  return {
    env,
    ctx,
    points,
    settled: () => Promise.all(waiting),
    stored: () => stored,
    sites,
    objects,
  };
};

const PERSON: Caller = { key: "ip:203.0.113.9", platform: null };
const CLAUDE: Caller = { key: "platform:anthropic", platform: "anthropic" };

const PAGE: HostedCallInfo = {
  tool: "seo_audit_page",
  fetches: true,
  crawl: false,
  host: "www.example.com",
};

const CRAWL: HostedCallInfo = {
  tool: "seo_crawl_site",
  fetches: true,
  crawl: true,
  host: "www.example.com",
};

const COMPARE: HostedCallInfo = {
  tool: "seo_compare_pages",
  fetches: true,
  crawl: false,
  host: "www.example.com",
  competitors: ["rival.example.org", "www.other.example.net"],
};

const INLINE: HostedCallInfo = {
  tool: "seo_audit_page",
  fetches: false,
  crawl: false,
  host: null,
};

/** The message of the refusal `start` ends in, or "admitted". */
const refusalOf = async (start: Promise<unknown>): Promise<string> => {
  try {
    await start;

    return "admitted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** The reason of the limit `start` ends in, for the analytics (issue #84), or "admitted". */
const reasonOf = async (start: Promise<unknown>): Promise<string> => {
  try {
    await start;

    return "admitted";
  } catch (error) {
    return error instanceof CallLimitError ? error.reason : "no reason";
  }
};

describe("the hosted server's limits", () => {
  it("send the hosted User-Agent, which links to the page for site owners", () => {
    expect(USER_AGENT).toMatch(
      /^Mozilla\/5\.0 \(compatible; agentic-seo-check\/\d+\.\d+\.\d+; \+https:\/\/mcp\.agentic-seo\.rivi\.software\/crawler\)$/u
    );
  });

  it("let a caller start 30 calls a minute, 3 of them crawls", async () => {
    const { env, ctx } = fakeEnv();
    const profile = hostedProfile(env, ctx, PERSON);

    const crawls = await Promise.all(
      [1, 2, 3, 4].map(() => refusalOf(profile.startCall(CRAWL)))
    );

    const pages = await Promise.all(
      Array.from({ length: 27 }, () => refusalOf(profile.startCall(PAGE)))
    );

    expect(crawls.slice(0, 3)).toStrictEqual([
      "admitted",
      "admitted",
      "admitted",
    ]);
    expect(crawls[3]).toBe(
      "This address has started 3 crawls on the hosted server in the last minute, its limit per caller. Try again in a minute. Or use the local server, which has no limits: npx -y @rivi-software/agentic-seo-check mcp"
    );
    // The fourth crawl counted as a call: 30 calls in all, then a refusal.
    expect(pages.filter((p) => p === "admitted")).toHaveLength(26);
    expect(pages.at(-1)).toContain("started 30 tool calls");
  });

  it("count every user of a platform as one caller with ten times the limits", async () => {
    const { env, ctx } = fakeEnv();
    const profile = hostedProfile(env, ctx, CLAUDE);

    const crawls = await Promise.all(
      Array.from({ length: 31 }, () => refusalOf(profile.startCall(CRAWL)))
    );

    expect(crawls.filter((c) => c === "admitted")).toHaveLength(30);
    expect(crawls.at(-1)).toContain(
      "The users of claude.ai, Cowork and the Claude apps have together started 30 crawls on the hosted server in the last minute, its limit for the platform."
    );
  });

  it("leave seo_list_rules uncounted", async () => {
    const { env, ctx } = fakeEnv({ CALLER_CALLS: limiter(0) });
    const profile = hostedProfile(env, ctx, PERSON);

    await expect(
      refusalOf(
        profile.startCall({
          tool: "seo_list_rules",
          fetches: false,
          crawl: false,
          host: null,
        })
      )
    ).resolves.toBe("admitted");
    // The refusal states the limit wrangler.jsonc sets; this binding allows none.
    await expect(refusalOf(profile.startCall(INLINE))).resolves.toContain(
      "started 30 tool calls"
    );
  });

  it("send a site 600 requests a minute from all callers together, and count what they send", async () => {
    const { env, ctx, settled, stored } = fakeEnv();
    const first = await hostedProfile(env, ctx, PERSON).startCall(PAGE);
    const second = await hostedProfile(env, ctx, CLAUDE).startCall(PAGE);
    const url = new URL("https://www.example.com/page");

    const answers = await Promise.all(
      Array.from({ length: 601 }, (_, i) =>
        (i % 2 ? first : second).gate?.beforeRequest(url)
      )
    );

    first.end?.({ outcome: "ok", pages: 1 });
    second.end?.({ outcome: "refused", pages: 0 });
    await settled();

    expect(answers.filter((a) => a === undefined)).toHaveLength(600);
    expect(answers.at(-1)).toStrictEqual({
      scope: "host",
      reason: "site_requests",
      message:
        "The hosted server has sent www.example.com 600 requests in the last minute, its limit per site for all its callers together. Try again in a minute. Or use the local server, which has no limits: npx -y @rivi-software/agentic-seo-check mcp",
    });
    expect(stored().count).toBe(600);
  });

  it("count a call's requests as they go, so one cut off midway still counts", async () => {
    const { env, ctx, settled, stored } = fakeEnv();
    const call = await hostedProfile(env, ctx, PERSON).startCall(CRAWL);
    const url = new URL("https://www.example.com/");

    for (let i = 0; i < 60; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a crawl's requests, one after another
      await call.gate?.beforeRequest(url);
    }

    await settled();

    // Two batches of 25; the last 10 wait for the call's end, which never comes.
    expect(stored().count).toBe(50);
  });

  it("refuse audits that request sites once the day's requests are sent, and nothing else", async () => {
    const { env, ctx } = fakeEnv({ DAILY_REQUESTS: 2 });

    await env.STATE.jurisdiction("eu")
      .getByName("global")
      .addRequests(new Date().toISOString().slice(0, 10), 2);

    const profile = hostedProfile(env, ctx, PERSON);

    await expect(refusalOf(profile.startCall(PAGE))).resolves.toBe(
      "The hosted server has sent its 2 requests for today, its daily limit for all callers together. Audits that request a site wait until 00:00 UTC; audits of inline HTML and seo_list_rules still work. Or use the local server, which has no limits: npx -y @rivi-software/agentic-seo-check mcp"
    );
    await expect(refusalOf(profile.startCall(INLINE))).resolves.toBe(
      "admitted"
    );
  });

  it("let a caller audit 10 different sites a day, and those as often as it likes", async () => {
    const { env, ctx } = fakeEnv();
    const profile = hostedProfile(env, ctx, PERSON);

    const on = (host: string, call = PAGE) =>
      refusalOf(profile.startCall({ ...call, host }));

    const ten = await Promise.all(
      Array.from({ length: 10 }, (_, i) => on(`site${i}.example.com`))
    );

    expect(ten.every((answer) => answer === "admitted")).toBeTruthy();
    await expect(on("site10.example.com")).resolves.toBe(
      "This address has audited 10 different sites on the hosted server today, its daily limit per caller. Sites it audited today still work; others wait until 00:00 UTC. Or use the local server, which has no limits: npx -y @rivi-software/agentic-seo-check mcp"
    );
    // A site of the day, crawled now, with www. and a trailing dot; and inline HTML, which is none.
    await expect(on("site3.example.com", CRAWL)).resolves.toBe("admitted");
    await expect(on("www.site5.example.com.")).resolves.toBe("admitted");
    await expect(refusalOf(profile.startCall(INLINE))).resolves.toBe(
      "admitted"
    );
  });

  it("keep the day's requests and sites in the one object in the EU", async () => {
    const { env, ctx, settled, objects } = fakeEnv();
    const call = await hostedProfile(env, ctx, PERSON).startCall(PAGE);

    await call.gate?.beforeRequest(new URL("https://www.example.com/"));
    call.end?.({ outcome: "ok", pages: 1 });
    await settled();

    // The day's count read, the site admitted, the requests counted.
    expect(objects).toStrictEqual(["eu/global", "eu/global", "eu/global"]);
  });

  it("ask for the object without a jurisdiction only when STATE_JURISDICTION is none, as in workerd locally", async () => {
    const local = fakeEnv({ STATE_JURISDICTION: "none" });
    const other = fakeEnv({ STATE_JURISDICTION: "us" });

    await hostedProfile(local.env, local.ctx, PERSON).startCall(PAGE);
    await hostedProfile(other.env, other.ctx, PERSON).startCall(PAGE);

    expect(local.objects).toStrictEqual(["/global", "/global"]);
    expect(other.objects).toStrictEqual(["eu/global", "eu/global"]);
  });

  it("count a site only once the other limits let its call through", async () => {
    const { env, ctx, sites } = fakeEnv({
      CALLER_CRAWLS: limiter(0),
      CALLER_SITES: 1,
    });

    const profile = hostedProfile(env, ctx, PERSON);

    await expect(refusalOf(profile.startCall(CRAWL))).resolves.toContain(
      "started 3 crawls"
    );
    await expect(
      refusalOf(profile.startCall({ ...PAGE, host: "shop.example.com" }))
    ).resolves.toBe("admitted");
    await expect(refusalOf(profile.startCall(PAGE))).resolves.toContain(
      "This address has audited 1 different site on the hosted server today"
    );
    expect([...sites.values()].map((s) => [...s])).toStrictEqual([
      ["shop.example.com"],
    ]);
  });

  it("count another site a page audit's redirect leads to, but not a crawl's link checks", async () => {
    const { env, ctx, sites } = fakeEnv({ CALLER_SITES: 2 });
    const profile = hostedProfile(env, ctx, PERSON);
    const page = await profile.startCall(PAGE);
    const crawl = await profile.startCall(CRAWL);

    const go = (call: typeof page, url: string) =>
      call.gate?.beforeRequest(new URL(url));

    // Its own site, with or without www., and a redirect to a second site, which counts.
    await expect(go(page, "https://example.com/")).resolves.toBeUndefined();
    await expect(
      go(page, "https://second.example.org/robots.txt")
    ).resolves.toBeUndefined();
    await expect(go(page, "https://third.example.net/")).resolves.toStrictEqual(
      {
        scope: "host",
        reason: "caller_sites",
        message:
          "The page led to third.example.net, another site than the one audited. This address has audited 2 different sites on the hosted server today, its daily limit per caller. Sites it audited today still work; others wait until 00:00 UTC. Or use the local server, which has no limits: npx -y @rivi-software/agentic-seo-check mcp",
      }
    );
    // A crawl checks links to any site, and counts none of them.
    await expect(
      go(crawl, "https://third.example.net/")
    ).resolves.toBeUndefined();
    expect([...sites.values()].map((s) => [...s])).toStrictEqual([
      ["example.com", "second.example.org"],
    ]);
  });

  it("count each competitor's site of a comparison, and say whose site a refused one is (issue #129)", async () => {
    const { env, ctx, sites } = fakeEnv({ CALLER_SITES: 2 });

    const call = await hostedProfile(env, ctx, PERSON).startCall(COMPARE);

    const go = (url: string) => call.gate?.beforeRequest(new URL(url));

    await expect(
      go("https://rival.example.org/robots.txt")
    ).resolves.toBeUndefined();
    await expect(go("https://www.other.example.net/a")).resolves.toStrictEqual({
      scope: "host",
      reason: "caller_sites",
      message:
        "www.other.example.net is a competitor's site, one more for today. This address has audited 2 different sites on the hosted server today, its daily limit per caller. Sites it audited today still work; others wait until 00:00 UTC. Or use the local server, which has no limits: npx -y @rivi-software/agentic-seo-check mcp",
    });
    expect([...sites.values()].map((s) => [...s])).toStrictEqual([
      ["example.com", "rival.example.org"],
    ]);
  });

  it("share a platform's 100 sites a day among its users, apart from other callers", async () => {
    const { env, ctx } = fakeEnv();
    const claude = hostedProfile(env, ctx, CLAUDE);

    const answers = await Promise.all(
      Array.from({ length: 101 }, (_, i) =>
        refusalOf(claude.startCall({ ...PAGE, host: `site${i}.example.com` }))
      )
    );

    expect(answers.filter((a) => a === "admitted")).toHaveLength(100);
    expect(answers.find((a) => a !== "admitted")).toBe(
      "The users of claude.ai, Cowork and the Claude apps have together audited 100 different sites on the hosted server today, its daily limit for the platform. Sites they audited today still work; others wait until 00:00 UTC. Or use the local server, which has no limits: npx -y @rivi-software/agentic-seo-check mcp"
    );
    await expect(
      refusalOf(hostedProfile(env, ctx, PERSON).startCall(PAGE))
    ).resolves.toBe("admitted");
  });

  it("name the limit that keeps a call out, for the analytics (issue #84)", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const full = fakeEnv({ DAILY_REQUESTS: 1 });
    await full.env.STATE.getByName("global").addRequests(day, 1);

    const reason = (
      overrides: Partial<LimitsEnv>,
      caller: Caller,
      call: HostedCallInfo
    ) => {
      const { env, ctx } = fakeEnv(overrides);

      return reasonOf(hostedProfile(env, ctx, caller).startCall(call));
    };

    await expect(
      Promise.all([
        reason({ MODE: "closed" }, PERSON, INLINE),
        reason({ MODE: "no-crawls" }, PERSON, CRAWL),
        reason({ CALLER_CALLS: limiter(0) }, PERSON, PAGE),
        reason({ CALLER_CRAWLS: limiter(0) }, PERSON, CRAWL),
        reason({ PLATFORM_CALLS: limiter(0) }, CLAUDE, PAGE),
        reason({ PLATFORM_CRAWLS: limiter(0) }, CLAUDE, CRAWL),
        reasonOf(hostedProfile(full.env, full.ctx, PERSON).startCall(PAGE)),
        reason({ CALLER_SITES: 0 }, PERSON, PAGE),
        reason({ PLATFORM_SITES: 0 }, CLAUDE, PAGE),
        reason({}, PERSON, PAGE),
      ])
    ).resolves.toStrictEqual([
      "paused",
      "no_crawls",
      "caller_calls",
      "caller_crawls",
      "platform_calls",
      "platform_crawls",
      "daily_requests",
      "caller_sites",
      "platform_sites",
      "admitted",
    ]);
  });

  it("turn crawls, or every call, off with MODE", async () => {
    const noCrawls = fakeEnv({ MODE: "no-crawls" });
    const closed = fakeEnv({ MODE: "closed" });

    const crawl = hostedProfile(noCrawls.env, noCrawls.ctx, PERSON);
    const any = hostedProfile(closed.env, closed.ctx, PERSON);

    await expect(refusalOf(crawl.startCall(CRAWL))).resolves.toContain(
      "does not crawl sites at the moment"
    );
    await expect(refusalOf(crawl.startCall(PAGE))).resolves.toBe("admitted");
    await expect(refusalOf(any.startCall(INLINE))).resolves.toContain(
      "The hosted server is paused."
    );
  });

  it("record each call by tool, outcome and hostname, never the path or the caller", async () => {
    const { env, ctx, points } = fakeEnv({ CALLER_CRAWLS: limiter(0) });
    const profile = hostedProfile(env, ctx, PERSON);
    const call = await profile.startCall(PAGE);
    await call.gate?.beforeRequest(new URL("https://www.example.com/a?b=c"));
    call.end?.({ outcome: "ok", pages: 1 });
    await refusalOf(profile.startCall(CRAWL));

    expect(points).toMatchObject([
      {
        indexes: ["www.example.com"],
        blobs: ["seo_audit_page", "ok", "www.example.com"],
        doubles: [expect.any(Number), 1, 1],
      },
      {
        indexes: ["www.example.com"],
        blobs: ["seo_crawl_site", "limited", "www.example.com"],
        doubles: [expect.any(Number), 0, 0],
      },
    ]);
    expect(JSON.stringify(points)).not.toMatch(/\/a|b=c|203\.0\.113\.9/u);
  });

  it("record each competitor's hostname a comparison sent requests to, with its requests (issue #129)", async () => {
    const { env, ctx, points } = fakeEnv();
    const call = await hostedProfile(env, ctx, PERSON).startCall(COMPARE);

    await Promise.all(
      [
        "https://www.example.com/robots.txt",
        "https://www.example.com/widgets",
        "https://rival.example.org/robots.txt",
        "https://rival.example.org/widgets",
        "https://rival.example.org/llms.txt",
      ].map((url) => call.gate?.beforeRequest(new URL(url)))
    );

    call.end?.({ outcome: "ok", pages: 2 });

    expect(points).toMatchObject([
      {
        indexes: ["www.example.com"],
        blobs: ["seo_compare_pages", "ok", "www.example.com"],
        doubles: [expect.any(Number), 5, 2],
      },
      {
        indexes: ["rival.example.org"],
        blobs: ["seo_compare_pages", "ok", "rival.example.org", "competitor"],
        doubles: [expect.any(Number), 3, 0],
      },
    ]);
  });

  it("record a hostname longer than an index holds, cut in the index and whole in the blob", async () => {
    // 203 characters; a hostname can have 253.
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.example.com`;
    const { env, ctx, points } = fakeEnv();

    const call = await hostedProfile(env, ctx, PERSON).startCall({
      ...PAGE,
      host,
    });

    call.end?.({ outcome: "ok", pages: 1 });

    expect(points).toMatchObject([
      {
        indexes: [host.slice(0, MAX_INDEX_BYTES)],
        blobs: ["seo_audit_page", "ok", host],
      },
    ]);
  });

  it("never fail a call, or lose its requests from the day's count, over a record they could not write", async () => {
    const { env, ctx, settled, stored } = fakeEnv({
      CALLER_CRAWLS: limiter(0),
      CALLS: {
        writeDataPoint: () => {
          throw new TypeError("Analytics Engine is unavailable.");
        },
      },
    });

    // The Worker's logs get the failure; the test only reads it.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    onTestFinished(() => logged.mockRestore());

    const reported: [unknown, string][] = [];

    const profile = hostedProfile(env, ctx, PERSON, {
      report: (error, task) => reported.push([error, task]),
    });

    const call = await profile.startCall(PAGE);
    await call.gate?.beforeRequest(new URL("https://www.example.com/"));

    expect(() => call.end?.({ outcome: "ok", pages: 1 })).not.toThrow();
    // A refusal keeps its own message.
    await expect(refusalOf(profile.startCall(CRAWL))).resolves.toContain(
      "This address has started 3 crawls"
    );

    await settled();

    expect(stored().count).toBe(1);
    expect(logged).toHaveBeenCalledWith(
      "Could not record a seo_audit_page call: Analytics Engine is unavailable."
    );
    // Error tracking hears each record that was lost (issue #93).
    expect(reported).toStrictEqual([
      [expect.any(TypeError), "call_record"],
      [expect.any(TypeError), "call_record"],
    ]);
  });

  it("record a call the limits could not judge as an error, not a limit, and let its error through (issue #93)", async () => {
    const failure = new Error(
      "Durable Object reset because its code was updated."
    );

    const { env, ctx, points } = fakeEnv({
      STATE: {
        getByName: () => ({
          requests: () => Promise.reject(failure),
          addRequests: () => Promise.reject(failure),
          admitSite: () => Promise.reject(failure),
        }),
        jurisdiction: () => ({
          getByName: () => ({
            requests: () => Promise.reject(failure),
            addRequests: () => Promise.reject(failure),
            admitSite: () => Promise.reject(failure),
          }),
        }),
      },
    });

    const start = hostedProfile(env, ctx, PERSON).startCall(PAGE);

    await expect(start).rejects.toBe(failure);
    await expect(start).rejects.not.toBeInstanceOf(CallLimitError);
    expect(points).toMatchObject([
      { blobs: ["seo_audit_page", "error", "www.example.com"] },
    ]);
  });

  it("log and report a day's count that failed after the answer, which never fails the answer (issue #93)", async () => {
    const { env, ctx, settled } = fakeEnv();
    const state = env.STATE.jurisdiction("eu").getByName("global");

    const failing = {
      ...state,
      addRequests: () => Promise.reject(new Error("Network connection lost.")),
    };

    env.STATE = {
      getByName: () => failing,
      jurisdiction: () => ({ getByName: () => failing }),
    };

    const logged = vi.spyOn(console, "error").mockReturnValue();
    onTestFinished(() => logged.mockRestore());

    const reported: [unknown, string][] = [];

    const call = await hostedProfile(env, ctx, PERSON, {
      report: (error, task) => reported.push([error, task]),
    }).startCall(PAGE);

    await call.gate?.beforeRequest(new URL("https://www.example.com/"));
    call.end?.({ outcome: "ok", pages: 1 });

    await expect(settled()).resolves.toBeDefined();
    expect(reported).toStrictEqual([[expect.any(Error), "request_count"]]);
    expect(logged).toHaveBeenCalledWith(
      "Could not count 1 requests: Network connection lost."
    );
  });
});
