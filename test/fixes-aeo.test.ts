import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { crawlerAccess, pathMatches } from "../src/core/aeo/bots.js";
import { parseLlmsTxt } from "../src/core/aeo/llms-txt.js";
import { aeoSiteFindings } from "../src/core/aeo/site-rules.js";
import { extractAnswerSignals } from "../src/core/html/answer.js";
import { parseDocument } from "../src/core/html/dom.js";
import { extractPage } from "../src/core/html/extract.js";
import {
  AEO_PAGE_RULES,
  AEO_RULES,
  runPageRules,
} from "../src/core/rules/index.js";
import { DEFAULT_THRESHOLDS } from "../src/core/types.js";
import type {
  AiCrawlerReport,
  Finding,
  FixEdit,
  LlmsTxtInfo,
  RobotsTxtInfo,
} from "../src/core/types.js";
import {
  editsOf,
  incompleteEdits,
  unquotedEdits,
  withoutFix,
} from "./helpers/fixes.js";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

const PAGE_URL = "https://www.example.com/guides/x/";

/**
 * The AEO page findings for HTML served at `url`. The answer signals are read again with the HTML,
 * as the extractor does when it passes its source on, so fixes can quote what they rewrite.
 */
const pageFindings = (
  html: string,
  options: {
    url?: string;
    headers?: Record<string, string>;
    status?: number;
  } = {}
): Finding[] => {
  const url = options.url ?? PAGE_URL;
  const page = extractPage(html, { url });
  page.answer = extractAnswerSignals(parseDocument(html), page.text, html);

  return runPageRules(
    {
      page,
      source: "url",
      response: {
        status: options.status ?? 200,
        finalUrl: url,
        redirectChain: [],
        timeMs: 10,
        contentType: "text/html",
        headers: options.headers ?? {},
      },
      thresholds: DEFAULT_THRESHOLDS,
    },
    { rules: AEO_PAGE_RULES }
  );
};

const fixOf = (findings: Finding[], rule: string) =>
  findings.find((f) => f.rule === rule)?.fix;

const robotsAt = (text: string | null, status = 200): RobotsTxtInfo => ({
  url: "https://www.example.com/robots.txt",
  status,
  found: text !== null,
  bytes: text === null ? null : Buffer.byteLength(text),
  sitemaps: [],
  text,
});

const crawlersFor = (text: string, pages = [PAGE_URL]): AiCrawlerReport =>
  crawlerAccess(robotsAt(text), text, pages[0] ?? PAGE_URL, pages);

const llms = (fields: Partial<LlmsTxtInfo>): LlmsTxtInfo => ({
  url: "https://www.example.com/llms.txt",
  status: "found",
  httpStatus: 200,
  title: "Example",
  summary: null,
  sections: [],
  links: 0,
  bytes: 20,
  problems: [],
  ...fields,
});

/** Robots edits whose `current` is not a line of the robots.txt they are for. */
const unquotedRobots = (findings: Finding[], text: string): string[] =>
  editsOf(findings).flatMap(([f, e]) =>
    e.in === "robots.txt" &&
    e.current !== undefined &&
    !text.split("\n").some((l) => l.trim() === e.current) &&
    // A run of user-agent lines is quoted whole, as written.
    !(e.current.includes("\n") && text.includes(e.current))
      ? [`${f.rule}: ${e.current}`]
      : []
  );

const ROBOTS = [
  "User-agent: *",
  "Disallow: /admin/",
  "Content-Signal: search=yes, ai-input=no",
  "",
  "User-agent: GPTBot",
  "User-agent: OAI-SearchBot",
  "Disallow: /",
  "",
  "User-agent: PerplexityBot",
  "Disallow: /guides/  # not yet",
  "",
  "User-agent: ClaudeBot",
  "Disallow: /",
].join("\n");

/**
 * `text` with each robots.txt edit applied in turn, as an agent would: a line found from the group
 * `at` names, a group added at the end. Edits whose `current` is gone by then are skipped.
 */
interface Applied {
  text: string;
  /** Edits whose `current` was no longer in the file when their turn came. */
  skipped: FixEdit[];
}

