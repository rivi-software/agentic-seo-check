/**
 * The part of the pages' script that cleans an event before posthog-js sends it
 * (src/site/analytics-script.ts), run in Node as a browser would run it, on a page of the site.
 */
import { runInNewContext } from "node:vm";

import { is } from "css-select";
import { isTag, isText } from "domhandler";
import type { AnyNode, Element } from "domhandler";
import { describe, expect, it } from "vitest";

import { auditAeoHtml } from "../../src/core/aeo/audit.ts";
import { auditHtml } from "../../src/core/audit.ts";
import { parseDocument } from "../../src/core/html/dom.ts";
import { cleanMessage as coreCleanMessage } from "../../src/telemetry/exceptions.ts";
import { ANALYTICS_HELPERS_JS } from "../src/site/analytics-script.ts";
import { SITE_JS } from "../src/site/files.ts";
import { homePage } from "../src/site/home.ts";
import { renderReport } from "../src/site/report.ts";
import { shareMenu, sharePage } from "../src/site/share-page.ts";
import { signShare } from "../src/site/share.ts";
import {
  progressClose,
  progressLine,
  progressOpen,
} from "../src/site/site-report.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface Event {
  event: string;
  properties: { [key: string]: Json };
}

/** What the recorder hands maskAttribute: an element that answers `closest`. */
interface Closest {
  closest: (selector: string) => object | null;
}

interface Helpers {
  clean: (value: string) => string;
  cleanMessage: (message: string) => string;
  cleanEvent: (event: Event) => Event | null;
  PRIVATE: string;
  maskAttribute: (name: string, value: string, element: Closest) => string;
}

/** The globals the script finds, and where it leaves its helpers. */
interface ScriptContext {
  location: URL;
  URL: typeof URL;
  helpers?: Helpers;
}

const helpers = (href: string): Helpers => {
  const context: ScriptContext = {
    location: new URL(href),
    URL,
  };

  runInNewContext(
    `${ANALYTICS_HELPERS_JS}\nthis.helpers = { clean, cleanMessage, cleanEvent, PRIVATE, maskAttribute };`,
    context
  );

  if (!context.helpers) {
    throw new Error("The script defined no helpers.");
  }

  return context.helpers;
};

const page = helpers(
  "https://agentic-seo.org/share/abc123?url=https%3A%2F%2Fshop.example%2F"
);

/** An event the script cleaned, as plain JSON: what it built belongs to the script's own realm. */
const cleaned = (event: Event): Event | null => {
  const result = page.cleanEvent(event);

  return result && structuredClone(result);
};

const exception = (filename: string): Event => ({
  event: "$exception",
  properties: {
    $exception_list: [
      {
        type: "SyntaxError",
        value: 'Unexpected token "secret page text"',
        stacktrace: { frames: [{ filename, lineno: 1, colno: 2 }] },
      },
    ],
    $exception_message: 'Unexpected token "secret page text"',
    $exception_values: ['Unexpected token "secret page text"'],
    $exception_steps: [{ message: "a step" }],
  },
});

