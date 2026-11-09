import { cap, finding, GOOGLE_DOCS } from "../rules/rule.js";
import type {
  AiBotAccess,
  AiBotPurpose,
  AiCrawlerReport,
  Finding,
  LlmsTxtInfo,
  RuleMeta,
} from "../types.js";
import { AI_BOTS, invalidSignals } from "./bots.js";

const LLMS_TXT_DOCS = "https://llmstxt.org/";
const CONTENT_SIGNALS_DOCS = "https://contentsignals.org/";

const meta = (
  id: string,
  severity: RuleMeta["severity"],
  description: string,
  recommendation: string,
  docs?: string,
  requires?: RuleMeta["requires"]
): RuleMeta => {
  const rule: RuleMeta = {
    id,
    category: "aeo",
    severity,
    description,
    recommendation,
  };

  if (docs) {
    rule.docs = docs;
  }

  if (requires) {
    rule.requires = requires;
  }

  return rule;
};

/** Rules about the site as a whole, which the AEO audit checks once per origin. */
export const AEO_SITE_RULES: RuleMeta[] = [
  meta(
    "aeo.robots-txt-unreachable",
    "warning",
    'robots.txt answers a server error or does not answer, and crawlers treat that as "crawl nothing" (RFC 9309).',
    "Make /robots.txt answer 200, or 404 when there is none. A 5xx or a timeout stops well-behaved crawlers, AI crawlers included.",
    GOOGLE_DOCS.robotsTxt
  ),
  meta(
    "aeo.robots-blocks-search-crawler",
    "error",
    "robots.txt blocks a search crawler whose index AI answers draw on: Googlebot (AI Overviews, AI Mode), Bingbot (Copilot) or Applebot (Siri, Spotlight).",
    "Allow these crawlers in robots.txt: remove the Disallow lines that match the audited pages in their groups, or in `User-agent: *` when they have no group of their own. Applebot follows the Googlebot group when no group names Applebot.",
    "https://developers.google.com/search/docs/appearance/ai-features"
  ),
  meta(
    "aeo.robots-blocks-answer-bot",
    "warning",
    "robots.txt blocks a bot that fetches pages for AI answers or an AI search index (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, DuckAssistBot, MistralAI-User).",
    "Allow the bots listed in evidence if the site should be cited in those answer engines: add a group for each with `Allow: /`, or remove the Disallow lines that match them. Keep a block that is deliberate, and disable this rule.",
    GOOGLE_DOCS.robotsTxt
  ),
  meta(
    "aeo.robots-blocks-training-bot",
    "info",
    "robots.txt blocks a crawler that collects text to train AI models (GPTBot, ClaudeBot, Applebot-Extended, CCBot, meta-externalagent).",
    "Nothing to change if you mean to opt out of model training: these bots do not decide whether answer engines cite the site. Allow them if you want the content in future models.",
    GOOGLE_DOCS.robotsTxt
  ),
  meta(
    "aeo.content-signal-blocks-answers",
    "warning",
    "A robots.txt Content-Signal line sets ai-input=no or search=no, asking answer engines not to use the pages in AI answers or search.",
    "Set ai-input=yes and search=yes in the Content-Signal line if answer engines should use the content; ai-train=no can stay to opt out of training. Example: `Content-Signal: search=yes, ai-input=yes, ai-train=no`.",
    CONTENT_SIGNALS_DOCS
  ),
  meta(
    "aeo.content-signal-invalid",
    "info",
    "A robots.txt Content-Signal line has a signal other than search, ai-input or ai-train, or a value other than yes or no.",
    "Write Content-Signal as comma-separated pairs of search, ai-input or ai-train with yes or no, e.g. `Content-Signal: search=yes, ai-input=yes, ai-train=no`.",
    CONTENT_SIGNALS_DOCS
  ),
  meta(
    "aeo.llms-txt-missing",
    "info",
    "The site has no /llms.txt.",
    "Optional: publish /llms.txt, a Markdown index of the pages that matter, for AI tools and coding agents that look for one. No major answer engine has said it reads llms.txt, so this is low priority.",
    LLMS_TXT_DOCS
  ),
  meta(
    "aeo.llms-txt-invalid",
    "warning",
    "/llms.txt exists but does not follow the llms.txt format, which requires an H1 title first.",
    "Start the file with `# Site name`, then an optional `> one-line summary`, then H2 sections with links written as `- [Title](https://...): note`.",
    LLMS_TXT_DOCS
  ),
  meta(
    "aeo.llms-txt-no-links",
    "info",
    "/llms.txt has no Markdown links, so it points AI tools to no pages.",
    "List the pages that matter under H2 sections, one per line: `- [Title](https://...): what it covers`.",
    LLMS_TXT_DOCS
  ),
  meta(
    "aeo.server-blocks-answer-bot",
    "warning",
    "The server refuses or challenges an AI answer bot's User-Agent (403, 429, a challenge page) while it serves the audit's own request.",
    "Allow these bots at the CDN, firewall or bot-protection layer (for example the CDN's AI crawler settings or a WAF rule). The probe sent the bots' User-Agent from this machine, not from the bots' own IP ranges, and a CDN that verifies bots may let the real ones through: confirm in the CDN's bot logs before changing rules.",
    undefined,
    "ai-bots"
  ),
  meta(
    "aeo.server-blocks-training-bot",
    "info",
    "The server refuses or challenges an AI training bot's User-Agent while it serves the audit's own request.",
    "Nothing to change if you mean to keep training bots out; this does not affect AI answers. The probe came from this machine, not the bots' own IP ranges.",
    undefined,
    "ai-bots"
  ),
  meta(
    "aeo.bot-probe-inconclusive",
    "info",
    "The AI bot probe could not run: the target is not a URL, or the audit's own request did not get the page.",
    "Probe a live URL, and make the audit's own request succeed first (status, auth headers, --user-agent); otherwise blocked bots cannot be told apart from a page that fails for everyone.",
    undefined,
    "ai-bots"
  ),
];

