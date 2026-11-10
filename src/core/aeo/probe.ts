import { mapConcurrent } from "../concurrency.js";
import { fetchPage } from "../fetch.js";
import type { FetchOptions, FetchResult } from "../fetch.js";
import type { BotProbe } from "../types.js";
import type { AiBot } from "./bots.js";

/** Titles of the interstitials CDNs and bot protection show instead of the page. */
const CHALLENGE_TITLE =
  /^(?:just a moment|attention required|access denied|request blocked|verifying you are human|pardon our interruption)/iu;

/**
 * The page title, enough to recognise a challenge page. `[^<>]` stops each attempt at the next
 * bracket, which keeps the scan linear on a body full of "<title" without ">".
 */
const TITLE = /<title[^<>]*>(?<title>[^<]{0,200})/iu;

/** The title of the interstitial a CDN or bot protection shows instead of the page, or null. */
export const challengeTitle = (body: string): string | null => {
  const title = TITLE.exec(body)?.groups?.title?.trim() ?? "";

  return CHALLENGE_TITLE.test(title) ? title : null;
};

/** What one bot's request says about access, given that the audit's own request got the page. */
export const classifyProbe = (res: FetchResult): BotProbe => {
  if (res.error) {
    return {
      status: res.status,
      blocked: true,
      reason: `connection failed: ${res.error}`,
    };
  }

  if (res.status !== null && res.status >= 400) {
    return { status: res.status, blocked: true, reason: `HTTP ${res.status}` };
  }

  const title = challengeTitle(res.body ?? "");

  if (title !== null) {
    return {
      status: res.status,
      blocked: true,
      reason: `challenge page ("${title}")`,
    };
  }

  return { status: res.status, blocked: false, reason: null };
};

/**
 * Requests `url` once per bot with the bot's User-Agent, to catch a CDN or firewall that refuses
 * AI bots while robots.txt allows them. The requests come from this machine, not the bots' IPs.
 */
export const probeBots = async (
  url: string,
  bots: AiBot[],
  options: FetchOptions = {}
): Promise<Map<string, BotProbe>> => {
  const probes = new Map<string, BotProbe>();

  await mapConcurrent(bots, 3, async (bot) => {
    if (!bot.userAgent) {
      return;
    }

    const res = await fetchPage(url, {
      ...options,
      userAgent: bot.userAgent,
      timeoutMs: Math.min(options.timeoutMs ?? 15_000, 15_000),
      // Enough for the <title> of a challenge page.
      maxBodyBytes: 100_000,
    });

    probes.set(bot.name, classifyProbe(res));
  });

  return probes;
};
