import { readFileSync } from "node:fs";

import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";

import { comparePages, compactComparison } from "../src/core/compare.js";
import { renderComparisonMarkdown } from "../src/core/report/markdown.js";
import { renderComparisonText } from "../src/core/report/text.js";
import type {
  ComparedPage,
  Comparison,
  Finding,
  SkippedPage,
} from "../src/core/types.js";
import { comparisonReport } from "../src/telemetry/report.js";
import { incompleteEdits, unquotedEdits } from "./helpers/fixes.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import type { FixtureServer } from "./helpers/fixture-server.js";

/** An article with what answer engines look for: a linked author, dates, answers, a table. */
const GOOD = readFileSync(
  new URL("fixtures/aeo-good-page.html", import.meta.url),
  "utf-8"
);

const SENTENCE =
  "Our widgets are made in Utrecht from steel and aluminium, and each one is tested on a real bench before it ships.";

/**
 * The page to compare: more text than the competitors, but an Article without an author or dates,
 * a question heading with no answer under it, no table, list or FAQ, and a title without the
 * keyword.
 */
const OURS = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Widgets for every bench | Widget Shop</title><meta name="description" content="Widgets for every bench, made in Utrecht from steel and aluminium and tested before they ship to you."><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Widgets"}</script></head><body><main><h1>Widgets for every bench</h1><p>${Array.from({ length: 50 }, () => SENTENCE).join(" ")}</p><h2>Why buy a widget from us?</h2><h2>Prices</h2><p>${SENTENCE}</p></main></body></html>`;

const robots = (body: string) => ({
  headers: { "content-type": "text/plain" },
  body,
});

const LLMS_TXT = {
  headers: { "content-type": "text/plain" },
  body: "# Widget Co\n\n> Guides to workshop widgets.\n\n## Guides\n\n- [Choose a widget](/a): sizes and materials\n",
};

const isRead = (p: ComparedPage | SkippedPage): p is ComparedPage =>
  "signals" in p;

/** The Authorization header of each request a server got since its `from`th. */
const authorizations = (server: FixtureServer, from: number) =>
  server.requestHeaders.slice(from).map((h) => h.authorization ?? null);

/** The gaps as findings, for the fix helpers every rule's tests use. */
const gapFindings = (c: Comparison): Finding[] =>
  c.gaps.map((g) => ({
    rule: g.signal,
    severity: "info",
    category: "aeo",
    message: g.message,
    recommendation: "",
    fix: g.fix,
  }));

