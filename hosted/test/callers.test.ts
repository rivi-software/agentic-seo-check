import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  callerOf,
  inRange,
  OPENAI_RANGES_URL,
  openAiRangesReader,
  parseAddress,
  parseOpenAiRanges,
} from "../src/callers.ts";
import type { RangesEnv } from "../src/callers.ts";

const OPENAI = ["104.210.139.192/28", "2603:1030:0:1::/64"];

/** OpenAI's list as it publishes it, with the ranges of OPENAI. */
const LIST =
  '{"creationTime":"2026-11-06T18:26:55","prefixes":[{"ipv4Prefix":"104.210.139.192/28"},{"ipv6Prefix":"2603:1030:0:1::/64"}]}';

/** The STATE binding with OpenAI's ranges in memory, `ranges` to start with, as HostedState keeps them. */
const fakeState = (ranges: string[] = []) => {
  const stored = { ranges };
  /** The objects asked for, as "jurisdiction/name", "/name" without one. */
  const objects: string[] = [];
  const waiting: Promise<unknown>[] = [];

  const object = (jurisdiction: string) => (name: string) => {
    objects.push(`${jurisdiction}/${name}`);

    return {
      openAiRanges: () => Promise.resolve(stored.ranges),
      setOpenAiRanges: (list: string[]) => {
        stored.ranges = list;

        return Promise.resolve();
      },
    };
  };

  const env: RangesEnv = {
    STATE: {
      getByName: object(""),
      jurisdiction: (jurisdiction) => ({ getByName: object(jurisdiction) }),
    },
  };

  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      waiting.push(promise);
    },
  };

  return {
    env,
    ctx,
    stored,
    objects,
    settled: () => Promise.all(waiting),
  };
};

/** Answers the Worker's fetch() with `answer`, and lists what it fetched. */
const stubFetch = (answer: () => Response): string[] => {
  const fetched: string[] = [];

  vi.stubGlobal("fetch", (url: string) => {
    fetched.push(url);

    return Promise.resolve(answer());
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  return fetched;
};

describe("callers", () => {
  it("counts claude.ai and ChatGPT each as one caller, by the platform's addresses", () => {
    expect(callerOf("160.79.105.17", OPENAI)).toStrictEqual({
      key: "platform:anthropic",
      platform: "anthropic",
    });
    expect(callerOf("153.61.223.255", OPENAI).platform).toBe("anthropic");
    expect(callerOf("104.210.139.200", OPENAI)).toStrictEqual({
      key: "platform:openai",
      platform: "openai",
    });
    expect(callerOf("2603:1030:0:1::abcd", OPENAI).platform).toBe("openai");
  });

  it("counts anyone else by IP address, and an IPv6 caller by its /64", () => {
    expect(callerOf("203.0.113.9", OPENAI)).toStrictEqual({
      key: "ip:203.0.113.9",
      platform: null,
    });
    expect(callerOf("2001:db8:1:2:aaaa::1", OPENAI).key).toBe(
      callerOf("2001:db8:1:2:bbbb::9", OPENAI).key
    );
    expect(callerOf("2001:db8:1:3::1", OPENAI).key).not.toBe(
      callerOf("2001:db8:1:2::1", OPENAI).key
    );
    expect(callerOf(null, OPENAI)).toStrictEqual({
      key: "ip:unknown",
      platform: null,
    });
  });

  it("reads IPv4, IPv6 and IPv4-mapped addresses, and nothing else", () => {
    const mapped = parseAddress("::ffff:160.79.104.1");

    expect(parseAddress("160.79.104.1")?.bits).toBe(32);
    expect(mapped?.bits).toBe(128);
    expect(mapped && inRange(mapped, "::ffff:160.79.104.0/120")).toBeTruthy();
    expect(
      ["999.1.1.1", "1.2.3", "::1::2", "fe80::zz", "example.com", ""].map(
        parseAddress
      )
    ).toStrictEqual([null, null, null, null, null, null]);
  });

  it("matches a range by its prefix only", () => {
    const ip = parseAddress("160.79.111.255");

    expect(ip && inRange(ip, "160.79.104.0/21")).toBeTruthy();
    expect(ip && inRange(ip, "160.79.104.0/22")).toBeFalsy();
    expect(ip && inRange(ip, "2603:1030::/32")).toBeFalsy();
    expect(ip && inRange(ip, "not a range")).toBeFalsy();
  });

  it("reads OpenAI's list of ChatGPT connector ranges", () => {
    expect(
      parseOpenAiRanges(
        '{"creationTime":"2026-11-06T18:26:55","prefixes":[{"ipv4Prefix":"104.210.139.192/28"},{"ipv6Prefix":"2603:1030:0:1::/64"}]}'
      )
    ).toStrictEqual(OPENAI);
    expect(() => parseOpenAiRanges('{"ranges":[]}')).toThrow(/prefixes/u);
  });
});

describe("OpenAI's ranges", () => {
  it("are read from the object in the EU, once an hour, and never fetched while it has them", async () => {
    const fetched = stubFetch(() => new Response(LIST));
    const { env, ctx, objects, settled } = fakeState(OPENAI);
    const read = openAiRangesReader();

    await expect(read(env, ctx)).resolves.toStrictEqual(OPENAI);
    await expect(read(env, ctx)).resolves.toStrictEqual(OPENAI);
    await settled();

    expect(objects).toStrictEqual(["eu/global"]);
    expect(fetched).toStrictEqual([]);
  });

  it("are fetched once when the object has none, as a new one has, and used from then on", async () => {
    const fetched = stubFetch(() => new Response(LIST));
    const { env, ctx, stored, settled } = fakeState();
    const read = openAiRangesReader();

    // Two requests at once: one fetch.
    await expect(
      Promise.all([read(env, ctx), read(env, ctx)])
    ).resolves.toStrictEqual([[], []]);
    await settled();

    expect(stored.ranges).toStrictEqual(OPENAI);
    await expect(read(env, ctx)).resolves.toStrictEqual(OPENAI);
    expect(fetched).toStrictEqual([OPENAI_RANGES_URL]);
  });

  it("are fetched again an hour after a fetch that failed, not on every request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });

    const fetched = stubFetch(
      () => new Response("Bad gateway", { status: 502 })
    );

    const logged = vi.spyOn(console, "error").mockReturnValue();
    const { env, ctx, settled } = fakeState();
    const read = openAiRangesReader();

    await read(env, ctx);
    await settled();
    await read(env, ctx);
    await settled();

    expect(fetched).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(
      `Could not fetch OpenAI's ranges: ${OPENAI_RANGES_URL} answered HTTP 502.`
    );

    vi.setSystemTime(Date.now() + 3_600_000);
    await read(env, ctx);
    await settled();

    expect(fetched).toHaveLength(2);
  });
});
