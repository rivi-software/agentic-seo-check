import { agentMatcher } from "../robots.js";
import type {
  AiBotAccess,
  AiBotPurpose,
  AiCrawlerReport,
  ContentSignal,
  RobotsTxtInfo,
} from "../types.js";

export interface AiBot {
  /** The robots.txt product token. */
  name: string;
  operator: string;
  purpose: AiBotPurpose;
  usedFor: string;
  docs: string;
  /**
   * The User-Agent the probe sends. Absent for robots.txt-only tokens (Google-Extended), and for
   * search crawlers, which CDNs often block when the request does not come from the crawler's IPs.
   */
  userAgent?: string;
}

const OPENAI_DOCS = "https://developers.openai.com/api/docs/bots";

const ANTHROPIC_DOCS =
  "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler";

const PERPLEXITY_DOCS = "https://docs.perplexity.ai/guides/bots";

const GOOGLE_CRAWLERS_DOCS =
  "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers";

/**
 * The crawlers that decide whether a site can show up in AI answers, from the operators' own
 * documentation. Order: search crawlers, answer bots, training bots.
 */
export const AI_BOTS: AiBot[] = [
  {
    name: "Googlebot",
    operator: "Google",
    purpose: "search",
    usedFor: "Google Search, AI Overviews and AI Mode",
    docs: "https://developers.google.com/search/docs/appearance/ai-features",
  },
  {
    name: "Bingbot",
    operator: "Microsoft",
    purpose: "search",
    usedFor: "Bing search and Microsoft Copilot",
    docs: "https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a",
  },
  {
    name: "Applebot",
    operator: "Apple",
    purpose: "search",
    usedFor: "Siri, Spotlight and Safari search",
    docs: "https://support.apple.com/en-us/119829",
  },
  {
    name: "OAI-SearchBot",
    operator: "OpenAI",
    purpose: "answer",
    usedFor: "ChatGPT search results",
    docs: OPENAI_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot",
  },
  {
    name: "ChatGPT-User",
    operator: "OpenAI",
    purpose: "answer",
    usedFor: "pages ChatGPT fetches for a user; robots.txt may not apply",
    docs: OPENAI_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  },
  {
    name: "Claude-SearchBot",
    operator: "Anthropic",
    purpose: "answer",
    usedFor: "Claude's search results",
    docs: ANTHROPIC_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)",
  },
  {
    name: "Claude-User",
    operator: "Anthropic",
    purpose: "answer",
    usedFor: "pages Claude fetches for a user's question",
    docs: ANTHROPIC_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +https://www.anthropic.com)",
  },
  {
    name: "PerplexityBot",
    operator: "Perplexity",
    purpose: "answer",
    usedFor: "Perplexity search results",
    docs: PERPLEXITY_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  },
  {
    name: "Perplexity-User",
    operator: "Perplexity",
    purpose: "answer",
    usedFor: "pages Perplexity fetches for a user",
    docs: PERPLEXITY_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
  },
  {
    name: "Google-Extended",
    operator: "Google",
    purpose: "answer",
    usedFor:
      "Gemini Apps grounding and Gemini training, as a robots.txt token; not AI Overviews",
    docs: GOOGLE_CRAWLERS_DOCS,
  },
  {
    name: "DuckAssistBot",
    operator: "DuckDuckGo",
    purpose: "answer",
    usedFor: "DuckDuckGo's AI-assisted answers",
    docs: "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot",
    userAgent: "DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)",
  },
  {
    name: "MistralAI-User",
    operator: "Mistral AI",
    purpose: "answer",
    usedFor: "pages Le Chat fetches for a user",
    docs: "https://docs.mistral.ai/robots",
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)",
  },
  {
    name: "GPTBot",
    operator: "OpenAI",
    purpose: "training",
    usedFor: "training OpenAI's models",
    docs: OPENAI_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot",
  },
  {
    name: "ClaudeBot",
    operator: "Anthropic",
    purpose: "training",
    usedFor: "training Anthropic's models",
    docs: ANTHROPIC_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  },
  {
    name: "Applebot-Extended",
    operator: "Apple",
    purpose: "training",
    usedFor: "training Apple's models, as a robots.txt token",
    docs: "https://support.apple.com/en-us/119829",
  },
  {
    name: "CCBot",
    operator: "Common Crawl",
    purpose: "training",
    usedFor: "Common Crawl's archive, which many models train on",
    docs: "https://commoncrawl.org/ccbot",
    userAgent: "CCBot/2.0 (https://commoncrawl.org/faq/)",
  },
  {
    name: "meta-externalagent",
    operator: "Meta",
    purpose: "training",
    usedFor: "training Meta's AI models and indexing for Meta products",
    docs: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
    userAgent:
      "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  },
];

/** The policy token of the shared AI training preference (draft-kelley-aipref-training-preference-signal). */
export const TRAINING_PREFERENCE_TOKEN = "__usage_ai-training";

/** Signals the Content Signals Policy defines, plus Cloudflare's experimental `use`. */
const KNOWN_SIGNALS = new Set(["search", "ai-input", "ai-train", "use"]);