const applyRobots = (text: string, edits: FixEdit[]): Applied => {
  let out = text;
  const skipped: FixEdit[] = [];

  for (const e of edits) {
    if (e.action === "add") {
      out = `${out.trimEnd()}\n\n${e.code ?? ""}\n`;
      continue;
    }

    const from = e.at ? out.indexOf(e.at) : 0;

    const at =
      e.current === undefined || from === -1
        ? -1
        : out.indexOf(e.current, from);

    if (e.current === undefined || at === -1) {
      skipped.push(e);
      continue;
    }

    let end = at + e.current.length;

    // A removed line takes its line break with it.
    if (e.action === "remove" && out[end] === "\n") {
      end += 1;
    }

    out = `${out.slice(0, at)}${e.action === "replace" ? (e.code ?? "") : ""}${out.slice(end)}`;
  }

  return { text: out, skipped };
};

/** The robots.txt edits of `rule` for `text`. */
const robotsFixOf = (text: string, rule: string): FixEdit[] =>
  fixOf(
    aeoSiteFindings({
      crawlers: crawlersFor(text),
      llmsTxt: null,
      pageCount: 1,
    }),
    rule
  ) ?? [];

/** Which bots robots.txt lets fetch the page. */
const allowedBots = (text: string): Record<string, boolean> =>
  Object.fromEntries(crawlersFor(text).bots.map((b) => [b.name, b.allowed]));

