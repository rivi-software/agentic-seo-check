/**
 * The part of the pages' script that cleans an event before posthog-js sends it
 * (src/site/analytics-script.ts), run in Node as a browser would run it, on a page of the site.
 */
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { cleanMessage as coreCleanMessage } from "../../src/telemetry/exceptions.ts";
import { ANALYTICS_HELPERS_JS } from "../src/site/analytics-script.ts";
import { SITE_JS } from "../src/site/files.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface Event {
  event: string;
  properties: { [key: string]: Json };
}

interface Helpers {
  clean: (value: string) => string;
  cleanMessage: (message: string) => string;
  cleanEvent: (event: Event) => Event | null;
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
    `${ANALYTICS_HELPERS_JS}\nthis.helpers = { clean, cleanMessage, cleanEvent };`,
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
