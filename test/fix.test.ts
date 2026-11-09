import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditAeoHtml } from "../src/core/aeo/audit.js";
import { auditHtml } from "../src/core/audit.js";
import { extractPage } from "../src/core/html/extract.js";
import {
  escapeAttribute,
  isCut,
  setAttributeEdit,
  withAttribute,
  withContent,
  withoutAttribute,
} from "../src/core/rules/fix.js";
import { incompleteEdits, unquotedEdits } from "./helpers/fixes.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

const FIXTURES = [
  "bad-page.html",
  "good-page.html",
  "aeo-bad-page.html",
  "aeo-good-page.html",
];

describe(withAttribute, () => {
  it("adds an attribute before the end of the tag", () => {
    expect(withAttribute('<img src="/a.png">', "alt", "")).toBe(
      '<img src="/a.png" alt="">'
    );
    expect(withAttribute('<img src="/a.png" />', "alt", "x")).toBe(
      '<img src="/a.png" alt="x" />'
    );
    expect(withAttribute("<html>", "lang", "en")).toBe('<html lang="en">');
  });

  it("replaces the value of an attribute the tag has, in any quoting", () => {
    expect(
      withAttribute('<meta name="description" content="Old">', "content", "New")
    ).toBe('<meta name="description" content="New">');
    expect(withAttribute("<img src=/a.png ALT=old>", "alt", "new")).toBe(
      '<img src=/a.png alt="new">'
    );
    expect(
      withAttribute("<a href='/x' target=_blank>", "rel", "noopener")
    ).toBe("<a href='/x' target=_blank rel=\"noopener\">");
  });

  it("does not take text inside another attribute's value for an attribute", () => {
    expect(withAttribute('<img title=" alt=x" src="/a.png">', "alt", "y")).toBe(
      '<img title=" alt=x" src="/a.png" alt="y">'
    );
  });

  it("refuses a quote that was cut short or is not a start tag", () => {
    expect(
      withAttribute('<img src="data:image/png;base64,AAA…', "alt", "")
    ).toBeNull();
    expect(withAttribute("img src=x", "alt", "")).toBeNull();
    expect(withAttribute('<img src="/a.png', "alt", "")).toBeNull();
  });
});

describe(withoutAttribute, () => {
  it("removes every copy of the attribute", () => {
    expect(
      withoutAttribute('<a href="/x" rel="nofollow" rel=ugc>', "rel")
    ).toBe('<a href="/x">');
  });
});

describe(withContent, () => {
  it("swaps an element's content and keeps its attributes", () => {
    expect(withContent("<title>Old</title>", "New")).toBe("<title>New</title>");
    expect(
      withContent('<title data-react-helmet="true">Old</title>', "New")
    ).toBe('<title data-react-helmet="true">New</title>');
  });
});

describe(setAttributeEdit, () => {
  it("replaces the whole tag when it can rewrite it, else adds the attribute at the selector", () => {
    expect(
      setAttributeEdit('<img src="/a.png">', "img", "alt", "")
    ).toStrictEqual({
      in: "html",
      action: "replace",
      at: "img",
      current: '<img src="/a.png">',
      code: '<img src="/a.png" alt="">',
    });
    expect(
      setAttributeEdit('<img src="data:…', 'img[src^="data:"]', "alt", "")
    ).toStrictEqual({
      in: "html",
      action: "add",
      at: 'img[src^="data:"]',
      code: 'alt=""',
    });
  });
});

describe(escapeAttribute, () => {
  it("escapes quotes and only the ampersands that would read as a reference", () => {
    expect(escapeAttribute('Say "hi"')).toBe("Say &quot;hi&quot;");
    expect(escapeAttribute("/a?x=1&y=2")).toBe("/a?x=1&y=2");
    expect(escapeAttribute("&copy;")).toBe("&amp;copy;");
  });
});

describe("quoted markup", () => {
  it("quotes tags as the HTML writes them", () => {
    const html =
      '<html lang=en><head><TITLE>One</TITLE><meta name="description"\n content="D"></head><body><img src=/a.png><a href="/x" class=b>X</a></body></html>';

    const page = extractPage(html, { url: "https://a.test/" });
    expect(page.markup.html).toBe("<html lang=en>");
    expect(page.markup.titles).toStrictEqual(["<TITLE>One</TITLE>"]);
    expect(page.markup.metaDescriptions).toStrictEqual([
      '<meta name="description"\n content="D">',
    ]);
    expect(page.images[0]?.tag).toBe("<img src=/a.png>");
    expect(page.links[0]?.tag).toBe('<a href="/x" class=b>');
  });

  it("has no tag for an element the parser added", () => {
    const page = extractPage("<title>T</title><p>x</p>", {
      url: "https://a.test/",
    });

    expect(page.markup.html).toBeNull();
    expect(page.markup.head).toBeNull();
  });

  it("cuts a long tag short and marks the cut", () => {
    const page = extractPage(
      `<img src="data:image/png;base64,${"A".repeat(2000)}">`,
      { url: "https://a.test/" }
    );

    const tag = page.images[0]?.tag ?? "";
    expect(tag).toHaveLength(500);
    expect(isCut(tag)).toBeTruthy();
  });
});

/** The SEO and AEO findings of a fixture page, and its HTML. */
const audits = async (name: string) => {
  const html = fixture(name);
  const input = { url: "https://www.example.com/widgets/blue/" };
  const seo = await auditHtml(html, input);
  const aeo = await auditAeoHtml(html, input);

  return { html, findings: [...seo.findings, ...aeo.findings] };
};

describe("fixes on the fixture pages", () => {
  it.each(FIXTURES)(
    "%s: every quoted `current` is in the page as written",
    async (name) => {
      const { html, findings } = await audits(name);
      expect(unquotedEdits(findings, html)).toStrictEqual([]);
    }
  );

  it.each(FIXTURES)("%s: every edit is complete", async (name) => {
    const { findings } = await audits(name);
    expect(incompleteEdits(findings)).toStrictEqual([]);
  });

  it("fixes the title and description of the bad page with edits that quote it", async () => {
    const audit = await auditHtml(fixture("bad-page.html"), {
      url: "https://www.example.com/x",
    });

    const fixOf = (rule: string) =>
      audit.findings.find((f) => f.rule === rule)?.fix;

    expect(fixOf("title.multiple")).toStrictEqual([
      {
        in: "html",
        action: "remove",
        at: "title",
        current: "<title>Second title</title>",
      },
    ]);
    expect(fixOf("title.generic")).toMatchObject([
      {
        in: "html",
        action: "replace",
        current: "<title>React App</title>",
        code: "<title>{{page title}}</title>",
      },
    ]);
    expect(fixOf("meta-description.missing")).toMatchObject([
      {
        in: "html",
        action: "add",
        at: "head",
        code: '<meta name="description" content="{{page description}}">',
      },
    ]);
  });
});
