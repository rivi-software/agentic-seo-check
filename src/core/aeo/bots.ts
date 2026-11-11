import { agentMatcher, ruleLineMatcher } from "../robots.js";
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
  /**
   * Other robots.txt tokens the operator reads as this bot (YandexAdditionalBot for
   * YandexAdditional). A group for any of them counts as the bot's own, and each one that blocks
   * a page keeps the bot from it.
   */
  aliases?: string[];
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

const AMAZON_DOCS = "https://developer.amazon.com/amazonbot";

const META_DOCS =
  "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers";

const MISTRAL_DOCS = "https://docs.mistral.ai/robots";

/**
 * Amazon's User-Agents end in `Chrome/W.X.Y.Z Safari/537.36`, a placeholder for the Chrome build
 * they run; the probe sends a real Chrome version in its place, as the bots do.
 */
const amazonUserAgent = (token: string): string =>
  `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${token}/0.1) Chrome/157.0.8103.39 Safari/537.36`;

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
      "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  },
  {
    name: "Perplexity-User",
    operator: "Perplexity",
    purpose: "answer",
    usedFor: "pages Perplexity fetches for a user; robots.txt may not apply",
    docs: PERPLEXITY_DOCS,
    userAgent:
      "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
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
    usedFor: "pages Vibe fetches for a user",
    docs: MISTRAL_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)",
  },
  {
    name: "Amzn-SearchBot",
    operator: "Amazon",
    purpose: "answer",
    usedFor: "search experiences in Amazon products, such as Alexa",
    docs: AMAZON_DOCS,
    userAgent: amazonUserAgent("Amzn-SearchBot"),
  },
  {
    name: "Amzn-User",
    operator: "Amazon",
    purpose: "answer",
    usedFor:
      "pages Alexa fetches for a user's question; robots.txt may not apply",
    docs: AMAZON_DOCS,
    userAgent: amazonUserAgent("Amzn-User"),
  },
  {
    name: "meta-webindexer",
    operator: "Meta",
    purpose: "answer",
    usedFor: "Meta AI search, to cite and link sources",
    docs: META_DOCS,
    userAgent:
      "meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  },
  {
    name: "meta-externalfetcher",
    operator: "Meta",
    purpose: "answer",
    usedFor:
      "links Meta AI fetches for a user, agents included; robots.txt may not apply",
    docs: META_DOCS,
    userAgent:
      "meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  },
  {
    name: "MistralAI-Index",
    operator: "Mistral AI",
    purpose: "answer",
    usedFor: "the Mistral search index behind Vibe's answers",
    docs: MISTRAL_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-Index/1.0; +https://docs.mistral.ai/robots)",
  },
  {
    // Yandex reads either name; its own example writes the second.
    name: "YandexAdditional",
    aliases: ["YandexAdditionalBot"],
    operator: "Yandex",
    purpose: "answer",
    usedFor:
      "Yandex AI answers in search, as a robots.txt token (or YandexAdditionalBot)",
    docs: "https://yandex.com/support/webmaster/en/yandex-ai",
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
    docs: META_DOCS,
    userAgent:
      "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  },
  {
    name: "Amazonbot",
    operator: "Amazon",
    purpose: "training",
    usedFor: "improving Amazon's products; may train Amazon AI models",
    docs: AMAZON_DOCS,
    userAgent: amazonUserAgent("Amazonbot"),
  },
  {
    name: "MistralAI-Training",
    operator: "Mistral AI",
    purpose: "training",
    usedFor: "training Mistral's models",
    docs: MISTRAL_DOCS,
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-Training/1.0; +https://docs.mistral.ai/robots)",
  },
];

/** The policy token of the shared AI training preference (draft-kelley-aipref-training-preference-signal). */
export const TRAINING_PREFERENCE_TOKEN = "__usage_ai-training";

/** Signals the Content Signals Policy defines, plus Cloudflare's experimental `use`. */
const KNOWN_SIGNALS = new Set(["search", "ai-input", "ai-train", "use"]);

/** How robots.txt groups match product tokens: lower-cased, without a version. */
const productToken = (agent: string): string =>
  agent.split("/")[0]?.trim().toLowerCase() ?? "";

/** The names robots.txt may give a bot: its token and its aliases, as written. */
const namesOf = (bot: AiBot): string[] => [bot.name, ...(bot.aliases ?? [])];

/** The product tokens a robots.txt group may name an AI bot by, lower-cased: its own and its aliases. */
export const botTokens = (name: string): string[] => {
  const bot = AI_BOTS.find((b) => b.name === name);

  return (bot ? namesOf(bot) : [name]).map(productToken);
};

/** A group's user-agent lines as the file writes them, with any comment or blank lines between. */
export interface AgentRun {
  /** Each line as written, and the product token it names (null for a comment or blank line). */
  lines: { text: string; token: string | null }[];
  /** The file's line break, to quote the run as one piece. */
  eol: string;
}

interface RobotsLine {
  /** User agents of the group the line belongs to, as written. */
  agents: string[];
  /** The group's user-agent lines as written; lines of one group share this array. */
  agentLines: string[];
  /** The same lines as the file writes them; lines of one group share it too. */
  run: AgentRun;
  key: string;
  value: string;
  /** The line as written, without its comment: what a fix quotes. */
  raw: string;
  /** Its line number in the file, counted from 1 as robots-parser counts. */
  number: number;
}

/** The groups of a robots.txt file: every user agent it names, and each rule line with its group. */
const readGroups = (text: string) => {
  const named = new Set<string>();
  const lines: RobotsLine[] = [];
  let agents: string[] = [];
  let agentLines: string[] = [];
  let inAgentRun = false;
  // The first line break the file uses, to quote a run of lines as it is written.
  const eol = /\r\n|\r|\n/u.exec(text)?.[0] ?? "\n";
  let run: AgentRun = { lines: [], eol };

  // Comment and blank lines after a user-agent line: part of the run if another one follows.
  let between: AgentRun["lines"] = [];

  for (const [index, raw] of text.split(/\r\n|\r|\n/u).entries()) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(":");

    if (colon === -1) {
      if (inAgentRun) {
        between.push({ text: raw, token: null });
      }

      continue;
    }

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      // Consecutive user-agent lines share one group; a rule line in between starts a new one.
      if (!inAgentRun) {
        agents = [];
        agentLines = [];
        run = { lines: [], eol };
        between = [];
      }

      run.lines.push(...between, {
        text: raw,
        token: value ? productToken(value) : null,
      });
      between = [];

      if (value) {
        agents.push(value);
        agentLines.push(line);
        named.add(productToken(value));
      }

      inAgentRun = true;
      continue;
    }

    inAgentRun = false;
    between = [];
    lines.push({
      agents,
      agentLines,
      run,
      key,
      value,
      raw: line,
      number: index + 1,
    });
  }

  return { named, lines };
};

