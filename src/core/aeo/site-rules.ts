import { addEdit, removeEdit, replaceEdit, slot } from "../rules/fix.js";
import { cap, finding, GOOGLE_DOCS } from "../rules/rule.js";
import type {
  AiBotAccess,
  AiBotPurpose,
  AiCrawlerReport,
  ContentSignal,
  Finding,
  FixEdit,
  LlmsTxtInfo,
  RuleMeta,
} from "../types.js";
import {
  AI_BOTS,
  invalidSignals,
  robotsBlocksOf,
  signalSourceOf,
} from "./bots.js";
import type { RobotsBlock, RobotsRuleLine } from "./bots.js";
import { statusLine } from "./fixes.js";

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
    "aeo.crawl-stopped",
    "info",
    "The hosted server stopped requesting the site before the crawl was done: the site refused its requests (a challenge, HTTP 429), or the server reached its request limit for the site. The audit covers the pages it read.",
    "Crawl again in a minute, or with the local server or the CLI, which send the requests from your machine: npx -y @rivi-software/agentic-seo-check mcp."
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
  /** The audited pages, which a fix for a missing or empty llms.txt lists. */
  pages?: { url: string; title: string | null }[];
  /** Pages audited, for "blocked from N of M pages". */
  pageCount: number;
  /** Set when the caller asked for the bot probe but it could not run. */
  probeSkipped?: string;
  /** Why the crawl stopped requesting the site before it was done (the hosted server's gate). */
  crawlStopped?: string;
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

/* ---------------------------------------------------------------------------
 * Fixes
 * ------------------------------------------------------------------------- */

const ROBOTS_WRITE: Record<AiBotPurpose, string> = {
  search:
    "These crawlers feed the search indexes AI Overviews, AI Mode, Copilot and Siri answer from. Keep a block only on a site that should stay out of search altogether.",
  answer:
    "Apply this if the site should be cited in these answer engines. A deliberate block can stay: then disable this rule. Google-Extended covers both Gemini training and Gemini Apps grounding; there is no token for one without the other.",
  training:
    "Blocking AI training bots is the site owner's choice and does not keep the site out of AI answers. Apply this only if the owner wants the content used to train models; otherwise keep the block and disable this rule.",
};

/** The product token of a user agent: lower-cased, without a version. */
const tokenOf = (agent: string): string =>
  agent.split("/")[0]?.trim().toLowerCase() ?? "";

/** The user-agent lines and rules of a group of its own for some bots. */
interface NewGroup {
  agents: string[];
  rules: string[];
}

/** The rules a group of its own for a bot keeps: the group it followed, without the lines that block it. */
const keptRules = (block: RobotsBlock, from: RobotsRuleLine[]): string[] => {
  const kept = from.flatMap((r) => (block.blocking.includes(r) ? [] : [r.raw]));

  return kept.length ? kept : ["Allow: /"];
};

/**
 * Edits for a bot in a group of its own: the Disallow lines that block it go. When that would
 * leave the group empty its first blocking line becomes `Allow: /`, so the user-agent line cannot
 * join the next group.
 */
const ownGroupEdits = (
  block: RobotsBlock,
  url: string,
  write: string
): FixEdit[] =>
  block.blocking.map((line) => {
    const [at] = line.agentLines;
    const group = block.rules.filter((r) => r.agentLines === line.agentLines);
    const others = group.filter((r) => !block.blocking.includes(r));
    const first = block.blocking.find((l) => l.agentLines === line.agentLines);

    return others.length === 0 && first === line
      ? replaceEdit("robots.txt", line.raw, "Allow: /", { url, at, write })
      : removeEdit("robots.txt", line.raw, { url, at, write });
  });

/** A run of user-agent lines longer than this is not quoted whole; each line is removed on its own. */
const MAX_RUN_CHARS = 1000;

const SHARED_RUN =
  "The other bots of this group are AI crawlers that other findings may take out of it too. Apply one of those edits, then re-check before the next: a group needs a User-agent line, or its rules join the group above it.";

