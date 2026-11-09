import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";

import {
  auditAeoDirectory,
  auditAeoHtml,
  auditAeoSite,
  auditAeoUrl,
  compactAeoAudit,
} from "../src/core/aeo/audit.js";
import { contentSignals, crawlerAccess } from "../src/core/aeo/bots.js";
import { parseLlmsTxt } from "../src/core/aeo/llms-txt.js";
import { aeoSiteFindings } from "../src/core/aeo/site-rules.js";
import { auditHtml } from "../src/core/audit.js";
import { extractPage } from "../src/core/html/extract.js";
import { renderAeoMarkdown } from "../src/core/report/markdown.js";
import {
  AEO_PAGE_RULES,
  ALL_RULES,
  PAGE_RULES,
  runPageRules,
} from "../src/core/rules/index.js";
import { DEFAULT_THRESHOLDS } from "../src/core/types.js";
import type {
  AeoAudit,
  AiCrawlerReport,
  RobotsTxtInfo,
} from "../src/core/types.js";
import { siteRoutes, startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

const rulesOf = (findings: { rule: string }[]) => findings.map((f) => f.rule);

const findingOf = (audit: AeoAudit, rule: string) =>
  audit.findings.find((f) => f.rule === rule);

/** The AEO page rules' findings for HTML served at `url` with these response headers. */
const pageRules = (
  html: string,
  url = "https://www.example.com/guides/x/",
  headers: Record<string, string> = {}
) =>
  runPageRules(
    {
      page: extractPage(html, { url }),
      source: "url",
      response: {
        status: 200,
        finalUrl: url,
        redirectChain: [],
        timeMs: 10,
        contentType: "text/html",
        headers,
      },
      thresholds: DEFAULT_THRESHOLDS,
    },
    { rules: AEO_PAGE_RULES }
  );

const robotsAt = (text: string | null, status = 200): RobotsTxtInfo => ({
  url: "https://www.example.com/robots.txt",
  status,
  found: text !== null,
  bytes: text === null ? null : Buffer.byteLength(text),
  sitemaps: [],
  text,
});

const botIn = (report: AiCrawlerReport, name: string) =>
  report.bots.find((b) => b.name === name);

const siteRules = (crawlers: AiCrawlerReport | null, pageCount = 1) =>
  rulesOf(aeoSiteFindings({ crawlers, llmsTxt: null, pageCount }));

const article = (extra: string) =>
  `<!doctype html><html lang="en"><head><title>A guide</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"A guide"${extra}}</script></head><body><h1>A guide</h1><p>Some text about widgets for the guide, long enough to read.</p></body></html>`;

const goodHtml = fixture("aeo-good-page.html");
const badHtml = fixture("aeo-bad-page.html");

describe("AEO page rules", () => {
  it.each([
    ["good-page.html", "https://www.example.com/widgets/blue/"],
    ["aeo-good-page.html", "https://www.example.com/guides/choose-a-widget/"],
  ])("stay quiet on %s", async (name, url) => {
    const audit = await auditAeoHtml(fixture(name), { url });

    // An empty array compared in full shows any finding in the failure's diff.
    expect(audit.findings).toStrictEqual([]);
    expect(audit.score).toBe(100);
  });

  it("summarise what answer engines may do with the page", async () => {
    const audit = await auditAeoHtml(goodHtml, {
      url: "https://www.example.com/guides/choose-a-widget/",
    });

    expect(audit.kind).toBe("aeo");
    expect(audit.summary.page).toMatchObject({
      indexable: true,
      googleSnippets: "allowed",
      copilotAnswers: "allowed",
      questions: 2,
      author: "Sam Jansen",
      datePublished: "2026-03-14T09:30:00+01:00",
    });
    // HTML in hand has no site around it, so robots.txt and llms.txt are not checked.
    expect(audit.crawlers).toBeNull();
    expect(audit.summary.robotsTxt).toBeNull();
    expect(audit.pages).toBeUndefined();
  });

  describe("on a page with opt-outs, hidden markup and unanswered questions", () => {
    let audit: AeoAudit;

    beforeAll(async () => {
      audit = await auditAeoHtml(badHtml, {
        url: "https://www.example.com/guides/questions/",
      });
    });

    it.each([
      "aeo.nosnippet",
      "aeo.noarchive",
      "aeo.noai",
      "aeo.data-nosnippet",
      "aeo.schema-text-not-visible",
      "aeo.question-not-answered-first",
      "aeo.article-author-incomplete",
      "aeo.article-dates-missing",
    ])("reports %s", (rule) => {
      expect(rulesOf(audit.findings)).toContain(rule);
    });

    it("escalates the severities the evidence calls for", () => {
      // The paywall wraps most of the text.
      expect(findingOf(audit, "aeo.data-nosnippet")?.severity).toBe("warning");
      // datePublished is missing, which outweighs the missing dateModified.
      expect(findingOf(audit, "aeo.article-dates-missing")?.severity).toBe(
        "warning"
      );
      expect(audit.summary.page?.googleSnippets).toBe("blocked");
      expect(audit.summary.page?.copilotAnswers).toBe("excluded");
    });

    it("names the marked-up question the page does not show", () => {
      const evidence = JSON.stringify(
        findingOf(audit, "aeo.schema-text-not-visible")?.evidence
      );

      expect(evidence).toContain("Can I return a widget after a year?");
      expect(evidence).not.toContain("need oil");
    });

    it("names the questions without a short answer", () => {
      const evidence = JSON.stringify(
        findingOf(audit, "aeo.question-not-answered-first")?.evidence
      );

      expect(evidence).toContain("Why does my widget wobble?");
      expect(evidence).toContain("How long does a widget last?");
      expect(evidence).not.toContain("Do widgets need oil?");
    });
  });

  it.each([
    ["googlebot: nosnippet", ["aeo.nosnippet"]],
    ["bingbot: noarchive", ["aeo.noarchive"]],
    // Bing does not read googlebot's directives, and Google ignores noarchive.
    ["googlebot: noarchive", []],
    // Bing treats a page with both noarchive and nocache as nocache.
    ["noarchive, nocache", ["aeo.nocache"]],
    ["max-snippet:40", ["aeo.max-snippet-short"]],
    ["max-snippet:-1", []],
    // noindex outranks the snippet controls, which then say nothing more.
    ["noindex, nosnippet", ["aeo.noindex"]],
  ])("reads X-Robots-Tag %j per crawler", (header, expected) => {
    expect(
      rulesOf(pageRules(goodHtml, undefined, { "x-robots-tag": header }))
    ).toStrictEqual(expected);
  });

  it("says which engine a scoped nosnippet is for", () => {
    const [found] = pageRules(goodHtml, undefined, {
      "x-robots-tag": "googlebot: nosnippet",
    });

    expect(found?.evidence).toMatchObject({ engines: ["Google"] });
  });

  it("counts subsections as the answer to a question heading", () => {
    const [found] = pageRules(
      '<!doctype html><html lang="en"><head><title>Us</title></head><body><h1>Widget Co</h1><h2>Why choose us?</h2><h3>Fast</h3><p>Orders ship the same day.</p><h3>Fair</h3><p>Prices include tax.</p><h2>Is shipping free?</h2><h2>Contact</h2><p>Write to us.</p></body></html>'
    );

    expect(found?.rule).toBe("aeo.question-not-answered-first");
    expect(found?.evidence).toStrictEqual({
      questions: [
        {
          question: "Is shipping free?",
          firstBlockWords: null,
          sectionWords: 0,
        },
      ],
    });
  });

  it("decodes HTML entities in FAQ markup before it looks for the text", () => {
    expect(
      rulesOf(
        pageRules(
          '<!doctype html><html lang="en"><head><title>FAQ</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Do you sell R&amp;D kits?","acceptedAnswer":{"@type":"Answer","text":"<p>Yes, we sell R&amp;D kits &#8211; see the shop.</p>"}}]}</script></head><body><h1>FAQ</h1><h2>Do you sell R&amp;D kits?</h2><p>Yes, we sell R&amp;D kits – see the shop.</p></body></html>'
        )
      )
    ).toStrictEqual([]);
  });

  it("flags an empty JavaScript app shell", () => {
    expect(
      rulesOf(
        pageRules(
          '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
        )
      )
    ).toStrictEqual(["aeo.text-needs-javascript"]);
  });

  it("flags a long page without subheadings, lists or tables", () => {
    expect(
      rulesOf(
        pageRules(
          `<!doctype html><html lang="en"><head><title>Essay</title></head><body><h1>Essay</h1><p>${"Words about widgets go on and on here. ".repeat(110)}</p></body></html>`
        )
      )
    ).toStrictEqual(["aeo.unstructured-text"]);
  });

  it("flags an article without author or dates", () => {
    expect(rulesOf(pageRules(article("")))).toStrictEqual([
      "aeo.article-author-missing",
      "aeo.article-dates-missing",
    ]);
  });

  it("flags an article date the page does not show", () => {
    expect(
      rulesOf(
        pageRules(
          article(
            ',"author":{"@type":"Person","name":"Sam","url":"https://www.example.com/sam/"},"datePublished":"2024-01-02","dateModified":"2024-02-03"'
          )
        )
      )
    ).toStrictEqual(["aeo.article-date-not-visible"]);
  });

  it("asks a home page for an entity, and the entity for sameAs links", () => {
    const home = "https://www.example.com/";

    expect(
      rulesOf(
        pageRules(
          "<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1><p>Welcome to the site.</p></body></html>",
          home
        )
      )
    ).toStrictEqual(["aeo.organization-missing"]);

    // A LocalBusiness subtype with an address counts as the entity.
    expect(
      rulesOf(
        pageRules(
          '<!doctype html><html><head><title>Home</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Smile Dental","address":"Example Street 1"}</script></head><body><h1>Smile Dental</h1><p>Welcome.</p></body></html>',
          home
        )
      )
    ).toStrictEqual(["aeo.entity-same-as-missing"]);
  });

  it("never run in the SEO audit", async () => {
    const seo = await auditHtml(badHtml, {
      url: "https://www.example.com/guides/questions/",
      source: "url",
    });

    expect(PAGE_RULES.some((r) => r.meta.category === "aeo")).toBeFalsy();
    expect(rulesOf(seo.findings).some((r) => r.startsWith("aeo."))).toBeFalsy();
  });

  it("are all listed, under unique aeo.* ids", () => {
    const ids = ALL_RULES.map((r) => r.id);
    const aeo = ALL_RULES.filter((r) => r.category === "aeo");

    expect(new Set(ids).size).toBe(ids.length);
    expect(aeo.every((r) => r.id.startsWith("aeo."))).toBeTruthy();
    expect(aeo.map((r) => r.id)).toContain("aeo.server-blocks-answer-bot");
  });
});

describe("AI crawler access", () => {
  const robots = [
    "User-agent: *",
    "Allow: /",
    "Content-Signal: search=yes, ai-input=no, ai-train=no",
    "",
    "User-agent: GPTBot",
    "User-agent: __usage_ai-training",
    "Disallow: /",
    "",
    "User-agent: OAI-SearchBot",
    "Disallow: /private/",
    "Content-Signal: /blog/ ai-input=maybe, colour=blue",
  ].join("\n");

  const report = crawlerAccess(
    robotsAt(robots),
    robots,
    "https://www.example.com/",
    ["https://www.example.com/", "https://www.example.com/private/a"]
  );

  it("matches each bot against its own group, and the rest against *", () => {
    expect(report.status).toBe("found");
    expect(botIn(report, "GPTBot")).toMatchObject({
      robotsGroup: "named",
      allowed: false,
      blockedPages: 2,
    });
    expect(botIn(report, "OAI-SearchBot")).toMatchObject({
      robotsGroup: "named",
      allowed: true,
      blockedPages: 1,
    });
    expect(botIn(report, "Googlebot")).toMatchObject({
      robotsGroup: "wildcard",
      allowed: true,
      blockedPages: 0,
    });
    expect(report.trainingPreference).toBe("disallowed");
  });

  it("reads Content-Signal lines with their group and path", () => {
    expect(report.contentSignals).toStrictEqual([
      {
        userAgents: ["*"],
        path: null,
        signals: { search: "yes", "ai-input": "no", "ai-train": "no" },
      },
      {
        userAgents: ["OAI-SearchBot"],
        path: "/blog/",
        signals: { "ai-input": "maybe", colour: "blue" },
      },
    ]);
    expect(
      contentSignals("User-agent: *\nContent-signal: search=yes")
    ).toStrictEqual([
      { userAgents: ["*"], path: null, signals: { search: "yes" } },
    ]);
  });

  it("reports blocked bots by purpose and Content-Signal opt-outs", () => {
    expect(siteRules(report, 2)).toStrictEqual([
      "aeo.robots-blocks-answer-bot",
      "aeo.robots-blocks-training-bot",
      "aeo.content-signal-blocks-answers",
      "aeo.content-signal-invalid",
    ]);
  });

  it("leaves a path that User-agent: * disallows for every crawler to the SEO audit", () => {
    const text = "User-agent: *\nDisallow: /admin/\n";

    const site = crawlerAccess(
      robotsAt(text),
      text,
      "https://www.example.com/",
      ["https://www.example.com/", "https://www.example.com/admin/"]
    );

    expect(
      site.bots.every((b) => b.allowed && b.blockedPages === 0)
    ).toBeTruthy();
    expect(siteRules(site, 2)).toStrictEqual([]);
  });

  it("matches Applebot against the Googlebot group when no group names it", () => {
    const onlyGoogle =
      "User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n";

    const allowed = crawlerAccess(
      robotsAt(onlyGoogle),
      onlyGoogle,
      "https://www.example.com/",
      []
    );

    expect(botIn(allowed, "Applebot")).toMatchObject({
      robotsGroup: "googlebot",
      allowed: true,
    });

    const privateForGoogle =
      "User-agent: Googlebot\nDisallow: /private/\n\nUser-agent: *\nAllow: /\n";

    const partial = crawlerAccess(
      robotsAt(privateForGoogle),
      privateForGoogle,
      "https://www.example.com/",
      ["https://www.example.com/", "https://www.example.com/private/a"]
    );

    expect(botIn(partial, "Applebot")).toMatchObject({
      robotsGroup: "googlebot",
      allowed: true,
      blockedPages: 1,
    });
  });

  it("reports only the search crawlers robots.txt really blocks", () => {
    const onlyGoogle =
      "User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n";

    const [search] = aeoSiteFindings({
      crawlers: crawlerAccess(
        robotsAt(onlyGoogle),
        onlyGoogle,
        "https://www.example.com/",
        []
      ),
      llmsTxt: null,
      pageCount: 1,
    });

    expect(search?.rule).toBe("aeo.robots-blocks-search-crawler");
    expect(search?.message).toBe("robots.txt blocks Bingbot.");
  });

  it("does not read User-agent: * as the shared training preference", () => {
    const text = "User-agent: *\nDisallow: /\n";

    const all = crawlerAccess(
      robotsAt(text),
      text,
      "https://www.example.com/",
      []
    );

    expect(all.trainingPreference).toBe("none");
    expect(all.bots.every((b) => !b.allowed)).toBeTruthy();
    expect(siteRules(all)).toContain("aeo.robots-blocks-search-crawler");
  });

  it("treats an unreachable robots.txt as crawl nothing", () => {
    const down = crawlerAccess(
      robotsAt(null, 503),
      null,
      "https://www.example.com/",
      []
    );

    expect(down.status).toBe("unreachable");
    expect(siteRules(down)).toStrictEqual(["aeo.robots-txt-unreachable"]);
  });

  it("treats a missing robots.txt as crawl everything", () => {
    const none = crawlerAccess(
      robotsAt(null, 404),
      null,
      "https://www.example.com/",
      []
    );

    expect(none.status).toBe("missing");
    expect(none.bots.every((b) => b.allowed)).toBeTruthy();
    expect(siteRules(none)).toStrictEqual([]);
  });
});

describe("llms.txt", () => {
  const url = "https://www.example.com/llms.txt";

  const llmsRules = (text: string) =>
    rulesOf(
      aeoSiteFindings({
        crawlers: null,
        llmsTxt: parseLlmsTxt(url, 200, text),
        pageCount: 1,
      })
    );

  it("reads the title, summary, sections and links", () => {
    const info = parseLlmsTxt(
      url,
      200,
      "\uFEFF# Widget Co\n\n> Workshop widgets and guides.\n\n## Guides\n\n- [Choosing a widget](https://www.example.com/guides/choose/): sizes and materials\n\n## Optional\n\n- [About](https://www.example.com/about/)\n"
    );

    expect(info).toMatchObject({
      status: "found",
      title: "Widget Co",
      summary: "Workshop widgets and guides.",
      sections: ["Guides", "Optional"],
      links: 2,
      problems: [],
    });
  });

  it.each([
    ["Widget Co\n\nSome text.", ["aeo.llms-txt-invalid"]],
    ["# Widget Co\n\nNothing listed.", ["aeo.llms-txt-no-links"]],
    ["# Widget Co\n\n- [Home](https://www.example.com/)", []],
  ])("checks %j against the format", (text, expected) => {
    expect(llmsRules(text)).toStrictEqual(expected);
  });
});

describe("AEO audits of a site served over HTTP", () => {
  let server: FixtureServer;
  let guideUrl: string;

  beforeAll(async () => {
    server = await startFixtureServer({
      ...siteRoutes(),
      "/guide": {
        body: goodHtml,
        blockUserAgents: ["GPTBot", "PerplexityBot/"],
      },
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nDisallow: /private/\n\nUser-agent: ClaudeBot\nDisallow: /\n",
      },
      "/llms.txt": {
        headers: { "content-type": "text/plain" },
        body: "# Fixture site\n\n> A site for tests.\n\n## Pages\n\n- [Guide](/guide): the guide\n",
      },
    });
    guideUrl = `${server.origin}/guide`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("audits one page with its site's robots.txt and llms.txt", async () => {
    const audit = await auditAeoUrl(guideUrl);

    expect(audit.summary).toMatchObject({
      pages: 1,
      robotsTxt: "found",
      searchCrawlersBlocked: [],
      answerBotsBlocked: [],
      trainingBotsBlocked: ["ClaudeBot"],
      blockedByServer: null,
      llmsTxt: "found",
    });
    expect(audit.llmsTxt?.title).toBe("Fixture site");
    expect(rulesOf(audit.findings)).toStrictEqual([
      "aeo.robots-blocks-training-bot",
    ]);
    // Without aiBots, no request claims to be a bot.
    expect(server.userAgents.some((ua) => ua.includes("GPTBot"))).toBeFalsy();
  });

  describe("with the AI bot probe", () => {
    let audit: AeoAudit;

    beforeAll(async () => {
      audit = await auditAeoUrl(guideUrl, { aiBots: true });
    });

    it("records what the server answered each bot", () => {
      expect(audit.summary.blockedByServer).toStrictEqual([
        "PerplexityBot",
        "GPTBot",
      ]);
      expect(audit.crawlers?.probeBaseline?.status).toBe(200);
      expect(
        audit.crawlers?.bots.find((b) => b.name === "PerplexityBot")?.probe
      ).toStrictEqual({ status: 403, blocked: true, reason: "HTTP 403" });
      // Search crawlers and robots.txt-only tokens are never impersonated.
      expect(
        audit.crawlers?.bots.find((b) => b.name === "Googlebot")?.probe
      ).toBeUndefined();
    });

    it("reports blocked answer and training bots, with the probe's caveat", () => {
      expect(rulesOf(audit.findings)).toContain("aeo.server-blocks-answer-bot");
      expect(rulesOf(audit.findings)).toContain(
        "aeo.server-blocks-training-bot"
      );
      expect(
        findingOf(audit, "aeo.server-blocks-answer-bot")?.message
      ).toContain("not from the bots' own IP ranges");
    });
  });

  it("says why the probe did not run on a page that fails for everyone", async () => {
    const audit = await auditAeoUrl(`${server.origin}/missing`, {
      aiBots: true,
    });

    expect(rulesOf(audit.findings)).toContain("aeo.page-error");
    expect(rulesOf(audit.findings)).toContain("aeo.bot-probe-inconclusive");
    expect(audit.summary.blockedByServer).toBeNull();
  });

  describe("a crawl", () => {
    let audit: AeoAudit;
    let requested: string[];

    beforeAll(async () => {
      const before = server.requests.length;
      audit = await auditAeoSite(server.origin, {
        maxPages: 10,
        pageDetail: "summary",
      });
      requested = server.requests.slice(before);
    });

    it("audits the pages without the SEO crawl's sitemap and redirect probes", () => {
      expect(audit.source).toBe("crawl");
      expect(audit.pages?.length).toBeGreaterThan(1);
      expect(audit.pages?.[0]?.depth).toBe(0);
      expect(requested).not.toContain("/sitemap.xml");
      expect(
        requested.some((p) => p.startsWith("/agentic-seo-probe"))
      ).toBeFalsy();
    });

    it("rolls page findings up in issues with pageDetail summary", () => {
      expect(rulesOf(audit.findings)).not.toContain("aeo.noindex");
      expect(audit.issues?.map((i) => i.rule)).toContain("aeo.noindex");
      expect(audit.counts.error).toBeGreaterThan(0);
    });

    it("renders a Markdown report", () => {
      const markdown = renderAeoMarkdown(audit);

      expect(markdown).toContain("# AEO audit:");
      expect(markdown).toContain("| ClaudeBot | Anthropic | training |");
      expect(markdown).toContain("## Pages");
    });
  });
});

describe("AEO audits of build output", () => {
  let dir: string;
  let audit: AeoAudit;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-aeo-"));
    await mkdir(path.join(dir, "guides"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1><p>Welcome to the site about widgets.</p><a href="/guides/">Guides</a></body></html>'
    );
    await writeFile(path.join(dir, "guides", "index.html"), goodHtml);
    await writeFile(
      path.join(dir, "robots.txt"),
      "User-agent: OAI-SearchBot\nDisallow: /guides/\n"
    );
    await writeFile(path.join(dir, "llms.txt"), "Widget Co without a title\n");
    audit = await auditAeoDirectory(dir, {
      baseUrl: "https://www.example.com/",
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists each file as a page", () => {
    expect(audit.source).toBe("directory");
    expect(audit.pages?.map((p) => p.url)).toStrictEqual([
      "index.html",
      path.join("guides", "index.html"),
    ]);
  });

  it("reads robots.txt and llms.txt from the directory", () => {
    const rules = rulesOf(audit.findings);

    expect(rules).toContain("aeo.robots-blocks-answer-bot");
    expect(rules).toContain("aeo.llms-txt-invalid");
    expect(rules).toContain("aeo.organization-missing");
    expect(
      JSON.stringify(findingOf(audit, "aeo.robots-blocks-answer-bot")?.evidence)
    ).toContain("1 of 2 audited pages");
  });

  it("reports no AI bot block for a file every crawler is kept from", async () => {
    const admin = await mkdtemp(path.join(os.tmpdir(), "agentic-seo-aeo-"));

    try {
      await mkdir(path.join(admin, "admin"), { recursive: true });
      await writeFile(path.join(admin, "index.html"), goodHtml);
      await writeFile(path.join(admin, "admin", "index.html"), goodHtml);
      await writeFile(
        path.join(admin, "robots.txt"),
        "User-agent: *\nDisallow: /admin/\n"
      );

      const result = await auditAeoDirectory(admin, {
        baseUrl: "https://www.example.com/",
      });

      expect(
        rulesOf(result.findings).filter((r) => r.startsWith("aeo.robots-"))
      ).toStrictEqual([]);
      expect(result.summary.searchCrawlersBlocked).toStrictEqual([]);
    } finally {
      await rm(admin, { recursive: true, force: true });
    }
  });

  it("compacts without changing the score", () => {
    const compact = compactAeoAudit(audit);

    assert(compact.crawlers, "the directory has a robots.txt");
    expect(compact.score).toBe(audit.score);
  });
});