describe(comparePages, () => {
  let ours: FixtureServer;
  let theirs: FixtureServer;
  let page: string;

  beforeAll(async () => {
    ours = await startFixtureServer({
      "/widgets": { body: OURS },
      "/gone": { status: 404, body: "<title>Gone</title>" },
      "/robots.txt": robots("User-agent: PerplexityBot\nDisallow: /\n"),
    });
    theirs = await startFixtureServer({
      "/a": { body: GOOD },
      "/b": { body: GOOD },
      "/robots.txt": robots("User-agent: *\nAllow: /\n"),
      "/llms.txt": LLMS_TXT,
    });
    page = `${ours.origin}/widgets`;
  });

  afterAll(async () => {
    await Promise.all([ours.close(), theirs.close()]);
  });

  /** The comparison of the page with both competitors, and its gaps by signal. */
  const compareBoth = async () => {
    const c = await comparePages(page, [
      `${theirs.origin}/a`,
      `${theirs.origin}/b`,
    ]);

    return {
      c,
      gaps: new Map(
        c.gaps.map((g) => [g.type ? `${g.signal} ${g.type}` : g.signal, g])
      ),
    };
  };

  it("lists what the competitors have that the page lacks", async () => {
    const { c, gaps } = await compareBoth();

    expect(Object.keys(c)).toStrictEqual([
      "schemaVersion",
      "kind",
      "url",
      "auditedAt",
      "pages",
      "gaps",
      "leads",
    ]);
    expect(c).toMatchObject({
      schemaVersion: 1,
      kind: "comparison",
      url: page,
    });
    expect([...gaps.keys()].toSorted()).toStrictEqual([
      "aiBots",
      "author",
      "dates",
      "dates.visible",
      "headings.answered",
      "lists",
      "llmsTxt",
      "structuredData FAQPage",
      "tables",
    ]);
    // Both competitors have each of them, so each gap names both.
    expect(new Set(c.gaps.map((g) => g.competitors.join(" ")))).toStrictEqual(
      new Set([`${theirs.origin}/a ${theirs.origin}/b`])
    );
  });

  it("closes a gap with the fix of the rule that covers it, and leaves the rest to the author", async () => {
    const { c, gaps } = await compareBoth();

    expect(Object.fromEntries(gaps)).toMatchObject({
      author: {
        message:
          "An author in the Article markup, with a url or sameAs: 2 of 2 competitors, not this page (none).",
        rules: ["aeo.article-author-missing"],
      },
      "headings.answered": { rules: ["aeo.question-not-answered-first"] },
      aiBots: {
        message:
          "Every AI search crawler and answer bot let in by robots.txt: 2 of 2 competitor sites, not this site (keeps out PerplexityBot).",
        rules: ["aeo.robots-blocks-answer-bot"],
      },
      llmsTxt: { rules: ["aeo.llms-txt-missing"] },
      // What no rule covers on this page carries no edit: the author writes it.
      tables: { rules: [], fix: [] },
      lists: { rules: [], fix: [] },
      "structuredData FAQPage": { type: "FAQPage", rules: [], fix: [] },
      "dates.visible": { rules: [], fix: [] },
    });
    expect(
      c.gaps.filter((g) => g.rules.length > 0 && g.fix.length === 0)
    ).toStrictEqual([]);
  });

  it("gives a gap's fix complete, quoting the page as written", async () => {
    const c = await comparePages(page, [`${theirs.origin}/a`]);
    const findings = gapFindings(c);

    expect(incompleteEdits(findings)).toStrictEqual([]);
    expect(unquotedEdits(findings, OURS)).toStrictEqual([]);
  });

  it("lists where the page is ahead, and reads each page's signals", async () => {
    const c = await comparePages(page, [`${theirs.origin}/a`]);

    expect(c.leads.map((l) => l.signal)).toStrictEqual(["words"]);
    expect(c.leads[0]?.message).toMatch(
      /^More text: this page \([\d,]+ words\), not 1 of 1 competitor \(\d+ words\)\.$/u
    );

    const [mine, competitor] = c.pages;
    assert(mine && isRead(mine) && competitor && isRead(competitor));

    expect(mine).toMatchObject({
      role: "page",
      title: "Widgets for every bench | Widget Shop",
      h1: "Widgets for every bench",
      signals: {
        headings: { h2: 2, questions: 1, answered: 0 },
        tables: 0,
        structuredData: ["Article"],
        author: "none",
        dates: { published: false, modified: false, visible: false },
        aiBots: { answerBotsBlocked: ["PerplexityBot"] },
        llmsTxt: false,
      },
    });
    expect(competitor).toMatchObject({
      role: "competitor",
      signals: {
        headings: { questions: 2, answered: 2 },
        tables: 1,
        lists: 1,
        structuredData: ["Article", "FAQPage"],
        author: "linked",
        dates: { published: true, modified: true, visible: true },
        aiBots: { blocked: 0, answerBotsBlocked: [] },
        llmsTxt: true,
      },
    });
    // Neither was asked for.
    expect([mine.signals.keywordIn, mine.signals.coreWebVitals]).toStrictEqual([
      undefined,
      undefined,
    ]);
  });

  it("reads the keyword on every page, and closes its gaps with the keyword rules' fix", async () => {
    const c = await comparePages(page, [`${theirs.origin}/a`], {
      keyword: "workshop widget",
    });

    expect(Object.keys(c).slice(2, 5)).toStrictEqual([
      "url",
      "keyword",
      "auditedAt",
    ]);

    const [mine] = c.pages;
    assert(mine && isRead(mine));
    expect(mine.signals.keywordIn).toStrictEqual({
      title: false,
      h1: false,
      description: false,
      body: false,
    });
    // Beside the other text signals, before the site's.
    expect(Object.keys(mine.signals).slice(7, 9)).toStrictEqual([
      "keywordIn",
      "aiBots",
    ]);

    expect(c.gaps.find((g) => g.signal === "keywordIn.title")).toMatchObject({
      message:
        '"workshop widget" in the title: 1 of 1 competitor, not this page.',
      rules: ["keyword.not-in-title"],
      fix: [
        { current: "<title>Widgets for every bench | Widget Shop</title>" },
      ],
    });
  });

  it("reads each page once, and each site's robots.txt and llms.txt once", async () => {
    const before = theirs.requests.length;

    await comparePages(page, [`${theirs.origin}/a`, `${theirs.origin}/b`]);

    const sent = theirs.requests.slice(before);
    expect(sent.toSorted()).toStrictEqual([
      "/a",
      "/b",
      "/llms.txt",
      "/robots.txt",
    ]);
  });

  it("sends the user's headers to the page's own origin alone, never to a competitor", async () => {
    const before = {
      ours: ours.requestHeaders.length,
      theirs: theirs.requestHeaders.length,
    };

    await comparePages(page, [`${theirs.origin}/a`], {
      fetch: { headers: { Authorization: "Basic c3RhZ2luZw==" } },
    });

    expect(new Set(authorizations(ours, before.ours))).toStrictEqual(
      new Set(["Basic c3RhZ2luZw=="])
    );
    expect(new Set(authorizations(theirs, before.theirs))).toStrictEqual(
      new Set([null])
    );
  });

  it("lists a competitor it cannot read with why, and leaves it out of the gaps", async () => {
    const unreachable = "http://127.0.0.1:9/";

    const c = await comparePages(
      page,
      [`${ours.origin}/gone`, unreachable, `${theirs.origin}/a`],
      { fetch: { timeoutMs: 5000 } }
    );

    expect(c.pages.slice(1, 3)).toStrictEqual([
      {
        url: `${ours.origin}/gone`,
        role: "competitor",
        skipped: {
          reason: "http-error",
          message: `${ours.origin}/gone answered HTTP 404.`,
        },
      },
      {
        url: unreachable,
        role: "competitor",
        skipped: {
          reason: "unreachable",
          message: expect.stringMatching(
            /^http:\/\/127\.0\.0\.1:9\/ did not answer/u
          ),
        },
      },
    ]);

    // One competitor read: each gap is of one, never of three.
    expect(c.gaps.length).toBeGreaterThan(0);

    for (const gap of c.gaps) {
      expect(gap.message).toContain("1 of 1 competitor");
      expect(gap.competitors).toStrictEqual([`${theirs.origin}/a`]);
    }

    expect(comparisonReport(c)).toMatchObject({ pages: 2 });
  });

  it("fails when the page itself cannot be read, before it requests a competitor", async () => {
    const before = theirs.requests.length;

    await expect(
      comparePages(`${ours.origin}/gone`, [`${theirs.origin}/a`])
    ).rejects.toThrow(
      `${ours.origin}/gone answered HTTP 404. There is nothing to compare: audit the page on its own to see why.`
    );
    expect(theirs.requests).toHaveLength(before);
  });

  it("stays quiet when the competitors have what the page has", async () => {
    const c = await comparePages(`${theirs.origin}/a`, [`${theirs.origin}/b`]);

    expect(c.gaps).toStrictEqual([]);
    expect(c.leads).toStrictEqual([]);
  });

  it("takes each competitor once and never the page itself", async () => {
    await expect(comparePages(page, [page])).rejects.toThrow(
      "Name at least one competitor's page other than the page itself."
    );
    await expect(
      comparePages(
        page,
        ["a", "b", "c", "d", "e", "f"].map((p) => `${theirs.origin}/${p}`)
      )
    ).rejects.toThrow(
      "Compare with at most 5 competitors' pages; 6 were given."
    );
    await expect(comparePages(page, ["./dist"])).rejects.toThrow(
      '"./dist" is not an http(s) URL: a comparison reads live pages.'
    );

    const c = await comparePages(page, [
      `${theirs.origin}/a`,
      `${theirs.origin}/a`,
      page,
    ]);

    expect(c.pages.map((p) => p.role)).toStrictEqual(["page", "competitor"]);
  });

  it("renders for a person and as Markdown", async () => {
    const c = await comparePages(page, [`${theirs.origin}/a`]);
    const text = renderComparisonText(c, { nextSteps: true });
    const markdown = renderComparisonMarkdown(c);

    for (const line of [
      `Comparison · ${page}`,
      `Gaps (${c.gaps.length})`,
      "Closed by aeo.article-author-missing.",
      "Every edit in full: run again with -o report.md",
    ]) {
      expect(text).toContain(line);
    }

    expect(markdown).toContain(`# Comparison: ${page}`);
    expect(markdown).toContain("Closed by: `aeo.article-author-missing`");
  });

  it("trims long lists for an agent", async () => {
    const c = await comparePages(page, [`${theirs.origin}/a`]);

    const compact = compactComparison({
      ...c,
      pages: c.pages.map((p) =>
        isRead(p)
          ? {
              ...p,
              signals: {
                ...p.signals,
                structuredData: Array.from({ length: 20 }, (_, i) => `T${i}`),
              },
            }
          : p
      ),
    });

    const [first] = compact.pages;
    assert(first && isRead(first));
    expect(first.signals.structuredData).toHaveLength(10);
  });
});