/** How robots.txt groups match product tokens: lower-cased, without a version. */
const productToken = (agent: string): string =>
  agent.split("/")[0]?.trim().toLowerCase() ?? "";

interface RobotsLine {
  /** User agents of the group the line belongs to, as written. */
  agents: string[];
  key: string;
  value: string;
}

/** The groups of a robots.txt file: every user agent it names, and each rule line with its group. */
const readGroups = (text: string) => {
  const named = new Set<string>();
  const lines: RobotsLine[] = [];
  let agents: string[] = [];
  let inAgentRun = false;

  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(":");

    if (colon === -1) {
      continue;
    }

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      // Consecutive user-agent lines share one group; a rule line in between starts a new one.
      if (!inAgentRun) {
        agents = [];
      }

      if (value) {
        agents.push(value);
        named.add(productToken(value));
      }

      inAgentRun = true;
      continue;
    }

    inAgentRun = false;
    lines.push({ agents, key, value });
  }

  return { named, lines };
};

/**
 * Content-Signal lines: `Content-Signal: search=yes, ai-input=no` or, for one path,
 * `Content-Signal: /blog/ ai-train=no`.
 */
export const contentSignals = (text: string): ContentSignal[] =>
  readGroups(text)
    .lines.filter((l) => l.key === "content-signal" && l.value)
    .slice(0, 50)
    .map((l) => {
      let rest = l.value;
      let path: string | null = null;

      if (rest.startsWith("/")) {
        const space = rest.search(/\s/u);
        path = space === -1 ? rest : rest.slice(0, space);
        rest = space === -1 ? "" : rest.slice(space + 1);
      }

      const signals: Record<string, string> = {};

      for (const pair of rest.split(",")) {
        const eq = pair.indexOf("=");

        const name = (eq === -1 ? pair : pair.slice(0, eq))
          .trim()
          .toLowerCase();

        if (name) {
          signals[name] =
            eq === -1
              ? ""
              : pair
                  .slice(eq + 1)
                  .trim()
                  .toLowerCase();
        }
      }

      return { userAgents: l.agents, path, signals };
    });

/** Signals in a Content-Signal line that the policy does not define, or values other than yes and no. */
export const invalidSignals = (signal: ContentSignal): string[] =>
  Object.entries(signal.signals).flatMap(([name, value]) => {
    if (!KNOWN_SIGNALS.has(name)) {
      return [`${name}=${value}`];
    }

    return name !== "use" && value !== "yes" && value !== "no"
      ? [`${name}=${value}`]
      : [];
  });

/**
 * robots.txt as RFC 9309 has crawlers read it: a file is "found" with status 200, "missing" with a
 * 4xx (crawl everything), "unreachable" with a 5xx or no answer (crawl nothing).
 */
const robotsStatus = (robots: RobotsTxtInfo): AiCrawlerReport["status"] => {
  if (robots.found) {
    return "found";
  }

  if (robots.status === null || robots.status >= 500) {
    return "unreachable";
  }

  return "missing";
};

/** What robots.txt lets each AI bot do on the audited pages; `startUrl` is the page the summary describes. */
export const crawlerAccess = (
  robots: RobotsTxtInfo,
  text: string | null,
  startUrl: string,
  pageUrls: string[]
): AiCrawlerReport => {
  const status = robotsStatus(robots);
  const found = status === "found" && text !== null;
  const groups = found ? readGroups(text) : null;
  const allows = found ? agentMatcher(robots.url, text) : null;
  const urls = pageUrls.length ? pageUrls : [startUrl];

  const bots = AI_BOTS.map((bot): AiBotAccess => {
    const token = productToken(bot.name);
    let robotsGroup: AiBotAccess["robotsGroup"] = "none";

    if (groups?.named.has(token)) {
      robotsGroup = "named";
    } else if (groups?.named.has("*")) {
      robotsGroup = "wildcard";
    }

    if (status === "unreachable") {
      return {
        name: bot.name,
        operator: bot.operator,
        purpose: bot.purpose,
        usedFor: bot.usedFor,
        robotsGroup,
        allowed: false,
        blockedPages: urls.length,
      };
    }

    return {
      name: bot.name,
      operator: bot.operator,
      purpose: bot.purpose,
      usedFor: bot.usedFor,
      robotsGroup,
      allowed: allows ? allows(startUrl, bot.name) : true,
      blockedPages: allows
        ? urls.filter((u) => !allows(u, bot.name)).length
        : 0,
    };
  });

  let trainingPreference: AiCrawlerReport["trainingPreference"] = "none";

  // `User-agent: *` never speaks for the policy token, so only a group that names it counts.
  if (allows && groups?.named.has(TRAINING_PREFERENCE_TOKEN)) {
    trainingPreference = allows(startUrl, TRAINING_PREFERENCE_TOKEN)
      ? "allowed"
      : "disallowed";
  }

  return {
    robotsTxt: robots.url,
    status,
    httpStatus: robots.status,
    trainingPreference,
    contentSignals: found ? contentSignals(text) : [],
    bots,
  };
};