describe("fixes for the AEO page rules", () => {
  const bad = fixture("aeo-bad-page.html");
  const findings = pageFindings(bad);

  it("give every finding on the AEO bad page a complete fix that quotes the page", () => {
    expect(withoutFix(findings)).toStrictEqual([]);
    expect(incompleteEdits(findings)).toStrictEqual([]);
    expect(unquotedEdits(findings, bad)).toStrictEqual([]);
  });

  it("rewrite the robots meta tag without the opt-out each rule is about", () => {
    const tag = '<meta name="robots" content="nosnippet, noarchive, noai">';

    expect(fixOf(findings, "aeo.nosnippet")).toMatchObject([
      {
        in: "html",
        action: "replace",
        current: tag,
        code: '<meta name="robots" content="noarchive, noai">',
      },
    ]);
    expect(fixOf(findings, "aeo.noarchive")).toMatchObject([
      { current: tag, code: '<meta name="robots" content="nosnippet, noai">' },
    ]);
    expect(fixOf(findings, "aeo.noai")).toMatchObject([
      {
        current: tag,
        code: '<meta name="robots" content="nosnippet, noarchive">',
      },
    ]);
  });

  it("put a direct answer right under each question heading without one", () => {
    expect(fixOf(findings, "aeo.question-not-answered-first")).toMatchObject([
      {
        action: "replace",
        current: "<h2>Why does my widget wobble?</h2>",
        code: "<h2>Why does my widget wobble?</h2>\n<p>{{direct answer}}</p>",
      },
      {
        action: "replace",
        current: "<h2>How long does a widget last?</h2>",
      },
    ]);
  });

  it("never writes a heading back cut short", () => {
    // Docs pages put an anchor link with an SVG icon in each heading: the quote is cut at 500.
    const icon = `<svg viewBox="0 0 16 16"><path d="${"M1 1L2 2".repeat(80)}"></path></svg>`;
    const heading = `<h2 id="clean"><a class="anchor" href="#clean">${icon}</a>How do I clean a blue widget?</h2>`;

    const html = `<!doctype html><html lang="en"><head><title>Blue widget care</title></head><body><h1>Blue widget care</h1>${heading}<h2>Tools you need</h2><p>A soft brush and a dry cloth.</p></body></html>`;

    const [edit] =
      fixOf(pageFindings(html), "aeo.question-not-answered-first") ?? [];

    expect(heading.length).toBeGreaterThan(500);
    expect(edit).toMatchObject({
      action: "add",
      at: "h2",
      code: "<p>{{direct answer}}</p>",
    });
  });

  it("show marked-up questions and answers the page leaves out", () => {
    expect(fixOf(findings, "aeo.schema-text-not-visible")).toMatchObject([
      {
        action: "add",
        at: "body",
        code: "<h3>Can I return a widget after a year?</h3>\n<p>Returns are accepted within thirty days only.</p>",
      },
    ]);
  });

  it("take data-nosnippet off the element that hides the text", () => {
    expect(fixOf(findings, "aeo.data-nosnippet")).toMatchObject([
      {
        action: "replace",
        at: "div.paywall[data-nosnippet]",
        current: '<div class="paywall" data-nosnippet>',
        code: '<div class="paywall">',
      },
    ]);
  });

  it("give a bare author name a Person with a url, and add the missing dates", () => {
    expect(fixOf(findings, "aeo.article-author-incomplete")).toMatchObject([
      {
        action: "replace",
        at: "BlogPosting (JSON-LD) > author",
        current: '"Sam Jansen"',
        code: '{"@type": "Person", "name": "Sam Jansen", "url": "{{URL of Sam Jansen\'s author page}}"}',
      },
    ]);
    expect(fixOf(findings, "aeo.article-dates-missing")).toMatchObject([
      {
        action: "add",
        at: "BlogPosting (JSON-LD)",
        code: '"datePublished": "{{YYYY-MM-DD the article was first published}}"',
      },
      { code: '"dateModified": "{{YYYY-MM-DD of the last real change}}"' },
    ]);
  });

  it("drop noindex from the X-Robots-Tag header and keep the rest of it", () => {
    const found = pageFindings(
      "<html><head></head><body><p>Text</p></body></html>",
      {
        headers: { "x-robots-tag": "noindex, nofollow, bingbot: noarchive" },
      }
    );

    expect(fixOf(found, "aeo.noindex")).toStrictEqual([
      {
        in: "http",
        action: "replace",
        at: "X-Robots-Tag",
        current: "X-Robots-Tag: noindex, nofollow, bingbot: noarchive",
        code: "X-Robots-Tag: nofollow\nX-Robots-Tag: bingbot: noarchive",
        write: expect.stringContaining("keep noindex on login"),
      },
    ]);
  });

  it("keep the nofollow half of none, and remove a tag left empty", () => {
    const found = pageFindings(
      '<html><head><meta name="robots" content="none"><meta name="googlebot" content="max-snippet:50"><meta name="bingbot" content="nocache"></head><body><p>Text</p></body></html>'
    );

    expect(fixOf(found, "aeo.noindex")).toMatchObject([
      {
        current: '<meta name="robots" content="none">',
        code: '<meta name="robots" content="nofollow">',
      },
    ]);

    const relaxed = pageFindings(
      '<html><head><meta name="googlebot" content="max-snippet:50"><meta name="bingbot" content="nocache"></head><body><p>Text</p></body></html>'
    );

    expect(fixOf(relaxed, "aeo.max-snippet-short")).toMatchObject([
      { code: '<meta name="googlebot" content="max-snippet:-1">' },
    ]);
    expect(fixOf(relaxed, "aeo.nocache")).toMatchObject([
      { action: "remove", current: '<meta name="bingbot" content="nocache">' },
    ]);
  });

  it("fill an empty app root on the server", () => {
    const shell =
      '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

    expect(
      fixOf(pageFindings(shell), "aeo.text-needs-javascript")
    ).toMatchObject([
      {
        action: "replace",
        at: "#root",
        current: '<div id="root"></div>',
        code: '<div id="root">{{the page\'s content as HTML}}</div>',
      },
    ]);
  });

  it("add the content to an app root whose quote is cut, not write the cut quote back", () => {
    // A wordless SVG spinner keeps the root empty of text and takes its quote past 500 characters.
    const spinner = `<svg viewBox="0 0 24 24">${'<path d="M12 2a10 10 0 0 1 10 10"></path>'.repeat(20)}</svg>`;
    const shell = `<!doctype html><html><head><title>App</title></head><body><div id="root">${spinner}</div><script src="/app.js"></script></body></html>`;

    expect(
      fixOf(pageFindings(shell), "aeo.text-needs-javascript")
    ).toStrictEqual([
      {
        in: "html",
        action: "add",
        at: "#root",
        code: "{{the page's content as HTML}}",
        write: expect.any(String),
      },
    ]);
  });

  it("add Organization JSON-LD to a home page, named after og:site_name", () => {
    const home = pageFindings(
      '<html><head><meta property="og:site_name" content="Widget </script> Co"></head><body><p>Welcome</p></body></html>',
      { url: "https://www.example.com/" }
    );

    const [edit] = fixOf(home, "aeo.organization-missing") ?? [];

    expect(edit).toMatchObject({ in: "html", action: "add", at: "head" });
    expect(edit?.code).toContain('"name": "Widget \\u003c/script> Co",');
    expect(edit?.code).toContain('"url": "https://www.example.com/",');
    expect(edit?.code?.match(/<\/script>/gu)).toHaveLength(1);
  });

  it("covers the remaining page rules", () => {
    const article =
      '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"H","datePublished":"2024-05-01"}</script><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Widget Co","url":"https://www.example.com/"}</script></head><body><h1>Widgets</h1>' +
      `<p>${"word ".repeat(650)}</p></body></html>`;

    const found = pageFindings(article);

    expect(fixOf(found, "aeo.article-author-missing")).toMatchObject([
      {
        action: "add",
        at: "Article (JSON-LD)",
        code: expect.stringContaining('"author": {"@type": "Person"'),
      },
    ]);
    expect(fixOf(found, "aeo.article-date-not-visible")).toMatchObject([
      {
        action: "replace",
        current: "<h1>Widgets</h1>",
        code: '<h1>Widgets</h1>\n<p><time datetime="2024-05-01">{{the date for readers}}</time></p>',
      },
    ]);
    expect(fixOf(found, "aeo.entity-same-as-missing")).toMatchObject([
      { action: "add", at: 'Organization "Widget Co" (JSON-LD)' },
    ]);
    expect(fixOf(found, "aeo.unstructured-text")).toMatchObject([
      {
        action: "add",
        at: "p",
        code: "<h2>{{what the next part covers}}</h2>",
      },
    ]);
    expect(unquotedEdits(found, article)).toStrictEqual([]);
  });

  it("asks a page that fails to answer 200", () => {
    expect(
      fixOf(pageFindings("<p>Gone</p>", { status: 404 }), "aeo.page-error")
    ).toMatchObject([
      {
        in: "http",
        action: "replace",
        current: "HTTP/1.1 404 Not Found",
        code: "HTTP/1.1 200 OK",
      },
    ]);
  });
});