const byId = new Map(AEO_SITE_RULES.map((r) => [r.id, r]));

const m = (id: string): RuleMeta => {
  const rule = byId.get(id);

  if (!rule) {
    throw new Error(`Unknown AEO site rule: ${id}`);
  }

  return rule;
};

export interface AeoSiteContext {
  crawlers: AiCrawlerReport | null;
  llmsTxt: LlmsTxtInfo | null;
  /** Pages audited, for "blocked from N of M pages". */
  pageCount: number;
  /** Set when the caller asked for the bot probe but it could not run. */
  probeSkipped?: string;
}

const ROBOTS_RULES: Record<AiBotPurpose, string> = {
  search: "aeo.robots-blocks-search-crawler",
  answer: "aeo.robots-blocks-answer-bot",
  training: "aeo.robots-blocks-training-bot",
};

const SERVER_RULES: Partial<Record<AiBotPurpose, string>> = {
  answer: "aeo.server-blocks-answer-bot",
  training: "aeo.server-blocks-training-bot",
};

const docsFor = (name: string): string | undefined =>
  AI_BOTS.find((b) => b.name === name)?.docs;

const robotsFindings = (
  crawlers: AiCrawlerReport,
  pageCount: number
): Finding[] => {
  if (crawlers.status === "unreachable") {
    return [
      finding(
        m("aeo.robots-txt-unreachable"),
        `robots.txt at ${crawlers.robotsTxt} ${crawlers.httpStatus === null ? "did not answer" : `answers HTTP ${crawlers.httpStatus}`}, so crawlers that follow RFC 9309, AI crawlers included, treat the whole site as off limits.`,
        { evidence: { url: crawlers.robotsTxt, status: crawlers.httpStatus } }
      ),
    ];
  }

  const out: Finding[] = [];

  for (const purpose of ["search", "answer", "training"] as const) {
    const blocked = crawlers.bots.filter(
      (b) => b.purpose === purpose && (!b.allowed || b.blockedPages > 0)
    );

    if (!blocked.length) {
      continue;
    }

    const where = (b: AiBotAccess) =>
      b.allowed
        ? `${b.blockedPages} of ${pageCount} audited pages, which other crawlers may fetch`
        : "the audited page";

    out.push({
      ...finding(
        m(ROBOTS_RULES[purpose]),
        `robots.txt blocks ${blocked.map((b) => b.name).join(", ")}.`,
        {
          evidence: {
            robotsTxt: crawlers.robotsTxt,
            bots: cap(
              blocked.map((b) => ({
                name: b.name,
                operator: b.operator,
                usedFor: b.usedFor,
                blocked: pageCount > 1 ? where(b) : "the audited page",
                group: b.robotsGroup,
                docs: docsFor(b.name),
              })),
              20
            ),
          },
        }
      ),
      url: crawlers.robotsTxt,
    });
  }

  return out;
};