/**
 * Edits that take `leaving` bots out of a group they share with crawlers this finding is not about.
 * While a crawler no finding moves stays in the group, each bot's user-agent line goes. When every
 * other agent is an AI bot another finding may move as well, one edit quotes the group's whole run
 * of user-agent lines, as do the other findings' edits: once one is applied the rest no longer
 * match, so applied together they can never leave the group's rules without a user-agent line.
 * The run is quoted too when a leaving bot is named in another group (`elsewhere`): its user-agent
 * line alone would not say which group it is taken out of.
 */
const leaveGroupEdits = (
  line: RobotsRuleLine,
  leaving: Set<string>,
  elsewhere: boolean,
  reported: Set<string>,
  url: string,
  write: string
): FixEdit[] => {
  const [at] = line.agentLines;
  const stays = line.tokens.some((t) => !reported.has(t));
  const { lines, eol } = line.run;
  const current = lines.map((l) => l.text).join(eol);

  if ((!stays || elsewhere) && current.length <= MAX_RUN_CHARS) {
    const kept = lines.filter((l) => l.token === null || !leaving.has(l.token));

    // Never a run without a user-agent line: the group's rules would join the group above it.
    if (!kept.some((l) => l.token !== null)) {
      return [];
    }

    // Another AI bot of the group may leave it in another finding, whose edit quotes the run too.
    const shared = line.tokens.some((t) => reported.has(t) && !leaving.has(t));

    return [
      replaceEdit("robots.txt", current, kept.map((l) => l.text).join(eol), {
        url,
        at,
        write: shared ? `${write} ${SHARED_RUN}` : write,
      }),
    ];
  }

  return line.agentLines.flatMap((agentLine, i) =>
    leaving.has(line.tokens[i] ?? "")
      ? [
          removeEdit("robots.txt", agentLine, {
            url,
            at,
            write: stays ? write : `${write} ${SHARED_RUN}`,
          }),
        ]
      : []
  );
};

/** What one blocked bot needs: edits to robots.txt as it is, and the rules of a new group for it. */
interface BotFix {
  edits: FixEdit[];
  /** Lines of groups it shares with other crawlers, which it leaves. */
  leaves: RobotsRuleLine[];
  /** The rules of a group of its own, or null when the edits are enough. */
  group: string[] | null;
}

const botFix = (
  block: RobotsBlock | undefined,
  tokens: Set<string>,
  url: string,
  write: string
): BotFix => {
  if (!block?.blocking.length) {
    return {
      edits: [],
      leaves: [],
      group: block ? keptRules(block, block.rules) : ["Allow: /"],
    };
  }

  if (block.group !== "named") {
    return { edits: [], leaves: [], group: keptRules(block, block.rules) };
  }

  // A group that also speaks for crawlers this finding is not about keeps its lines; the bot
  // leaves it. A group only of this finding's bots loses its blocking lines in place, also when
  // the bot leaves a shared group as well: taking its user-agent line out instead would leave its
  // rules to join the group above.
  const isShared = (l: RobotsRuleLine): boolean =>
    l.tokens.some((t) => !tokens.has(t));

  const leaves = block.blocking.filter(isShared);

  const edits = ownGroupEdits(
    { ...block, blocking: block.blocking.filter((l) => !isShared(l)) },
    url,
    write
  );

  if (leaves.length === 0) {
    return { edits, leaves, group: null };
  }

  // The new group keeps the other rules of the groups the bot leaves. A bot that keeps a group of
  // its own needs no new group when there are none.
  const left = new Set(leaves.map((l) => l.agentLines));

  const kept = block.rules.flatMap((r) =>
    left.has(r.agentLines) && !block.blocking.includes(r) ? [r.raw] : []
  );

  if (kept.length > 0) {
    return { edits, leaves, group: kept };
  }

  const ownGroup = block.rules.some((r) => !left.has(r.agentLines));

  return { edits, leaves, group: ownGroup ? null : ["Allow: /"] };
};