describe("the pages' event cleaning", () => {
  it("is part of the pages' script", () => {
    expect(SITE_JS).toContain(ANALYTICS_HELPERS_JS);
    expect(SITE_JS).toContain("before_send: cleanEvent");
  });

  it("takes a share link's result and the form's address out of the site's own addresses", () => {
    expect(
      [
        "https://agentic-seo.org/share/abc123",
        "/?url=https%3A%2F%2Fshop.example%2F#audit",
        "https://mcp.agentic-seo.rivi.software/rules?url=x",
        "https://shop.example/?url=kept",
        "not a url",
      ].map((value) => page.clean(value))
    ).toStrictEqual([
      "https://agentic-seo.org/share/:result",
      "/",
      "https://mcp.agentic-seo.rivi.software/rules",
      "https://shop.example/?url=kept",
      "not a url",
    ]);
  });

  it("cleans an error's message as the tool cleans its own", () => {
    const messages = [
      "Unexpected token '<', \"<!doctype h\"... is not valid JSON",
      "Cannot read properties of undefined (reading 'href')",
      "Failed to fetch https://shop.example/private?token=1 for bäckerei-müller.de",
      "write to owner@shop.example from 192.168.1.10",
      "x".repeat(5000),
    ];

    expect(messages.map((message) => page.cleanMessage(message))).toStrictEqual(
      messages.map((message) => coreCleanMessage(message))
    );
    expect(
      messages.map((message) => page.cleanMessage(message)).join("\n")
    ).not.toContain("doctype");
  });

  it("cleans a Web Vitals event's nested address, and drops the share page's title", () => {
    const event = cleaned({
      event: "$web_vitals",
      properties: {
        $current_url: "https://agentic-seo.org/share/abc123",
        title: "shop.example scored 71",
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 812,
          $current_url:
            "https://agentic-seo.org/share/abc123?url=https%3A%2F%2Fshop.example",
        },
      },
    });

    expect(event).toStrictEqual({
      event: "$web_vitals",
      properties: {
        $current_url: "https://agentic-seo.org/share/:result",
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 812,
          $current_url: "https://agentic-seo.org/share/:result",
        },
      },
    });
  });

  it("drops an object nested deeper than any event posthog-js builds, rather than send it unread", () => {
    let deep: Json = { $current_url: "https://agentic-seo.org/share/abc123" };

    for (let level = 0; level < 10; level += 1) {
      deep = { nested: deep };
    }

    const event = cleaned({ event: "custom", properties: { deep } });

    expect(JSON.stringify(event)).not.toContain("abc123");
  });

  it("sends an error of the site's scripts with its message cleaned, and none from elsewhere", () => {
    const ours = cleaned(exception("https://agentic-seo.org/site.js"));

    expect(JSON.stringify(ours)).not.toContain("secret page text");
    expect(ours?.properties).not.toHaveProperty("$exception_steps");
    expect(ours?.properties.$exception_message).toBe("Unexpected token <text>");
    expect(
      cleaned(exception("chrome-extension://abcdef/content.js"))
    ).toBeNull();
  });
});

/** `element`, or the nearest element around it, that `selector` matches, as the browser's `closest`. */
const closest = (element: Element, selector: string): Element | null => {
  for (let node: AnyNode | null = element; node; node = node.parent) {
    if (isTag(node) && is(node, selector)) {
      return node;
    }
  }

  return null;
};

const AUDITED = "https://shop.example.com/pricing?plan=team";

/**
 * Every page that can show an audited address, with that address everywhere it can be: the form
 * filled with it and refused, the wait for a crawl and its pages, the report with its share menu,
 * and the page a share link opens.
 */
const pagesWithTheAddress = async (): Promise<string[]> => {
  const html =
    "<html><head><title>React App</title></head><body><a href='/about'>About</a></body></html>";

  const seo = await auditHtml(html, {
    url: AUDITED,
    source: "url",
    target: AUDITED,
  });

  const aeo = await auditAeoHtml(html, { url: AUDITED });

  const link = await signShare(
    { SHARE_KEY: "the key that signs" },
    {
      kind: "page",
      url: AUDITED,
      day: "2026-11-14",
      seo: { score: seo.score, counts: { error: 1, warning: 2, info: 3 } },
      aeo: { score: aeo.score, counts: { error: 0, warning: 1, info: 2 } },
      pages: 1,
    }
  );

  if (!link) {
    throw new Error("signShare made no link with a key");
  }

  const state = {
    open: true,
    crawls: true,
    siteKey: "1x00000000000000000000BB",
    url: AUDITED,
  };

  return [
    homePage({
      ...state,
      error: `The site at ${AUDITED} answered 403.`,
      failure: "refused",
    }),
    homePage({
      ...state,
      crawling: true,
      report: `${progressOpen(AUDITED)}${progressLine({
        phase: "crawl",
        message: `200 ${AUDITED}`,
        crawled: 1,
        discovered: 4,
      })}${progressClose(`The crawl of ${AUDITED} stopped.`, "refused")}`,
    }),
    homePage({
      ...state,
      report: renderReport(seo, aeo, false, shareMenu(link)),
    }),
    sharePage(link),
  ];
};