const signalFindings = (crawlers: AiCrawlerReport): Finding[] => {
  const out: Finding[] = [];

  const answerAgents = new Set(
    AI_BOTS.filter((b) => b.purpose !== "training").map((b) =>
      b.name.toLowerCase()
    )
  );

  const optOuts = crawlers.contentSignals.filter(
    (s) =>
      (s.signals["ai-input"] === "no" || s.signals["search"] === "no") &&
      s.userAgents.some(
        (a) =>
          a === "*" || answerAgents.has(a.split("/")[0]?.toLowerCase() ?? "")
      )
  );

  if (optOuts.length) {
    out.push({
      ...finding(
        m("aeo.content-signal-blocks-answers"),
        `robots.txt Content-Signal asks ${optOuts
          .map(
            (s) =>
              `${s.userAgents.join(", ") || "all crawlers"} for ${Object.entries(
                s.signals
              )
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}${s.path ? ` on ${s.path}` : ""}`
          )
          .join("; ")}.`,
        { evidence: { signals: cap(optOuts) } }
      ),
      url: crawlers.robotsTxt,
    });
  }

  const invalid = crawlers.contentSignals.flatMap(invalidSignals);

  if (invalid.length) {
    out.push({
      ...finding(
        m("aeo.content-signal-invalid"),
        `robots.txt Content-Signal has values the policy does not define: ${cap(invalid, 5).join(", ")}.`,
        { evidence: { values: cap(invalid) } }
      ),
      url: crawlers.robotsTxt,
    });
  }

  return out;
};

const llmsTxtFindings = (llms: LlmsTxtInfo): Finding[] => {
  const at = { url: llms.url };

  if (llms.status === "missing") {
    return [
      {
        ...finding(
          m("aeo.llms-txt-missing"),
          `No llms.txt at ${llms.url}${llms.httpStatus ? ` (HTTP ${llms.httpStatus})` : ""}.`
        ),
        ...at,
      },
    ];
  }

  if (llms.status === "invalid") {
    return [
      {
        ...finding(
          m("aeo.llms-txt-invalid"),
          `llms.txt does not follow the format: ${llms.problems.join("; ")}.`,
          { evidence: { problems: llms.problems, bytes: llms.bytes } }
        ),
        ...at,
      },
    ];
  }

  return llms.links === 0
    ? [
        {
          ...finding(
            m("aeo.llms-txt-no-links"),
            `llms.txt "${llms.title ?? ""}" has no Markdown links.`
          ),
          ...at,
        },
      ]
    : [];
};

const probeFindings = (crawlers: AiCrawlerReport): Finding[] => {
  const baseline = crawlers.probeBaseline;

  if (!baseline) {
    return [];
  }

  const out: Finding[] = [];

  for (const purpose of ["answer", "training"] as const) {
    const rule = SERVER_RULES[purpose];

    const blocked = crawlers.bots.filter(
      (b) => b.purpose === purpose && b.probe?.blocked
    );

    if (!rule || !blocked.length) {
      continue;
    }

    out.push(
      finding(
        m(rule),
        `The server refused or challenged ${blocked.map((b) => `${b.name} (${b.probe?.reason ?? "blocked"})`).join(", ")}, while the audit's own request got HTTP ${baseline.status}. The requests came from this machine with each bot's User-Agent, not from the bots' own IP ranges.`,
        {
          evidence: {
            baseline,
            bots: cap(
              blocked.map((b) => ({
                name: b.name,
                status: b.probe?.status ?? null,
                reason: b.probe?.reason ?? null,
              })),
              20
            ),
          },
        }
      )
    );
  }

  return out;
};

/** Findings about robots.txt, llms.txt and the bot probe, for the site the audited pages belong to. */
export const aeoSiteFindings = (ctx: AeoSiteContext): Finding[] => {
  const out: Finding[] = [];

  if (ctx.crawlers) {
    out.push(
      ...robotsFindings(ctx.crawlers, ctx.pageCount),
      ...signalFindings(ctx.crawlers),
      ...probeFindings(ctx.crawlers)
    );
  }

  if (ctx.llmsTxt) {
    out.push(...llmsTxtFindings(ctx.llmsTxt));
  }

  if (ctx.probeSkipped) {
    out.push(
      finding(
        m("aeo.bot-probe-inconclusive"),
        `The AI bot probe did not run: ${ctx.probeSkipped}.`
      )
    );
  }

  return out;
};
