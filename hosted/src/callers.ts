/**
 * Who is calling: a platform that calls remote MCP servers for all its users from its own
 * addresses (claude.ai, ChatGPT), which counts as one caller with ten times the limits, or one IP
 * address (an IPv6 caller by its /64, the block one home or server gets).
 */
import { z } from "zod";

import type { ReportTask } from "./analytics.js";
import { globalState } from "./state.js";
import type { StateEnv } from "./state.js";

/**
 * Anthropic's outbound addresses, from which claude.ai, Cowork and the Claude apps call remote MCP
 * servers. They change only with notice (platform.claude.com/docs/en/api/ip-addresses).
 */
export const ANTHROPIC_RANGES = ["160.79.104.0/21", "153.61.208.0/20"];

/** OpenAI's list of ChatGPT connector addresses, which it asks users of it to fetch regularly. */
export const OPENAI_RANGES_URL = "https://openai.com/chatgpt-connectors.json";

/** The list as OpenAI publishes it: `{ creationTime, prefixes: [{ ipv4Prefix | ipv6Prefix }] }`. */
const OpenAiRanges = z.object({
  prefixes: z.array(
    z.object({
      ipv4Prefix: z.string().optional(),
      ipv6Prefix: z.string().optional(),
    })
  ),
});

/** The ranges in OpenAI's list, from the file's text; throws when it is not the list. */
export const parseOpenAiRanges = (text: string): string[] =>
  OpenAiRanges.parse(JSON.parse(text)).prefixes.flatMap((p) =>
    [p.ipv4Prefix, p.ipv6Prefix].filter((r) => r !== undefined)
  );

/** Where every isolate finds OpenAI's ranges: the HostedState Durable Object (state.ts). */
export interface RangesStore {
  openAiRanges: () => Promise<string[]>;
  setOpenAiRanges: (ranges: string[]) => Promise<void>;
}

export type RangesEnv = StateEnv<RangesStore>;

/**
 * Fetches OpenAI's list and keeps it for every isolate. Answers the ranges it kept, and none for a
 * list that came back empty.
 */
export const refreshOpenAiRanges = async (
  env: RangesEnv
): Promise<string[]> => {
  const res = await fetch(OPENAI_RANGES_URL);

  if (!res.ok) {
    throw new Error(`${OPENAI_RANGES_URL} answered HTTP ${res.status}.`);
  }

  const ranges = parseOpenAiRanges(await res.text());

  // An empty list is a broken file, not a ChatGPT without addresses: keep the last one.
  if (ranges.length > 0) {
    await globalState(env).setOpenAiRanges(ranges);
  }

  return ranges;
};

/** How long an isolate uses the ranges it read before it asks the Durable Object again. */
const RANGES_FOR_MS = 3_600_000;

/**
 * OpenAI's ranges as one isolate reads them: from the Durable Object at most once an hour. An
 * object without ranges, as a new one is until the Cron Trigger's first run at 03:17 UTC, gets them
 * fetched once, after the answer, rather than count ChatGPT's calls as calls from addresses until
 * then. The empty list is kept for the hour as any other, so a fetch that fails waits an hour
 * before the next. A fetch that fails is logged, and `report` hears it (issue #93).
 */
export const openAiRangesReader = (): ((
  env: RangesEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  report?: ReportTask
) => Promise<string[]>) => {
  let kept: { ranges: string[]; readAt: number } | null = null;
  let fetching = false;

  /** Fetches the list for an object that has none, and uses it here from then on. */
  const fetchMissing = async (
    env: RangesEnv,
    report: ReportTask | undefined
  ): Promise<void> => {
    fetching = true;

    try {
      const ranges = await refreshOpenAiRanges(env);

      if (ranges.length > 0) {
        kept = { ranges, readAt: Date.now() };
      }
    } catch (error) {
      console.error(
        `Could not fetch OpenAI's ranges: ${error instanceof Error ? error.message : String(error)}`
      );
      report?.(error, "openai_ranges");
    } finally {
      fetching = false;
    }
  };

  return async (env, ctx, report) => {
    if (kept && Date.now() - kept.readAt < RANGES_FOR_MS) {
      return kept.ranges;
    }

    const ranges = await globalState(env).openAiRanges();
    kept = { ranges, readAt: Date.now() };

    if (ranges.length === 0 && !fetching) {
      ctx.waitUntil(fetchMissing(env, report));
    }

    return ranges;
  };
};

