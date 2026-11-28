import { describe, expect, it } from "vitest";

import type {
  BrowserAnswer,
  BrowserRequest,
  FetchThrough,
  RequestLike,
  RouteLike,
} from "../src/core/render-fetch.js";
import { pageConsoleErrors, renderPage } from "../src/core/render.js";
import type {
  RenderBrowser,
  RenderConsoleMessage,
} from "../src/core/render.js";

const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-1";

describe(pageConsoleErrors, () => {
  it("leaves out Chromium's failed-to-load errors for the requests the audit blocked or failed", () => {
    const failed = new Set([GTAG, "https://cdn.example/app.js"]);

    expect(
      pageConsoleErrors(
        [
          {
            text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT",
            url: GTAG,
          },
          {
            text: "Failed to load resource: net::ERR_FAILED",
            url: "https://cdn.example/app.js",
          },
          {
            text: `Refused to execute script from '${GTAG}' because its MIME type is not executable.`,
            url: "https://example.com/",
          },
        ],
        failed
      )
    ).toStrictEqual([]);
  });

  it("keeps the page's own errors, and a failed load the audit did not cause", () => {
    expect(
      pageConsoleErrors(
        [
          {
            text: "Failed to load resource: the server responded with a status of 404 ()",
            url: "https://example.com/missing.js",
          },
          {
            text: "Failed to load resource: net::ERR_NAME_NOT_RESOLVED",
            url: "https://gone.example/lib.js",
          },
          { text: "TypeError: x is undefined", url: "" },
        ],
        new Set([GTAG])
      )
    ).toStrictEqual([
      "Failed to load resource: the server responded with a status of 404 ()",
      "Failed to load resource: net::ERR_NAME_NOT_RESOLVED",
      "TypeError: x is undefined",
    ]);
  });

  it("leaves out a message only for a failed URL named whole, not one that begins a longer URL", () => {
    const failed = new Set(["https://cdn.example/app.js"]);

    expect(
      pageConsoleErrors(
        [
          {
            text: "Refused to execute script from 'https://cdn.example/app.js?v=2' because its MIME type is not executable.",
            url: "https://example.com/",
          },
          {
            text: "Uncaught SyntaxError at https://cdn.example/app.jsx",
            url: "https://example.com/",
          },
          {
            text: "Refused to execute script from 'https://cdn.example/app.js' because its MIME type is not executable.",
            url: "https://example.com/",
          },
          {
            text: "Script https://cdn.example/app.js failed",
            url: "https://example.com/",
          },
          {
            text: "Could not load https://cdn.example/app.js",
            url: "https://example.com/",
          },
        ],
        failed
      )
    ).toStrictEqual([
      "Refused to execute script from 'https://cdn.example/app.js?v=2' because its MIME type is not executable.",
      "Uncaught SyntaxError at https://cdn.example/app.jsx",
    ]);
  });

  it("cuts each error it keeps to 300 characters", () => {
    expect(
      pageConsoleErrors([{ text: "x".repeat(1000), url: "" }], new Set())
    ).toStrictEqual(["x".repeat(300)]);
  });
});

/**
 * A browser that launches nothing (AGENTS.md): its navigation asks the context's route for the page
 * and then for `subresources`, and logs Chromium's console error for each one the route aborted.
 */
const fakeBrowser = (subresources: string[]): RenderBrowser => {
  let handler:
    | ((route: RouteLike & { request: () => RequestLike }) => Promise<void>)
    | undefined;

  const listeners: ((message: RenderConsoleMessage) => void)[] = [];
  let current = "about:blank";

  const ask = async (url: string, navigation: boolean): Promise<boolean> => {
    let aborted = false;

    await handler?.({
      request: () => ({
        url: () => url,
        method: () => "GET",
        allHeaders: () => Promise.resolve({}),
        resourceType: () => (navigation ? "document" : "script"),
        isNavigationRequest: () => navigation,
        frame: () => ({ parentFrame: () => null }),
      }),
      abort: () => {
        aborted = true;

        return Promise.resolve();
      },
      fulfill: () => Promise.resolve(),
    });

    return aborted;
  };

  const page = {
    context: () => ({ newCDPSession: () => Promise.reject(new Error("no")) }),
    on: (
      event: "console" | "pageerror",
      listener:
        | ((message: RenderConsoleMessage) => void)
        | ((error: Error) => void)
    ) => {
      if (event === "console") {
        // SAFETY: a "console" listener takes console messages (RenderPage's overloads).
        listeners.push(listener as (message: RenderConsoleMessage) => void);
      }

      return page;
    },
    goto: async (url: string) => {
      current = url;
      await ask(url, true);

      for (const resource of subresources) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one request after another, as listed
        if (await ask(resource, false)) {
          for (const listener of listeners) {
            listener({
              type: () => "error",
              text: () => "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT",
              location: () => ({ url: resource }),
            });
          }
        }
      }

      return null;
    },
    waitForTimeout: () => Promise.resolve(),
    content: () => Promise.resolve("<html></html>"),
    url: () => current,
  };

  return {
    newContext: () =>
      Promise.resolve({
        route: (_url, answer) => {
          handler = answer;

          return Promise.resolve({});
        },
        routeWebSocket: () => Promise.resolve(),
        newPage: () => Promise.resolve(page),
      }),
    close: () => Promise.resolve(),
  };
};

describe("renderPage through a supplied browser's network", () => {
  it("counts the requests it blocked, leaves their errors out, and hands each answer back once delivered", async () => {
    const asked: BrowserRequest[] = [];
    const delivered: BrowserAnswer[] = [];
    const blocked = "https://tracker.example/t.js";

    const through: FetchThrough = Object.assign(
      (request: BrowserRequest): Promise<BrowserAnswer> => {
        asked.push(request);

        return Promise.resolve(
          request.url === blocked
            ? { kind: "fail", reason: "BlockedByClient" }
            : {
                kind: "fulfil",
                status: 200,
                headers: [],
                body: new Uint8Array(),
              }
        );
      },
      { delivered: (answer: BrowserAnswer) => delivered.push(answer) }
    );

    const output = await renderPage("https://example.com/", {
      launch: () =>
        Promise.resolve(fakeBrowser(["https://example.com/app.js", blocked])),
      fetchThrough: through,
    });

    expect({
      navigation: asked.map((r) => r.navigation),
      blockedRequests: output.blockedRequests,
      consoleErrors: output.consoleErrors,
      delivered: delivered.length,
    }).toStrictEqual({
      navigation: [true, false, false],
      blockedRequests: 1,
      consoleErrors: [],
      delivered: 3,
    });
  });
});