describe("fixes for the AEO site rules", () => {
  const crawlers = crawlersFor(ROBOTS);
  const findings = aeoSiteFindings({ crawlers, llmsTxt: null, pageCount: 1 });

  it("quote robots.txt lines as written", () => {
    expect(withoutFix(findings)).toStrictEqual([]);
    expect(incompleteEdits(findings)).toStrictEqual([]);
    expect(
      unquotedRobots(findings, ROBOTS.replace("  # not yet", ""))
    ).toStrictEqual([]);
  });

  it("let answer bots in without touching the training bots that share their group", () => {
    const url = "https://www.example.com/robots.txt";

    expect(fixOf(findings, "aeo.robots-blocks-answer-bot")).toStrictEqual([
      {
        in: "robots.txt",
        action: "replace",
        url,
        at: "User-agent: PerplexityBot",
        current: "Disallow: /guides/",
        code: "Allow: /",
        write: expect.any(String),
      },
      {
        in: "robots.txt",
        action: "replace",
        url,
        at: "User-agent: GPTBot",
        current: "User-agent: GPTBot\nUser-agent: OAI-SearchBot",
        code: "User-agent: GPTBot",
        write: expect.stringContaining("re-check before the next"),
      },
      {
        in: "robots.txt",
        action: "add",
        url,
        at: "end of the file",
        code: "User-agent: OAI-SearchBot\nAllow: /",
        write: expect.any(String),
      },
    ]);
  });

  it("never leave a shared group's rules without a user-agent line, applied together", () => {
    const answer = "aeo.robots-blocks-answer-bot";
    const training = "aeo.robots-blocks-training-bot";

    // An owner who wants every AI bot in applies both findings of one audit, one after the other.
    const answered = applyRobots(ROBOTS, robotsFixOf(ROBOTS, answer));
    const both = applyRobots(answered.text, robotsFixOf(ROBOTS, training));

    // The second edit of the GPTBot/OAI-SearchBot group no longer matches: re-check first. Before,
    // each removed one user-agent line, and the group's "Disallow: /" joined "User-agent: *".
    expect(both.skipped).toMatchObject([
      { current: "User-agent: GPTBot\nUser-agent: OAI-SearchBot" },
    ]);
    expect(allowedBots(both.text)).toMatchObject({
      Googlebot: true,
      Bingbot: true,
      "OAI-SearchBot": true,
    });

    // Re-checked first, as that edit says, the training finding's fix applies whole.
    const rechecked = applyRobots(
      answered.text,
      robotsFixOf(answered.text, training)
    );

    expect(rechecked.skipped).toStrictEqual([]);
    expect(allowedBots(rechecked.text)).toMatchObject({
      Googlebot: true,
      Bingbot: true,
      "OAI-SearchBot": true,
      GPTBot: true,
      ClaudeBot: true,
    });
  });

  it("never take a bot's only user-agent line out of its own group when it also leaves a shared one", () => {
    // GPTBot has a group of its own and shares another with AhrefsBot; the page is under /tmp/.
    const text = [
      "User-agent: *",
      "Disallow: /admin/",
      "",
      "User-agent: GPTBot",
      "Disallow: /",
      "",
      "User-agent: GPTBot",
      "User-agent: AhrefsBot",
      "Disallow: /tmp/",
    ].join("\n");

    const pages = ["https://www.example.com/tmp/a"];

    const fix =
      fixOf(
        aeoSiteFindings({
          crawlers: crawlersFor(text, pages),
          llmsTxt: null,
          pageCount: 1,
        }),
        "aeo.robots-blocks-training-bot"
      ) ?? [];

    // The run is quoted whole: "User-agent: GPTBot" alone would match the first group too.
    expect(fix).toMatchObject([
      { at: "User-agent: GPTBot", current: "Disallow: /", code: "Allow: /" },
      {
        current: "User-agent: GPTBot\nUser-agent: AhrefsBot",
        code: "User-agent: AhrefsBot",
      },
    ]);

    const applied = applyRobots(text, fix);
    const after = crawlersFor(applied.text, pages).bots;

    expect(applied.skipped).toStrictEqual([]);
    expect(applied.text).toContain("User-agent: AhrefsBot\nDisallow: /tmp/");
    expect(
      Object.fromEntries(after.map((b) => [b.name, b.allowed]))
    ).toMatchObject({ Googlebot: true, Bingbot: true, GPTBot: true });
  });

  it("say a training bot block is the owner's choice", () => {
    const training = fixOf(findings, "aeo.robots-blocks-training-bot") ?? [];

    expect(training.map((e) => e.write)).toSatisfy((w: string[]) =>
      w.every((x) => x.includes("owner's choice"))
    );
    expect(training).toContainEqual(
      expect.objectContaining({
        action: "replace",
        at: "User-agent: ClaudeBot",
        current: "Disallow: /",
        code: "Allow: /",
      })
    );
  });

  it("set ai-input back to yes on the Content-Signal line", () => {
    expect(fixOf(findings, "aeo.content-signal-blocks-answers")).toMatchObject([
      {
        action: "replace",
        at: "User-agent: *",
        current: "Content-Signal: search=yes, ai-input=no",
        code: "Content-Signal: search=yes, ai-input=yes",
      },
    ]);
  });

  it("give search crawlers blocked through * a group of their own that keeps the other rules", () => {
    const text = "User-agent: *\nDisallow: /\nDisallow: /cart/\n";

    const found = aeoSiteFindings({
      crawlers: crawlersFor(text),
      llmsTxt: null,
      pageCount: 1,
    });

    expect(fixOf(found, "aeo.robots-blocks-search-crawler")).toMatchObject([
      {
        action: "add",
        code: "User-agent: Googlebot\nUser-agent: Bingbot\nUser-agent: Applebot\nDisallow: /cart/",
      },
    ]);
  });

  it("let Googlebot in for Applebot, which follows its group", () => {
    const text = "User-agent: Googlebot\nDisallow: /\n";

    const found = aeoSiteFindings({
      crawlers: crawlersFor(text),
      llmsTxt: null,
      pageCount: 1,
    });

    expect(fixOf(found, "aeo.robots-blocks-search-crawler")).toMatchObject([
      {
        action: "replace",
        at: "User-agent: Googlebot",
        current: "Disallow: /",
        code: "Allow: /",
      },
    ]);
  });

  it("drop an undefined Content-Signal name and ask for yes or no", () => {
    const text =
      "User-agent: *\nContent-Signal: search=yes, ai-train=maybe, ai_input=no\n";

    const found = aeoSiteFindings({
      crawlers: crawlersFor(text),
      llmsTxt: null,
      pageCount: 1,
    });

    expect(fixOf(found, "aeo.content-signal-invalid")).toMatchObject([
      {
        current: "Content-Signal: search=yes, ai-train=maybe, ai_input=no",
        code: "Content-Signal: search=yes, ai-train={{yes or no}}",
      },
    ]);
  });

  it("make an unreachable robots.txt answer", () => {
    const report = crawlerAccess(robotsAt(null, 503), null, PAGE_URL, [
      PAGE_URL,
    ]);

    const found = aeoSiteFindings({
      crawlers: report,
      llmsTxt: null,
      pageCount: 1,
    });

    expect(fixOf(found, "aeo.robots-txt-unreachable")).toMatchObject([
      {
        in: "http",
        url: "https://www.example.com/robots.txt",
        current: "HTTP/1.1 503 Service Unavailable",
        code: "HTTP/1.1 200 OK\nContent-Type: text/plain",
      },
    ]);
  });

  it("write llms.txt from the audited pages", () => {
    const pages = [
      { url: "https://www.example.com/", title: "Home [beta]" },
      { url: "https://www.example.com/guides/(x)", title: null },
    ];

    const missing = aeoSiteFindings({
      crawlers: null,
      llmsTxt: llms({ status: "missing", httpStatus: 404, title: null }),
      pageCount: 2,
      pages,
    });

    expect(fixOf(missing, "aeo.llms-txt-missing")).toMatchObject([
      {
        in: "llms.txt",
        action: "add",
        at: "new file",
        code: [
          "# {{site name}}",
          "",
          "> {{one-sentence summary of what the site offers}}",
          "",
          "## Pages",
          "",
          "- [Home (beta)](https://www.example.com/): {{what it covers}}",
          "- [{{page title}}](https://www.example.com/guides/%28x%29): {{what it covers}}",
        ].join("\n"),
      },
    ]);

    // The file as written has a link per page for the re-check that reads it.
    const written = fixOf(missing, "aeo.llms-txt-missing")?.[0]?.code ?? "";

    expect(
      parseLlmsTxt("https://www.example.com/llms.txt", 200, written).links
    ).toBe(2);

    const invalid = aeoSiteFindings({
      crawlers: null,
      llmsTxt: llms({
        status: "invalid",
        problems: [
          'it does not start with an H1 title ("# Site name"); the first line is "Hello"',
        ],
      }),
      pageCount: 1,
    });

    expect(fixOf(invalid, "aeo.llms-txt-invalid")).toMatchObject([
      {
        action: "add",
        at: "first line",
        code: "# {{site name}}\n\n> {{one-sentence summary of what the site offers}}\n",
      },
    ]);

    const empty = aeoSiteFindings({
      crawlers: null,
      llmsTxt: llms({ links: 0 }),
      pageCount: 1,
    });

    expect(fixOf(empty, "aeo.llms-txt-no-links")).toMatchObject([
      {
        action: "add",
        at: "end of the file",
        code: expect.stringContaining(
          "## Pages\n\n- [{{page title}}](https://www.example.com/)"
        ),
      },
    ]);
  });

  it("ask the CDN to let a refused bot through", () => {
    const report = crawlersFor("User-agent: *\nAllow: /\n");
    report.probeBaseline = { userAgent: "agentic-seo-check", status: 200 };

    for (const bot of report.bots) {
      if (bot.name === "OAI-SearchBot") {
        bot.probe = { status: 403, blocked: true, reason: "HTTP 403" };
      }

      if (bot.name === "GPTBot") {
        bot.probe = { status: 200, blocked: true, reason: "challenge page" };
      }
    }

    const found = aeoSiteFindings({
      crawlers: report,
      llmsTxt: null,
      pageCount: 1,
    });

    expect(fixOf(found, "aeo.server-blocks-answer-bot")).toMatchObject([
      {
        in: "http",
        action: "replace",
        at: "User-Agent: OAI-SearchBot",
        current: "HTTP/1.1 403 Forbidden",
        code: "HTTP/1.1 200 OK",
        write: expect.stringContaining("CDN's bot logs"),
      },
    ]);
    expect(fixOf(found, "aeo.server-blocks-training-bot")).toMatchObject([
      {
        current: "HTTP/1.1 200 OK (challenge page)",
        write: expect.stringContaining("owner's choice"),
      },
    ]);
  });

  it("give no edit when the probe could not run, which is about the audit", () => {
    const failed = aeoSiteFindings({
      crawlers: null,
      llmsTxt: null,
      pageCount: 1,
      probeSkipped:
        "the audit's own request got HTTP 401, so a refusal could not be told apart from a page that fails for everyone",
    });

    const finding = failed.find((f) => f.rule === "aeo.bot-probe-inconclusive");
    expect(finding?.rule).toBe("aeo.bot-probe-inconclusive");
    expect(finding).not.toHaveProperty("fix");
  });
});