/** The edits that let `blocked` bots into the audited pages, from what robots.txt says about each. */
const robotsFixes = (
  crawlers: AiCrawlerReport,
  blocked: AiBotAccess[],
  write: string
): FixEdit[] => {
  const url = crawlers.robotsTxt;
  const blocks = robotsBlocksOf(crawlers);
  const tokens = new Set(blocked.map((b) => tokenOf(b.name)));
  const letsGooglebotIn = blocked.some((b) => b.name === "Googlebot");
  const edits = new Map<string, FixEdit>();
  const groups = new Map<string, NewGroup>();

  // Every AI bot robots.txt keeps out, whichever finding it is in: a fix may move any of them.
  const reported = new Set(
    crawlers.bots
      .filter((b) => !b.allowed || b.blockedPages > 0)
      .map((b) => tokenOf(b.name))
  );

  // The bots of this finding that leave each shared group, by the group's user-agent lines.
  const leaving = new Map<
    string[],
    { line: RobotsRuleLine; tokens: Set<string>; elsewhere: boolean }
  >();

  for (const bot of blocked) {
    const block = blocks?.get(bot.name);

    // Applebot follows the Googlebot group; letting Googlebot in lets it in too.
    if (block?.group === "googlebot" && letsGooglebotIn) {
      continue;
    }

    const fix = botFix(block, tokens, url, write);

    for (const edit of fix.edits) {
      edits.set(`${edit.at ?? ""}\n${edit.current ?? ""}`, edit);
    }

    for (const line of fix.leaves) {
      const entry = leaving.get(line.agentLines) ?? {
        line,
        tokens: new Set(),
        elsewhere: false,
      };

      entry.tokens.add(tokenOf(bot.name));
      // The bot is named in another group too: its user-agent line alone does not say which.
      entry.elsewhere ||=
        block?.rules.some((r) => r.agentLines !== line.agentLines) ?? false;
      leaving.set(line.agentLines, entry);
    }

    if (fix.group) {
      const key = fix.group.join("\n");
      const group = groups.get(key) ?? { agents: [], rules: fix.group };

      group.agents.push(bot.name);
      groups.set(key, group);
    }
  }

  for (const { line, tokens: out, elsewhere } of leaving.values()) {
    for (const edit of leaveGroupEdits(
      line,
      out,
      elsewhere,
      reported,
      url,
      write
    )) {
      edits.set(`${edit.at ?? ""}\n${edit.current ?? ""}`, edit);
    }
  }

  return [
    ...edits.values(),
    ...[...groups.values()].map((group) =>
      addEdit(
        "robots.txt",
        "end of the file",
        [...group.agents.map((a) => `User-agent: ${a}`), ...group.rules].join(
          "\n"
        ),
        { url, write }
      )
    ),
  ];
};

/** A Content-Signal line written from its parts. */
const signalLine = (signal: ContentSignal, pairs: [string, string][]): string =>
  `Content-Signal: ${signal.path ? `${signal.path} ` : ""}${pairs
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")}`;

/** The edit that rewrites a Content-Signal line, or removes it when no pair is left. */
const signalEdit = (
  url: string,
  signal: ContentSignal,
  pairs: [string, string][],
  write: string
): FixEdit => {
  const source = signalSourceOf(signal);

  const current =
    source?.raw ?? signalLine(signal, Object.entries(signal.signals));

  const at = source?.group ?? undefined;

  return pairs.length
    ? replaceEdit("robots.txt", current, signalLine(signal, pairs), {
        url,
        at,
        write,
      })
    : removeEdit("robots.txt", current, { url, at, write });
};

const ANSWER_SIGNALS = new Set(["ai-input", "search"]);
const KNOWN_SIGNALS = new Set(["search", "ai-input", "ai-train", "use"]);

/**
 * Markdown link text and target for an llms.txt line, so a page's title cannot break the link.
 * Brackets become parentheses rather than escapes: simple readers of llms.txt, this audit's link
 * count among them, end the link text at a "]" even with a backslash before it.
 */