/** 2 to the power of `bits`: what shifting a number that many bits multiplies or divides it by. */
const shift = (bits: number | bigint): bigint => 2n ** BigInt(bits);

/** An address as its bits: 32 for IPv4, 128 for IPv6; null when it is neither. */
interface Address {
  bits: 32 | 128;
  value: bigint;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

const parseIpv4 = (ip: string): bigint | null => {
  if (!IPV4.test(ip)) {
    return null;
  }

  const octets = ip.split(".").map(Number);

  if (octets.some((o) => o > 255)) {
    return null;
  }

  return octets.reduce((value, o) => value * shift(8) + BigInt(o), 0n);
};

/** The eight groups of an IPv6 address, `::` expanded and an IPv4 tail ("::ffff:1.2.3.4") split. */
const ipv6Groups = (ip: string): string[] | null => {
  const tail = /(?<v4>(?:\d{1,3}\.){3}\d{1,3})$/u.exec(ip)?.groups?.v4;
  let text = ip;

  if (tail) {
    const v4 = parseIpv4(tail);

    if (v4 === null) {
      return null;
    }

    text = `${ip.slice(0, -tail.length)}${(v4 / shift(16)).toString(16)}:${(v4 % shift(16)).toString(16)}`;
  }

  const halves = text.split("::");

  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;

  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }

  return [...head, ...Array.from({ length: missing }, () => "0"), ...rest];
};

const parseIpv6 = (ip: string): bigint | null => {
  const groups = ipv6Groups(ip);

  if (!groups || groups.some((g) => !/^[\da-f]{1,4}$/iu.test(g))) {
    return null;
  }

  return groups.reduce((value, g) => value * shift(16) + BigInt(`0x${g}`), 0n);
};

export const parseAddress = (ip: string): Address | null => {
  const v4 = parseIpv4(ip);

  if (v4 !== null) {
    return { bits: 32, value: v4 };
  }

  const v6 = ip.includes(":") ? parseIpv6(ip) : null;

  return v6 === null ? null : { bits: 128, value: v6 };
};

/** Whether `ip` lies in `range`, written as an address and a prefix length ("160.79.104.0/21"). */
export const inRange = (ip: Address, range: string): boolean => {
  const [base = "", length = ""] = range.split("/");
  const network = parseAddress(base);
  const prefix = Number(length);

  if (
    !network ||
    network.bits !== ip.bits ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > ip.bits
  ) {
    return false;
  }

  const host = shift(ip.bits - prefix);

  return ip.value / host === network.value / host;
};

export interface Caller {
  /** The key the limits count under. */
  key: string;
  /** The platform the call comes from, which has its own, larger limits. */
  platform: "anthropic" | "openai" | null;
}

/**
 * The caller of a request from `ip` (CF-Connecting-IP), given OpenAI's current ranges. A request
 * without an address, which Cloudflare always sets, counts as one unknown caller.
 */
export const callerOf = (ip: string | null, openAiRanges: string[]): Caller => {
  const address = ip ? parseAddress(ip) : null;

  if (!address) {
    return { key: "ip:unknown", platform: null };
  }

  if (ANTHROPIC_RANGES.some((r) => inRange(address, r))) {
    return { key: "platform:anthropic", platform: "anthropic" };
  }

  if (openAiRanges.some((r) => inRange(address, r))) {
    return { key: "platform:openai", platform: "openai" };
  }

  if (address.bits === 128) {
    const block = (address.value / shift(64)).toString(16).padStart(16, "0");

    return { key: `ip6:${block}`, platform: null };
  }

  return { key: `ip:${ip}`, platform: null };
};