describe("every AEO rule", () => {
  it("fires with a complete fix in these scenarios", () => {
    const report = crawlersFor(ROBOTS);
    report.probeBaseline = { userAgent: "agentic-seo-check", status: 200 };

    for (const bot of report.bots) {
      bot.probe = { status: 403, blocked: true, reason: "HTTP 403" };
    }

    const article =
      '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"H","datePublished":"2024-05-01"}</script><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Widget Co"}</script></head><body><h1>Widgets</h1>' +
      `<p>${"word ".repeat(650)}</p></body></html>`;

    const all = [
      ...pageFindings(fixture("aeo-bad-page.html")),
      ...pageFindings(article),
      ...pageFindings('<div id="root"></div>', {
        url: "https://www.example.com/",
      }),
      ...pageFindings(
        '<html><head><meta name="robots" content="noindex, max-snippet:50, nocache"></head><body><p>x</p></body></html>'
      ),
      ...pageFindings(
        '<html><head><meta name="googlebot" content="max-snippet:50"><meta name="bingbot" content="nocache"></head><body><p>x</p></body></html>'
      ),
      ...pageFindings("<p>x</p>", { status: 500 }),
      ...pageFindings("<p>Welcome</p>", { url: "https://www.example.com/" }),
      ...aeoSiteFindings({
        crawlers: report,
        llmsTxt: llms({ status: "missing" }),
        pageCount: 1,
        probeSkipped: "it needs a live URL",
      }),
      ...aeoSiteFindings({
        crawlers: crawlersFor(
          "User-agent: *\nDisallow: /\nContent-Signal: ai-train=maybe\n"
        ),
        llmsTxt: llms({
          status: "invalid",
          problems: ["the file is empty"],
          bytes: 0,
        }),
        pageCount: 1,
      }),
      ...aeoSiteFindings({
        crawlers: crawlerAccess(robotsAt(null, 500), null, PAGE_URL, [
          PAGE_URL,
        ]),
        llmsTxt: llms({ links: 0 }),
        pageCount: 1,
      }),
    ];

    const fired = new Set(all.map((f) => f.rule));

    expect(
      AEO_RULES.map((r) => r.id).filter((id) => !fired.has(id))
    ).toStrictEqual([]);
    expect(withoutFix(all)).toStrictEqual([]);
    expect(incompleteEdits(all)).toStrictEqual([]);
  });
});