/** Where a Content-Signal line sits in robots.txt, for a fix that rewrites it. */
export interface SignalSource {
  /** The line as written, without its comment. */
  raw: string;
  /** The first user-agent line of its group, as written. */
  group: string | null;
}

const signalSources = new WeakMap<ContentSignal, SignalSource>();

/** The robots.txt line a Content-Signal entry was read from, when `contentSignals` read it. */
export const signalSourceOf = (
  signal: ContentSignal
): SignalSource | undefined => signalSources.get(signal);

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

      const signal: ContentSignal = { userAgents: l.agents, path, signals };
      signalSources.set(signal, { raw: l.raw, group: l.agentLines[0] ?? null });

      return signal;
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

/** `%xx` escapes in upper case, as robots-parser compares them. */
const upperEscapes = (text: string): string =>
  text.replaceAll(/%[\da-f]{2}/giu, (m) => m.toUpperCase());

/**
 * A pattern percent-encoded the way robots-parser reads it, so `Disallow: /blog/café` matches
 * `/blog/caf%C3%A9` here as it does when robots-parser decides the bot is blocked.
 */
const encodedPattern = (pattern: string): string => {
  try {
    return upperEscapes(encodeURI(pattern).replaceAll("%25", "%"));
  } catch {
    // encodeURI throws on a lone surrogate; robots-parser then keeps the pattern as written.
    return pattern;
  }
};