const llmsLink = (page: { url: string; title: string | null }): string => {
  const title = page.title
    ? page.title
        .replaceAll("[", "(")
        .replaceAll("]", ")")
        .replaceAll("\\", "\\\\")
    : slot("page title");

  return `- [${title}](${page.url.replaceAll("(", "%28").replaceAll(")", "%29")}): ${slot("what it covers")}`;
};

/** The link lines a fix writes into llms.txt: the audited pages, or the home page as a start. */
const llmsLinks = (
  llmsUrl: string,
  pages: AeoSiteContext["pages"]
): string[] => {
  const listed = (pages ?? []).slice(0, 10);

  return listed.length
    ? listed.map(llmsLink)
    : [llmsLink({ url: new URL("/", llmsUrl).href, title: null })];
};

const LLMS_HEAD = [
  `# ${slot("site name")}`,
  "",
  `> ${slot("one-sentence summary of what the site offers")}`,
];

const LLMS_WRITE =
  "The site's name, a one-sentence summary, and for each page a few words on what it covers. List the pages that matter most, not every URL.";

const robotsFindings = (
  crawlers: AiCrawlerReport,
  pageCount: number
): Finding[] => {
  if (crawlers.status === "unreachable") {
    return [
      finding(
        m("aeo.robots-txt-unreachable"),
        `robots.txt at ${crawlers.robotsTxt} ${crawlers.httpStatus === null ? "did not answer" : `answers HTTP ${crawlers.httpStatus}`}, so crawlers that follow RFC 9309, AI crawlers included, treat the whole site as off limits.`,
        {
          fix: [
            replaceEdit(
              "http",
              crawlers.httpStatus === null
                ? "no response"
                : statusLine(crawlers.httpStatus),
              "HTTP/1.1 200 OK\nContent-Type: text/plain",
              {
                url: crawlers.robotsTxt,
                at: "status line",
                write:
                  "Serve /robots.txt as a plain-text file with 200, or answer 404 when the site has none. Look for the server, CDN or firewall rule that answers it with an error or lets it time out.",
              }
            ),
          ],
          evidence: { url: crawlers.robotsTxt, status: crawlers.httpStatus },
        }
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
          fix: robotsFixes(crawlers, blocked, ROBOTS_WRITE[purpose]),
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
        {
          fix: optOuts.map((signal) =>
            signalEdit(
              crawlers.robotsTxt,
              signal,
              Object.entries(signal.signals).map(([k, v]): [string, string] => [
                k,
                ANSWER_SIGNALS.has(k) && v === "no" ? "yes" : v,
              ]),
              "ai-train=no can stay to opt out of training. Keep ai-input=no or search=no only if keeping the content out of AI answers or search is deliberate."
            )
          ),
          evidence: { signals: cap(optOuts) },
        }
      ),
      url: crawlers.robotsTxt,
    });
  }

  const invalid = crawlers.contentSignals.flatMap(invalidSignals);

  if (invalid.length) {
    const lines = crawlers.contentSignals.filter(
      (s) => invalidSignals(s).length > 0
    );

    out.push({
      ...finding(
        m("aeo.content-signal-invalid"),
        `robots.txt Content-Signal has values the policy does not define: ${cap(invalid, 5).join(", ")}.`,
        {
          fix: lines.map((signal) =>
            signalEdit(
              crawlers.robotsTxt,
              signal,
              Object.entries(signal.signals).flatMap(
                ([k, v]): [string, string][] => {
                  if (!KNOWN_SIGNALS.has(k)) {
                    return [];
                  }

                  return k === "use" || v === "yes" || v === "no"
                    ? [[k, v]]
                    : [[k, slot("yes or no")]];
                }
              ),
              "Content-Signal takes search, ai-input and ai-train, each yes or no: yes or no for what the owner allows. A name the policy does not define is dropped; if it was a typo, write it under its right name."
            )
          ),
          evidence: { values: cap(invalid) },
        }
      ),
      url: crawlers.robotsTxt,
    });
  }

  return out;
};