describe(pathMatches, () => {
  it.each([
    ["/", "/a", true],
    ["/guides/", "/guides/x/", true],
    ["/guides/", "/blog/", false],
    ["/*.pdf$", "/files/a.pdf", true],
    ["/*.pdf$", "/files/a.pdf?x=1", false],
    ["/a*b*c", "/a-b-c-d", true],
    ["/a$", "/a", true],
    ["/a$", "/ab", false],
    [`/${"*a".repeat(50)}$`, `/${"a".repeat(10_000)}b`, false],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(pathMatches(pattern, path)).toBe(expected);
  });
});

/** A microdata BlogPosting with dates, and `author` as the page writes it. */
const blogPosting = (author: string) =>
  `<html><head><title>Widgets</title></head><body><article itemscope itemtype="https://schema.org/BlogPosting"><h1 itemprop="headline">Widgets</h1>${author}<time itemprop="datePublished" datetime="2026-01-02">2 January 2026</time><time itemprop="dateModified" datetime="2026-01-03">3 January 2026</time><p>${"word ".repeat(400)}</p></article></body></html>`;

describe("aeo.article-author-incomplete for a microdata author written as text", () => {
  it("makes the author element a Person item, which the url then belongs to", () => {
    const before = blogPosting('<span itemprop="author">Sam Jansen</span>');
    const fix = fixOf(pageFindings(before), "aeo.article-author-incomplete");

    expect(fix).toMatchObject([
      {
        action: "add",
        at: '[itemtype$="/BlogPosting"] [itemprop="author"]',
        code: 'itemscope itemtype="https://schema.org/Person"',
      },
      {
        action: "replace",
        current: "Sam Jansen",
        code: '<span itemprop="name">Sam Jansen</span><link itemprop="url" href="{{URL of Sam Jansen\'s author page}}">',
      },
    ]);

    // The edits as an agent applies them, with the slot filled in.
    const after = before
      .replace(
        '<span itemprop="author">',
        '<span itemprop="author" itemscope itemtype="https://schema.org/Person">'
      )
      .replace(
        fix?.[1]?.current ?? "",
        (fix?.[1]?.code ?? "").replace(
          /\{\{[^}]*\}\}/u,
          "https://www.example.com/team/sam"
        )
      );

    expect(pageFindings(after).map((f) => f.rule)).not.toContain(
      "aeo.article-author-incomplete"
    );
  });
});

