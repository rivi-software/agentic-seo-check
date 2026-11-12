import { describe, expect, it } from "vitest";

import { auditAeoHtml } from "../src/core/aeo/audit.js";
import { auditHtml } from "../src/core/audit.js";
import { withoutControls } from "../src/core/report/controls.js";
import {
  renderAeoMarkdown,
  renderMarkdown,
} from "../src/core/report/markdown.js";

const ESC = "\u001B";

/**
 * A page whose quoted text holds escape sequences (GHSA-f4fr-vv3h-fxwg): one that retitles the
 * window and clears the screen, an OSC 8 link, concealed text, an OSC 52 clipboard write, a C1 CSI,
 * a carriage return and a right-to-left override, in the title, the description, a heading, a link
 * and an Article's author and date. Its <img> keeps a tab between its attributes, which a fix quotes.
 */
const HOSTILE_PAGE = `<!doctype html><html lang="en"><head>
<title>Shop&#27;]0;PWNED&#7;&#27;[2J&#27;[H</title>
<meta name="description" content="Buy &#27;]8;;https://evil.test&#27;\\here&#27;]8;;&#27;\\ &#27;[8mhidden&#x9B;31m &#x202E;txt.exe">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Sale","author":{"@type":"Person","name":"Ann\\u001b]0;PWNED\\u0007"},"datePublished":"2026-01-01\\u001b[2J"}</script>
</head><body><h1>Big&#27;[2J sale&#13;over</h1><img\tsrc="a.png"><a href="/x">click&#27;]52;c;ZWNobyBoaQ==&#7;</a></body></html>`;

/** What a terminal would act on or reorder, were the report printed to it. */
const CONTROLS = [ESC, "\u0007", "\u009B", "\r", "\u202E"];

describe(withoutControls, () => {
  it("drops C0 and C1 controls, DEL and bidirectional overrides, and keeps tabs and newlines", () => {
    expect(
      withoutControls("a\u001B[2Jb\u009B31mc\r\nd\te\u007Ff\u202Eg\u2066h")
    ).toBe("a[2Jb31mc\nd\tefgh");
  });
});

describe("text from a page in the Markdown report", () => {
  it("cannot reach a terminal as an escape sequence in the SEO report", async () => {
    const audit = await auditHtml(HOSTILE_PAGE, { url: "https://shop.test/" });
    const markdown = renderMarkdown(audit);

    for (const control of CONTROLS) {
      expect(markdown).not.toContain(control);
    }

    expect(markdown).toContain("| Title | Shop]0;PWNED[2J[H (21 chars) |");
    expect(markdown).toContain('`<img\tsrc="a.png">`');
  });

  it("cannot reach a terminal as an escape sequence in the AEO report", async () => {
    const audit = await auditAeoHtml(HOSTILE_PAGE, {
      url: "https://shop.test/",
    });

    const markdown = renderAeoMarkdown(audit);

    for (const control of CONTROLS) {
      expect(markdown).not.toContain(control);
    }

    expect(markdown).toContain("| Author | Ann]0;PWNED |");
    expect(markdown).toContain("| Published / modified | 2026-01-01[2J / — |");
  });
});
