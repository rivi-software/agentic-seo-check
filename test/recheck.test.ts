import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditAeoDirectory, auditAeoHtml } from "../src/core/aeo/audit.js";
import { auditDirectory, auditHtml } from "../src/core/audit.js";
import {
  assignIds,
  baselineFromAudit,
  baselineFromIds,
  compareWithBaseline,
} from "../src/core/recheck.js";
import { renderMarkdown } from "../src/core/report/markdown.js";
import type { Finding } from "../src/core/types.js";

const page = (title: string, body = "<p>Text</p>") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>Heading</h1>${body}</body></html>`;

const URL_A = "https://www.example.com/a";

/** An Offer whose price has a currency symbol, which structured-data.invalid-value reports. */
const ld = (price: string) =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Offer","price":"${price}","priceCurrency":"EUR"}</script>`;

/** An Offer with these properties after its @type. */
const offerWith = (props: string) =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Offer"${props}}</script>`;

const idsOf = (findings: Finding[]): string[] =>
  findings.flatMap((f) => (f.id ? [f.id] : []));

/** The rules of the findings `keep` keeps, in their order. */
const rulesWhere = (
  findings: Finding[],
  keep: (f: Finding) => boolean
): string[] => findings.flatMap((f) => (keep(f) ? [f.rule] : []));

/** A finding as a rule without a `key` would make it, for the id tests. */
const bare = (message: string): Finding => ({
  rule: "title.generic",
  severity: "warning",
  category: "title",
  message,
  recommendation: "",
  url: URL_A,
});