const llmsTxtFindings = (
  llms: LlmsTxtInfo,
  pages: AeoSiteContext["pages"]
): Finding[] => {
  const at = { url: llms.url };
  const links = llmsLinks(llms.url, pages);

  const file = [...LLMS_HEAD, "", "## Pages", "", ...links].join("\n");

  if (llms.status === "missing") {
    return [
      {
        ...finding(
          m("aeo.llms-txt-missing"),
          `No llms.txt at ${llms.url}${llms.httpStatus ? ` (HTTP ${llms.httpStatus})` : ""}.`,
          {
            fix: [
              addEdit("llms.txt", "new file", file, {
                url: llms.url,
                write: `${LLMS_WRITE} Serve it as plain text or Markdown at /llms.txt (in most frameworks, public/llms.txt).`,
              }),
            ],
          }
        ),
        ...at,
      },
    ];
  }

  if (llms.status === "invalid") {
    const empty =
      llms.bytes === 0 || llms.problems.includes("the file is empty");

    return [
      {
        ...finding(
          m("aeo.llms-txt-invalid"),
          `llms.txt does not follow the format: ${llms.problems.join("; ")}.`,
          {
            fix: [
              empty
                ? addEdit("llms.txt", "new file", file, {
                    url: llms.url,
                    write: LLMS_WRITE,
                  })
                : addEdit(
                    "llms.txt",
                    "first line",
                    [...LLMS_HEAD, ""].join("\n"),
                    {
                      url: llms.url,
                      write:
                        "The site's name as an H1 and a one-sentence summary, above what the file starts with now; move any other heading below them.",
                    }
                  ),
            ],
            evidence: { problems: llms.problems, bytes: llms.bytes },
          }
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
            `llms.txt "${llms.title ?? ""}" has no Markdown links.`,
            {
              fix: [
                addEdit(
                  "llms.txt",
                  "end of the file",
                  ["## Pages", "", ...links].join("\n"),
                  { url: llms.url, write: LLMS_WRITE }
                ),
              ],
            }
          ),
          ...at,
        },
      ]
    : [];
};

/** The response a bot got, as the `current` of a fix. */
const probeResponse = (bot: AiBotAccess): string => {
  const status = bot.probe?.status ?? null;
  const reason = bot.probe?.reason ?? null;

  if (status === null) {
    return `no response${reason ? ` (${reason})` : ""}`;
  }

  return reason && !reason.startsWith("HTTP")
    ? `${statusLine(status)} (${reason})`
    : statusLine(status);
};

const serverFix = (
  bot: AiBotAccess,
  purpose: "answer" | "training"
): FixEdit => {
  const allow = `Let ${bot.name} through at the CDN, firewall or bot-protection layer: its AI crawler setting, or a WAF rule that allows ${bot.name}'s verified IP ranges or user agent. This request came from this machine with ${bot.name}'s User-Agent, not from its IP ranges, so confirm the block in the CDN's bot logs before you change a rule.`;

  return replaceEdit("http", probeResponse(bot), "HTTP/1.1 200 OK", {
    at: `User-Agent: ${bot.name}`,
    write:
      purpose === "training"
        ? `Keeping training bots out is the owner's choice and does not affect AI answers; apply this only if the owner wants ${bot.name} to collect the content. ${allow}`
        : allow,
  });
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
          fix: blocked.map((b) => serverFix(b, purpose)),
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
    out.push(...llmsTxtFindings(ctx.llmsTxt, ctx.pages));
  }

  if (ctx.probeSkipped) {
    out.push(
      finding(
        m("aeo.bot-probe-inconclusive"),
        `The AI bot probe did not run: ${ctx.probeSkipped}.`,
        // About the audit, not the site: aeo.page-error carries the fix for a page that fails.
        { fix: [] }
      )
    );
  }

  if (ctx.crawlStopped) {
    out.push(
      finding(
        m("aeo.crawl-stopped"),
        `The crawl stopped after ${ctx.pageCount} page(s): ${ctx.crawlStopped}`,
        // About the audit, not the site: the way out is a crawl from somewhere else.
        { fix: [], evidence: { pagesCrawled: ctx.pageCount } }
      )
    );
  }

  return out;
};