/**
 * Whether a robots.txt path pattern matches `path` (path and query): `*` stands for any characters
 * and a final `$` anchors the end. Both sides are percent-encoded as robots-parser encodes them.
 * Each piece between stars is found with indexOf, left to right, so a pattern of many stars costs
 * one pass over the path, never a backtracking search.
 */
export const pathMatches = (rawPattern: string, rawPath: string): boolean => {
  const pattern = encodedPattern(rawPattern);
  const path = upperEscapes(rawPath);
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const [first = "", ...rest] = parts;

  if (!path.startsWith(first)) {
    return false;
  }

  let pos = first.length;

  for (const [i, part] of rest.entries()) {
    if (anchored && i === rest.length - 1) {
      return path.length - part.length >= pos && path.endsWith(part);
    }

    const at = path.indexOf(part, pos);

    if (at === -1) {
      return false;
    }

    pos = at + part.length;
  }

  return !anchored || pos === path.length;
};

/** A rule line of robots.txt, with the group it is in. */
export interface RobotsRuleLine {
  /** The line as written, without its comment. */
  raw: string;
  /** The group's user-agent lines as written. */
  agentLines: string[];
  /** The group's user-agent lines as the file writes them, comments and blank lines between included. */
  run: AgentRun;
  /** The product tokens of the group's user agents, lower-cased. */
  tokens: string[];
}

/** How robots.txt keeps one bot from the audited pages, for a fix that lets it in. */
export interface RobotsBlock {
  /** The group the bot follows: its own, Googlebot's (Applebot without a group) or `User-agent: *`. */
  group: "named" | "googlebot" | "wildcard";
  /** Disallow lines of that group that match a page the bot is kept from. */
  blocking: RobotsRuleLine[];
  /** The Allow, Disallow and Content-Signal lines of that group, which a new group for the bot copies. */
  rules: RobotsRuleLine[];
}

const robotsBlocks = new WeakMap<AiCrawlerReport, Map<string, RobotsBlock>>();

/** For each bot robots.txt keeps out, the lines that do it; set by `crawlerAccess`. */
export const robotsBlocksOf = (
  report: AiCrawlerReport
): ReadonlyMap<string, RobotsBlock> | undefined => robotsBlocks.get(report);

