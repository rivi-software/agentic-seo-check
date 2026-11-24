import type { Browser } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequestRefusedError } from "../src/core/fetch.js";
import * as render from "../src/core/render.js";
import { RenderUnavailableError } from "../src/core/render.js";
import { startFixtureServer } from "./helpers/fixture-server.js";

// The tests launch no browser (AGENTS.md), and renderPage is what the audit calls: it is the seam.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock(import("../src/core/render.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  renderPage: vi.fn<typeof render.renderPage>(),
}));

// SAFETY: renderPage is mocked, so nothing reads the browser; only its identity is passed on.
const fakeBrowser = {} as Browser;

const HTML =
  "<!doctype html><html lang=en><head><title>Hello</title></head><body><h1>Hi</h1></body></html>";

const rendered = {
  html: HTML,
  finalUrl: "",
  consoleErrors: [],
};

const withServer = async <T>(run: (url: string) => Promise<T>): Promise<T> => {
  const server = await startFixtureServer({
    "/": { body: HTML, headers: { "content-type": "text/html" } },
  });

  try {
    return await run(server.origin);
  } finally {
    await server.close();
  }
};

describe("audit with a supplied browser", () => {
  const mocked = vi.mocked(render.renderPage);

  beforeEach(() => {
    mocked.mockReset();
  });

  it("hands renderPage launch and a fetchThrough function", async () => {
    await withServer(async (url) => {
      mocked.mockResolvedValue({ ...rendered, finalUrl: `${url}/` });

      const launch = vi.fn<() => Promise<Browser>>(() =>
        Promise.resolve(fakeBrowser)
      );

      const { auditUrl } = await import("../src/core/audit.js");

      await auditUrl(url, { render: true, browser: { launch } });

      const options = mocked.mock.calls[0]?.[1];

      expect(options?.launch).toBe(launch);
      expect(options?.fetchThrough).toBeTypeOf("function");
    });
  });

  it("gives renderPage neither without a browser", async () => {
    await withServer(async (url) => {
      mocked.mockResolvedValue({ ...rendered, finalUrl: `${url}/` });
      const { auditUrl } = await import("../src/core/audit.js");

      await auditUrl(url, { render: true });

      const options = mocked.mock.calls[0]?.[1];

      expect(options?.launch).toBeUndefined();
      expect(options?.fetchThrough).toBeUndefined();
    });
  });

  it("still gives tool.render-unavailable when the launch is unavailable", async () => {
    await withServer(async (url) => {
      mocked.mockRejectedValue(new RenderUnavailableError("No browser."));
      const { auditUrl } = await import("../src/core/audit.js");

      const audit = await auditUrl(url, {
        render: true,
        browser: { launch: () => Promise.resolve(fakeBrowser) },
      });

      expect(audit.findings.map((f) => f.rule)).toContain(
        "tool.render-unavailable"
      );
    });
  });

  it("answers with the site's refusal when the page itself is refused", async () => {
    await withServer(async (url) => {
      const { auditUrl } = await import("../src/core/audit.js");
      let asked = 0;

      mocked.mockImplementation(async (target, options) => {
        const answer = await options?.fetchThrough?.({
          url: target,
          method: "GET",
          headers: {},
          resourceType: "Document",
        });

        expect(answer).toStrictEqual({
          kind: "fail",
          reason: "BlockedByClient",
        });
        throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${target}`);
      });

      await expect(
        auditUrl(url, {
          render: true,
          browser: { launch: () => Promise.resolve(fakeBrowser) },
          fetch: {
            gate: {
              beforeRequest: () => {
                asked += 1;

                // The audit's own fetch passes; the browser's navigation is refused.
                return asked > 1
                  ? { scope: "url", reason: "robots_txt", message: "No." }
                  : undefined;
              },
            },
          },
        })
      ).rejects.toBeInstanceOf(RequestRefusedError);
    });
  });
});