describe("what a session recording shows (issue #181)", () => {
  it("is set up in the pages' script, masking fields and the private parts", () => {
    expect(SITE_JS).toContain("maskTextSelector: PRIVATE");
    expect(SITE_JS).toContain("maskAttributeFn: maskAttribute");
    expect(SITE_JS).toContain("maskAllInputs: true");
    expect(SITE_JS).toContain('import("/ph-recorder.js")');
    expect(SITE_JS).not.toContain("disable_session_recording");
  });

  it("masks every text and attribute of the pages that names the audited site", async () => {
    const leaks: string[] = [];

    for (const html of await pagesWithTheAddress()) {
      const walk = (node: AnyNode) => {
        if (isText(node)) {
          const { parent } = node;

          // The recorder replaces a script's text, and the site's styles name no address.
          if (
            node.data.includes("shop.example") &&
            parent &&
            isTag(parent) &&
            !["script", "style"].includes(parent.name) &&
            !closest(parent, page.PRIVATE)
          ) {
            leaks.push(`text in <${parent.name}>: ${node.data.trim()}`);
          }
        }

        if (isTag(node)) {
          const element = {
            closest: (selector: string) => closest(node, selector),
          };

          for (const [name, value] of Object.entries(node.attribs)) {
            const shown = page.maskAttribute(name, value, element);

            // The address, or a share link's token, which holds it.
            if (/shop\.example|\/share\/[\w-]+\./u.test(shown)) {
              leaks.push(`<${node.name} ${name}="${shown}">`);
            }
          }

          for (const child of node.children) {
            walk(child);
          }
        }
      };

      for (const child of parseDocument(html).children) {
        walk(child);
      }
    }

    expect(leaks).toStrictEqual([]);
  });

  it("keeps the site's own copy, links and the look of a private part", () => {
    const outside: Closest = { closest: () => null };
    const inside: Closest = { closest: () => ({}) };

    expect([
      page.maskAttribute("href", "/rules", outside),
      page.maskAttribute(
        "href",
        "https://agentic-seo.org/?url=https%3A%2F%2Fshop.example%2F#audit",
        outside
      ),
      page.maskAttribute("value", "https://shop.example/", outside),
      page.maskAttribute("placeholder", "https://example.com/pricing", outside),
      page.maskAttribute("class", "finding sev-error", inside),
      page.maskAttribute("data-rule", "title.generic", inside),
      page.maskAttribute("href", "https://shop.example/", inside),
      page.maskAttribute("content", "shop.example scored 71", inside),
    ]).toStrictEqual([
      "/rules",
      "https://agentic-seo.org/",
      "*********************",
      "https://example.com/pricing",
      "finding sev-error",
      "title.generic",
      "*********************",
      "************ ****** **",
    ]);
  });

  it("cleans each address a recording's events name", () => {
    const event = cleaned({
      event: "$snapshot",
      properties: {
        $snapshot_data: [
          {
            type: 4,
            data: { href: "https://agentic-seo.org/share/abc123", width: 800 },
          },
          {
            type: 5,
            data: {
              tag: "$pageview",
              payload: {
                href: "https://agentic-seo.org/?url=https%3A%2F%2Fshop.example.com%2F",
              },
            },
          },
          {
            type: 5,
            data: {
              tag: "$url_changed",
              payload: { href: "/rules?url=shop.example" },
            },
          },
          { type: 2, data: "compressed" },
        ],
      },
    });

    expect(event?.properties.$snapshot_data).toStrictEqual([
      {
        type: 4,
        data: { href: "https://agentic-seo.org/share/:result", width: 800 },
      },
      {
        type: 5,
        data: {
          tag: "$pageview",
          payload: { href: "https://agentic-seo.org/" },
        },
      },
      { type: 5, data: { tag: "$url_changed", payload: { href: "/rules" } } },
      { type: 2, data: "compressed" },
    ]);
  });

  it("sends a recording's data as the recorder masked it, and cleans the rest of its event", () => {
    const deep = {
      a: { b: { c: { d: { e: { f: { g: { href: "/x" } } } } } } },
    };

    const event = cleaned({
      event: "$snapshot",
      properties: {
        $current_url: "https://agentic-seo.org/share/abc123",
        $snapshot_data: [deep],
      },
    });

    expect(event).toStrictEqual({
      event: "$snapshot",
      properties: {
        $current_url: "https://agentic-seo.org/share/:result",
        $snapshot_data: [deep],
      },
    });
  });
});
