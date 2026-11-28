import { describe, expect, it, vi } from "vitest";

import { HOSTED_LIMITS } from "../../src/core/hosted.ts";
import { RenderUnavailableError } from "../../src/core/render.ts";
import { serverBrowser } from "../src/browser.ts";
import type { BrowserLauncher } from "../src/browser.ts";

/** Browser Run's binding, which the launcher only passes on. */
const BINDING = { fetch: () => Promise.resolve(new Response()) };

const reasonOf = async (launching: Promise<unknown>) => {
  try {
    await launching;

    return "launched";
  } catch (error) {
    return error;
  }
};

describe("the premium server's browser (issue #230)", () => {
  it("launches Browser Run with guardrails that deny the browser any traffic of its own", async () => {
    const browser = {};
    const launch = vi.fn<BrowserLauncher>(() => Promise.resolve(browser));

    await expect(serverBrowser(BINDING, launch).launch()).resolves.toBe(
      browser
    );
    expect(launch).toHaveBeenCalledWith(BINDING, {
      guardrails: { allowedDomains: [] },
    });
  });

  it("holds a render to the hosted server's requests and bytes in flight", () => {
    const browser = serverBrowser(BINDING);

    expect({
      maxRequests: browser.maxRequests,
      maxBytesInFlight: browser.maxBytesInFlight,
    }).toStrictEqual({ maxRequests: 200, maxBytesInFlight: 16_000_000 });
    expect(browser.maxRequests).toBe(HOSTED_LIMITS.maxRenderRequests);
    expect(browser.maxBytesInFlight).toBe(HOSTED_LIMITS.maxRenderBytesInFlight);
  });

  it("says rendering is unavailable without the binding, and launches nothing", async () => {
    const launch = vi.fn<BrowserLauncher>();
    const error = await reasonOf(serverBrowser(undefined, launch).launch());

    expect(error).toBeInstanceOf(RenderUnavailableError);
    expect(String(error)).toContain("This server has no browser");
    expect(launch).not.toHaveBeenCalled();
  });

  it("says rendering is unavailable when Browser Run has no browser free", async () => {
    const launch = vi.fn<BrowserLauncher>(() =>
      Promise.reject(
        new Error(
          "Unable to create new browser: code: 429: message: Rate limit exceeded"
        )
      )
    );

    const error = await reasonOf(serverBrowser(BINDING, launch).launch());

    expect(error).toBeInstanceOf(RenderUnavailableError);
    expect(String(error)).toContain("no browser free");
  });

  it("lets any other failure through, for error tracking", async () => {
    const failure = new Error("Browser Run answered 500");
    const launch = vi.fn<BrowserLauncher>(() => Promise.reject(failure));

    await expect(serverBrowser(BINDING, launch).launch()).rejects.toBe(failure);
  });
});
