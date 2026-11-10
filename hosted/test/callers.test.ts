import { describe, expect, it } from "vitest";

import {
  callerOf,
  inRange,
  parseAddress,
  parseOpenAiRanges,
} from "../src/callers.ts";

const OPENAI = ["104.210.139.192/28", "2603:1030:0:1::/64"];

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