describe("robots.txt fixes for a percent-encoded rule", () => {
  it("matches paths the way robots-parser does", () => {
    expect(pathMatches("/blog/café", "/blog/caf%C3%A9")).toBeTruthy();
    expect(pathMatches("/a%2fb", "/a%2Fb")).toBeTruthy();
    expect(pathMatches("/a%2fb", "/a/b")).toBeFalsy();
  });

  it.each([
    ["Disallow: /blog/café", "https://www.example.com/blog/caf%C3%A9"],
    ["Disallow: /a%2fb", "https://www.example.com/a%2Fb"],
  ])(
    "edits the line that blocks the bot (%s), never adds a second group for it",
    (rule, page) => {
      const text = `User-agent: OAI-SearchBot\n${rule}\n`;

      const fix = fixOf(
        aeoSiteFindings({
          crawlers: crawlersFor(text, [page]),
          llmsTxt: null,
          pageCount: 1,
        }),
        "aeo.robots-blocks-answer-bot"
      );

      expect(fix).toContainEqual(
        expect.objectContaining({
          in: "robots.txt",
          at: "User-agent: OAI-SearchBot",
          current: rule,
        })
      );
      expect(JSON.stringify(fix)).not.toContain(
        '"code":"User-agent: OAI-SearchBot'
      );
    }
  );
});