const pathOf = (url: string): string | null => {
  try {
    const u = new URL(url);

    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
};

const ruleLine = (l: RobotsLine): RobotsRuleLine => ({
  raw: l.raw,
  agentLines: l.agentLines,
  run: l.run,
  tokens: l.agents.map(productToken),
});

/** Whether every group in `agents` lets its bot fetch `url`: one that blocks it keeps the bot out. */
const allowsAll = (
  allows: (target: string, agent: string) => boolean,
  url: string,
  agents: string[]
): boolean => agents.every((a) => allows(url, a));

/** The lines a group of its own for a bot keeps from the group it followed. */
const COPIED_KEYS = new Set(["allow", "disallow", "content-signal"]);

/**
 * The lines of the groups a bot follows (`agents`: its own names, `Googlebot` or `*`) that keep it
 * from `blocked`, and the groups' other rules. `lineOf` gives the line robots-parser blocked each
 * URL with, for a pattern `pathMatches` misses.
 */
const blockOf = (
  lines: RobotsLine[],
  agents: string[],
  group: RobotsBlock["group"],
  blocked: string[],
  lineOf: (url: string) => number
): RobotsBlock => {
  const tokens = new Set(agents.map(productToken));

  // One object per line, so `blocking` holds the very lines `rules` lists.
  const own = lines.flatMap((l) =>
    l.agents.some((a) => tokens.has(productToken(a)))
      ? [{ line: l, rule: ruleLine(l) }]
      : []
  );

  const paths = blocked.flatMap((u) => pathOf(u) ?? []);

  const disallows = own.filter(
    ({ line }) => line.key === "disallow" && line.value !== ""
  );

  let blocking = disallows.filter(({ line }) =>
    paths.some((p) => pathMatches(line.value, p))
  );

  // Without the blocking line a fix would add a group of its own that cannot lift the block.
  if (!blocking.length) {
    const numbers = new Set(blocked.map(lineOf));
    blocking = disallows.filter(({ line }) => numbers.has(line.number));
  }

  return {
    group,
    blocking: blocking.map(({ rule }) => rule),
    rules: own.flatMap(({ line, rule }) =>
      COPIED_KEYS.has(line.key) ? [rule] : []
    ),
  };
};

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
  const lineOf = found ? ruleLineMatcher(robots.url, text) : null;
  const urls = pageUrls.length ? pageUrls : [startUrl];

  // The user agents whose groups each bot follows: its names robots.txt has a group for (a page is
  // blocked when any of them blocks it), `Googlebot` for Applebot, or `*`.
  const agentsOf = new Map<string, string[]>();

  const bots = AI_BOTS.map((bot): AiBotAccess => {
    const named = namesOf(bot).filter((n) =>
      groups?.named.has(productToken(n))
    );

    let robotsGroup: AiBotAccess["robotsGroup"] = "none";
    let agents = [bot.name];

    if (named.length) {
      robotsGroup = "named";
      agents = named;
    } else if (bot.name === "Applebot" && groups?.named.has("googlebot")) {
      // Apple: without an Applebot group, Applebot follows the Googlebot group.
      robotsGroup = "googlebot";
      agents = ["Googlebot"];
    } else if (groups?.named.has("*")) {
      robotsGroup = "wildcard";
      agents = ["*"];
    }

    agentsOf.set(bot.name, agents);

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
      allowed: allows ? allowsAll(allows, startUrl, agents) : true,
      // A path `User-agent: *` keeps every crawler from is a site-wide choice, which the SEO
      // audit reports; only a page this bot may not fetch while other crawlers may counts here.
      blockedPages: allows
        ? urls.filter((u) => !allowsAll(allows, u, agents) && allows(u, "*"))
            .length
        : 0,
    };
  });

  const blocks = new Map<string, RobotsBlock>();

  if (allows && groups) {
    for (const bot of bots) {
      const agents = agentsOf.get(bot.name);

      if (bot.robotsGroup === "none" || !agents) {
        continue;
      }

      // The pages the AEO rules report this bot blocked on: the start page, and pages only it is kept from.
      const blocked = [
        ...(bot.allowed ? [] : [startUrl]),
        ...urls.filter((u) => !allowsAll(allows, u, agents) && allows(u, "*")),
      ];

      if (blocked.length) {
        blocks.set(
          bot.name,
          blockOf(groups.lines, agents, bot.robotsGroup, blocked, (u) => {
            const agent = agents.find((a) => !allows(u, a)) ?? bot.name;

            return lineOf ? lineOf(u, agent) : -1;
          })
        );
      }
    }
  }

  let trainingPreference: AiCrawlerReport["trainingPreference"] = "none";

  // `User-agent: *` never speaks for the policy token, so only a group that names it counts.
  if (allows && groups?.named.has(TRAINING_PREFERENCE_TOKEN)) {
    trainingPreference = allows(startUrl, TRAINING_PREFERENCE_TOKEN)
      ? "allowed"
      : "disallowed";
  }

  const report: AiCrawlerReport = {
    robotsTxt: robots.url,
    status,
    httpStatus: robots.status,
    trainingPreference,
    contentSignals: found ? contentSignals(text) : [],
    bots,
  };

  robotsBlocks.set(report, blocks);

  return report;
};