describe("finding ids", () => {
  it("stay the same across audits of the same page", async () => {
    const first = await auditHtml(page("React App"), { url: URL_A });
    const second = await auditHtml(page("React App"), { url: URL_A });

    expect(first.findings.map((f) => f.id)).toStrictEqual(
      second.findings.map((f) => f.id)
    );
    expect(first.findings.find((f) => f.rule === "title.generic")?.id).toMatch(
      /^title\.generic@[\da-f]{8}$/u
    );
  });

  it("differ between pages", async () => {
    const a = await auditHtml(page("React App"), { url: URL_A });

    const b = await auditHtml(page("React App"), {
      url: "https://www.example.com/b",
    });

    const idOf = (findings: typeof a.findings) =>
      findings.find((f) => f.rule === "title.generic")?.id;

    expect(idOf(a.findings)).not.toBe(idOf(b.findings));
  });

  it("are unique when a rule reports more than one finding on a page", async () => {
    const audit = await auditHtml(
      page("A title long enough to pass", ld("€5") + ld("€6")),
      {
        url: URL_A,
      }
    );

    const ids = audit.findings
      .filter((f) => f.rule === "structured-data.invalid-value")
      .map((f) => f.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("a re-check against a baseline", () => {
  it("reports what a fix resolved, what is still open and what it broke", async () => {
    const before = await auditHtml(page("React App"), { url: URL_A });

    const baseline = baselineFromIds(
      before.findings.flatMap((f) => (f.id ? [f.id] : []))
    );

    // The title is fixed, but the fix left the page without its <h1>.
    const after = await auditHtml(
      page("Blue widgets for every workshop | Acme").replace(
        "<h1>Heading</h1>",
        ""
      ),
      { url: URL_A },
      { baseline }
    );

    expect(after.baseline?.fixed.map((f) => f.rule)).toStrictEqual(
      expect.arrayContaining(["title.generic", "title.too-short"])
    );
    expect(after.baseline?.new).toContain(
      after.findings.find((f) => f.rule === "h1.missing")?.id
    );
    expect(after.baseline?.open).toStrictEqual(
      after.findings.flatMap((f) =>
        f.id && baseline.some((b) => b.id === f.id) ? [f.id] : []
      )
    );
    // The comparison reads before the findings it is about.
    expect(Object.keys(after).indexOf("baseline")).toBe(
      Object.keys(after).indexOf("findings") - 1
    );
  });

  it("calls nothing fixed that it did not check again", async () => {
    const before = await auditHtml(page("React App"), { url: URL_A });

    const baseline = baselineFromIds(
      before.findings.flatMap((f) => (f.id ? [f.id] : []))
    );

    // Only title.generic ran, and on another page: no other finding can count as fixed.
    const onlyTitle = await auditHtml(
      page("React App"),
      { url: URL_A },
      {
        baseline,
        onlyRules: ["title.generic"],
      }
    );

    expect(onlyTitle.findings.map((f) => f.rule)).toStrictEqual([
      "title.generic",
    ]);
    expect(onlyTitle.baseline).toMatchObject({
      fixed: [],
      new: [],
      notChecked: baseline.length - 1,
    });

    const otherPage = await auditHtml(
      page("Blue widgets for every workshop | Acme"),
      { url: "https://www.example.com/b" },
      { baseline }
    );

    expect(otherPage.baseline?.fixed).toStrictEqual([]);
    expect(otherPage.baseline?.notChecked).toBe(baseline.length);
  });

  it("leaves info rules unchecked when info findings are left out", async () => {
    const before = await auditHtml(page("React App"), { url: URL_A });

    const baseline = baselineFromIds(
      before.findings.flatMap((f) => (f.id ? [f.id] : []))
    );

    const after = await auditHtml(
      page("React App"),
      { url: URL_A },
      { baseline, includeInfo: false }
    );

    expect(after.baseline?.fixed).toStrictEqual([]);
  });

  it("gives the page and message of a fixed finding when the baseline is an audit", async () => {
    const before = await auditHtml(page("React App"), { url: URL_A });

    const after = await auditHtml(
      page("Blue widgets for every workshop | Acme"),
      { url: URL_A },
      { baseline: baselineFromAudit(JSON.stringify(before)) }
    );

    expect(after.baseline?.fixed).toContainEqual({
      id: before.findings.find((f) => f.rule === "title.generic")?.id,
      rule: "title.generic",
      url: URL_A,
      message:
        'Title "React App" looks like a placeholder or framework default.',
    });
    expect(renderMarkdown(after)).toContain("## Re-check");
  });

  it("refuses rule ids it does not know, and AEO rules in the SEO audit", async () => {
    await expect(
      auditHtml(page("x"), {}, { onlyRules: ["title.too-lng"] })
    ).rejects.toThrow(/Unknown rule id\(s\): title\.too-lng/u);
    await expect(
      auditHtml(page("x"), {}, { onlyRules: ["aeo.nosnippet"] })
    ).rejects.toThrow(/not SEO rules; run the AEO audit/u);
    await expect(
      auditAeoHtml(page("x"), {}, { onlyRules: ["title.missing"] })
    ).rejects.toThrow(/not AEO rules/u);
  });

  it("refuses a category of the other audit, and names the categories it takes (issue #121)", async () => {
    await expect(
      auditHtml(page("x"), {}, { onlyRules: ["aeo"] })
    ).rejects.toMatchObject({
      name: "RuleNamesError",
      reason: "other_audit_rules",
      message: expect.stringMatching(
        /^aeo is not SEO rules; run the AEO audit/u
      ),
    });
    await expect(
      auditAeoHtml(page("x"), {}, { onlyRules: ["structured-data"] })
    ).rejects.toMatchObject({
      reason: "other_audit_rules",
      message: expect.stringMatching(/not AEO rules; run the SEO audit/u),
    });
    await expect(
      auditHtml(page("x"), {}, { onlyRules: ["structured-data", "schema"] })
    ).rejects.toMatchObject({
      reason: "unknown_rules",
      message: expect.stringMatching(
        /^Unknown rule id\(s\): schema\. Name rule ids, or their categories \(title, meta, .*structured-data.*\)\./u
      ),
    });
    await expect(
      auditAeoHtml(page("x"), {}, { onlyRules: ["aeo.no-such-rule"] })
    ).rejects.toThrow(/their categories \(aeo\)\./u);
  });

  it("takes a category for its rules, in onlyRules and in disableRules (issue #121)", async () => {
    const html = page("React App", ld("€12"));
    const all = await auditHtml(html, { url: URL_A });

    // Both categories are on the page, so leaving one out shows.
    expect(
      rulesWhere(all.findings, (f) => f.category === "title")
    ).not.toHaveLength(0);
    expect(
      rulesWhere(all.findings, (f) => f.category === "structured-data")
    ).not.toHaveLength(0);

    const only = await auditHtml(
      html,
      { url: URL_A },
      { onlyRules: ["structured-data", "title.generic"] }
    );

    expect(only.findings.map((f) => f.rule)).toStrictEqual(
      rulesWhere(
        all.findings,
        (f) => f.category === "structured-data" || f.rule === "title.generic"
      )
    );

    const without = await auditHtml(
      html,
      { url: URL_A },
      { disableRules: ["title"] }
    );

    expect(without.findings.map((f) => f.rule)).toStrictEqual(
      rulesWhere(all.findings, (f) => f.category !== "title")
    );

    // The AEO audit's one category is all its rules.
    const aeoHtml = page("Opening hours", "<h2>When are you open?</h2>");
    const aeo = await auditAeoHtml(aeoHtml, { url: URL_A });

    const aeoOnly = await auditAeoHtml(
      aeoHtml,
      { url: URL_A },
      { onlyRules: ["aeo"] }
    );

    expect(aeoOnly.findings).toStrictEqual(aeo.findings);
  });

  it("re-checks a category's rules and leaves the rest unchecked (issue #121)", async () => {
    const before = await auditHtml(page("React App", ld("€12")), {
      url: URL_A,
    });

    const after = await auditHtml(
      page("React App", ld("12.00")),
      { url: URL_A },
      {
        onlyRules: ["structured-data"],
        baseline: baselineFromIds(idsOf(before.findings)),
      }
    );

    expect(after.baseline?.fixed.map((f) => f.rule)).toContain(
      "structured-data.invalid-value"
    );
    expect(
      rulesWhere(after.findings, (f) => f.category !== "structured-data")
    ).toStrictEqual([]);
    expect(after.baseline?.notChecked).toBe(
      before.findings.filter((f) => f.category !== "structured-data").length
    );
  });
});

describe("a re-check of a build directory", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "recheck-"));
    await writeFile(
      path.join(dir, "index.html"),
      page("React App", '<a href="/about.html">About</a>')
    );
    await writeFile(
      path.join(dir, "about.html"),
      page("React App", '<a href="/">Home</a>')
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("compares site and page findings, and refuses a baseline without page findings", async () => {
    const before = await auditDirectory(dir);

    await writeFile(
      path.join(dir, "about.html"),
      page("About Acme: who builds the blue widgets", '<a href="/">Home</a>')
    );

    const after = await auditDirectory(dir, {
      baseline: baselineFromAudit(JSON.stringify(before)),
    });

    const fixedRules = after.baseline?.fixed.map((f) => f.rule) ?? [];
    expect(fixedRules).toContain("title.generic");
    expect(fixedRules).toContain("site.duplicate-titles");
    expect(after.baseline?.notChecked).toBe(0);

    const summary = await auditDirectory(dir, { pageDetail: "summary" });

    expect(() => baselineFromAudit(JSON.stringify(summary))).toThrow(
      /--page-detail full/u
    );
  });

  it("refuses an AEO baseline without page findings too", async () => {
    const summary = await auditAeoDirectory(dir, { pageDetail: "summary" });
    const full = await auditAeoDirectory(dir, { pageDetail: "full" });

    expect(full.findings.some((f) => f.url !== undefined)).toBeTruthy();
    expect(() => baselineFromAudit(JSON.stringify(summary))).toThrow(
      /--page-detail full/u
    );
    expect(baselineFromAudit(JSON.stringify(full))).toHaveLength(
      full.findings.length
    );
  });

  it("calls a site finding about llms.txt fixed once the file is there", async () => {
    const before = await auditAeoDirectory(dir, { pageDetail: "full" });

    expect(before.findings.map((f) => f.rule)).toContain(
      "aeo.llms-txt-missing"
    );

    await writeFile(
      path.join(dir, "llms.txt"),
      "# Acme\n\n> Blue widgets.\n\n## Pages\n\n- [Home](http://localhost/): the home page\n"
    );

    const after = await auditAeoDirectory(dir, {
      pageDetail: "full",
      baseline: baselineFromAudit(JSON.stringify(before)),
    });

    expect(after.baseline?.fixed.map((f) => f.rule)).toContain(
      "aeo.llms-txt-missing"
    );
  });
});

describe("a re-check of a rule that reports several findings on a page", () => {
  it("calls the fixed one fixed and keeps the other's id", async () => {
    const before = await auditHtml(
      page("A title long enough to pass", ld("€5") + ld("€6")),
      { url: URL_A }
    );

    const offers = before.findings.filter(
      (f) => f.rule === "structured-data.invalid-value"
    );

    expect(offers.map((f) => f.message)).toStrictEqual([
      expect.stringContaining("€5"),
      expect.stringContaining("€6"),
    ]);

    // The first Offer is fixed; the second, still wrong, must keep its id.
    const after = await auditHtml(
      page("A title long enough to pass", ld("5") + ld("€6")),
      { url: URL_A },
      {
        baseline: baselineFromAudit(JSON.stringify(before)),
        onlyRules: ["structured-data.invalid-value"],
      }
    );

    expect(after.baseline?.fixed).toStrictEqual([
      {
        id: offers[0]?.id,
        rule: "structured-data.invalid-value",
        url: URL_A,
        message: offers[0]?.message,
      },
    ]);
    expect(after.baseline?.open).toStrictEqual([offers[1]?.id]);
    expect(after.baseline?.new).toStrictEqual([]);
  });

  it("keeps the other's id when the fix deletes the first one's markup", async () => {
    const before = await auditHtml(
      page("A title long enough to pass", ld("€5") + ld("€6")),
      { url: URL_A }
    );

    const offers = before.findings.filter(
      (f) => f.rule === "structured-data.invalid-value"
    );

    // The "€5" Offer is gone, so the "€6" one is now the page's first structured data item.
    const after = await auditHtml(
      page("A title long enough to pass", ld("€6")),
      { url: URL_A },
      {
        baseline: baselineFromAudit(JSON.stringify(before)),
        onlyRules: ["structured-data.invalid-value"],
      }
    );

    expect(after.baseline).toStrictEqual({
      fixed: [
        {
          id: offers[0]?.id,
          rule: "structured-data.invalid-value",
          url: URL_A,
          message: offers[0]?.message,
        },
      ],
      open: [offers[1]?.id],
      new: [],
      // The other rules' findings: --rule left them out.
      notChecked: expect.any(Number),
    });
  });

  it("never calls a numbered finding fixed, since which is which can change", () => {
    const scope = { urls: [URL_A], site: false, ruleRan: () => true };
    const two = [bare("first"), bare("second")];
    assignIds(two);

    expect(idsOf(two)).toStrictEqual([
      expect.stringMatching(/~1$/u),
      expect.stringMatching(/~2$/u),
    ]);

    const one = [bare("second")];
    assignIds(one);

    // The one left was there before under a number: still open, not something a fix caused.
    expect(
      compareWithBaseline(one, baselineFromIds(idsOf(two)), scope)
    ).toStrictEqual({
      fixed: [],
      open: idsOf(one),
      new: [],
      notChecked: 2,
    });

    // The other way round: one finding before, two numbered ones now.
    expect(
      compareWithBaseline(two, baselineFromIds(idsOf(one)), scope)
    ).toStrictEqual({
      fixed: [],
      open: idsOf(two),
      new: [],
      notChecked: 1,
    });
  });

  it("numbers only the findings that share a key, and keeps the rest's re-check exact", async () => {
    const offers = (html: string) =>
      auditHtml(page("A title long enough to pass", html), { url: URL_A });

    const before = await offers(ld("€5") + ld("€5") + ld("€7"));

    const ids = before.findings
      .filter((f) => f.rule === "structured-data.invalid-value")
      .map((f) => f.id);

    expect(ids).toStrictEqual([
      expect.stringMatching(/~1$/u),
      expect.stringMatching(/~2$/u),
      expect.not.stringMatching(/~/u),
    ]);

    // The "€7" Offer is fixed and a new "€8" one is added; the two "€5" ones stay numbered.
    const after = await auditHtml(
      page("A title long enough to pass", ld("€5") + ld("€5") + ld("€8")),
      { url: URL_A },
      {
        baseline: baselineFromAudit(JSON.stringify(before)),
        onlyRules: ["structured-data.invalid-value"],
      }
    );

    const newOffer = after.findings.find((f) => f.message.includes("€8"));

    expect(after.baseline).toMatchObject({
      fixed: [{ id: ids[2] }],
      open: [ids[0], ids[1]],
      new: [newOffer?.id],
    });
  });
});

/** Audits `before`, then `after` against it with only `rules`: the first findings and the comparison. */
const recheckPage = async (before: string, after: string, rules: string[]) => {
  const first = await auditHtml(page("A title long enough to pass", before), {
    url: URL_A,
  });

  const second = await auditHtml(
    page("A title long enough to pass", after),
    { url: URL_A },
    {
      baseline: baselineFromAudit(JSON.stringify(first)),
      onlyRules: rules,
    }
  );

  return { first: first.findings, baseline: second.baseline };
};

describe("a re-check after a fix to an earlier JSON-LD script", () => {
  const product = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Blue widget"}</script>`;

  it("keeps a later item's finding open when an earlier script starts to parse", async () => {
    const broken = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme",}</script>`;
    const repaired = broken.replace('"Acme",}', '"Acme"}');

    const { first, baseline } = await recheckPage(
      broken + product,
      repaired + product,
      ["structured-data.invalid-json", "structured-data.missing-required"]
    );

    const idOf = (rule: string) => first.find((f) => f.rule === rule)?.id;

    expect(baseline).toMatchObject({
      fixed: [{ id: idOf("structured-data.invalid-json") }],
      open: [idOf("structured-data.missing-required")],
      new: [],
    });
  });

  it("keeps a later script's invalid-json finding open when an earlier empty one is removed", async () => {
    const empty = '<script type="application/ld+json"></script>';

    const broken =
      '<script type="application/ld+json">{"name": "X",,}</script>';

    const { first, baseline } = await recheckPage(empty + broken, broken, [
      "structured-data.invalid-json",
    ]);

    expect(baseline).toMatchObject({
      fixed: [{ id: first[0]?.id }],
      open: [first[1]?.id],
      new: [],
    });
  });

  it("keeps a missing-property finding open when only some of the properties are added", async () => {
    const { first, baseline } = await recheckPage(
      offerWith(""),
      offerWith(',"price":"19.99"'),
      ["structured-data.missing-required"]
    );

    const missing = first.filter(
      (f) => f.rule === "structured-data.missing-required"
    );

    expect(missing.map((f) => f.message)).toStrictEqual([
      "Offer is missing required: price, priceCurrency.",
    ]);
    expect(baseline).toMatchObject({
      fixed: [],
      open: [missing[0]?.id],
      new: [],
    });
  });

  it("keeps an invalid-json finding open when a fix leaves the script still broken", async () => {
    // A trailing comma and an unquoted key: removing the comma alone still leaves invalid JSON.
    const broken = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",name:"Blue widget",}</script>`;

    const { first, baseline } = await recheckPage(
      broken,
      broken.replace('",}', '"}'),
      ["structured-data.invalid-json"]
    );

    const invalid = first.filter(
      (f) => f.rule === "structured-data.invalid-json"
    );

    expect(invalid).toHaveLength(1);
    expect(baseline).toMatchObject({
      fixed: [],
      open: [invalid[0]?.id],
      new: [],
    });
  });
});

describe("a re-check with info findings left out", () => {
  // head.metadata-in-body is a warning rule that reports streamed metadata as info.
  const streamed = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loading</title></head><body><h1>Blue widgets</h1><div hidden id="S:0"><title>Blue widgets for home workshops</title><meta name="description" content="Blue widgets."></div></body></html>`;

  it("does not call an info finding fixed that it only hid", async () => {
    const before = await auditHtml(streamed, { url: URL_A });

    const info = before.findings.find(
      (f) => f.rule === "head.metadata-in-body"
    );

    expect(info?.severity).toBe("info");

    for (const baseline of [
      baselineFromAudit(JSON.stringify(before)),
      baselineFromIds(idsOf(before.findings)),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- two baselines, one after the other
      const after = await auditHtml(
        streamed,
        { url: URL_A },
        { baseline, includeInfo: false }
      );

      expect(after.findings.map((f) => f.rule)).not.toContain(
        "head.metadata-in-body"
      );
      expect(after.baseline?.fixed).toStrictEqual([]);
    }
  });
});
