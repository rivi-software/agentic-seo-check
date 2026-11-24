/**
 * The premium server's browser (issue #230): Browser Run, through `@cloudflare/playwright`, for a
 * subscriber's `render`. The core routes every request the browser makes through the audit's own
 * gated, signed fetch (src/core/render-fetch.ts), so the browser fetches nothing itself. Its
 * guardrails deny it all outbound traffic as well, so a request the routing ever missed fails
 * instead of leaving with Browser Run's identity.
 */
import type {
  BrowserWorker,
  WorkersLaunchOptions,
} from "@cloudflare/playwright";
import type { Browser } from "playwright";

import { RenderUnavailableError } from "../../src/core/render.js";
import type { HostedProfile } from "../../src/mcp-hosted.js";

/** `@cloudflare/playwright`'s `launch`, or a test's stand-in for it. */
export type BrowserLauncher = (
  binding: BrowserWorker,
  options: WorkersLaunchOptions
) => Promise<object>;

/** An empty list of allowed domains denies the session every request of its own. */
const LAUNCH_OPTIONS: WorkersLaunchOptions = {
  guardrails: { allowedDomains: [] },
};

/**
 * Browser Run's answer when it has no browser free: more new browsers in a minute than the
 * account may start (the spike saw it past 10 at once).
 */
const NO_BROWSER_FREE = /Unable to create new browser: code: 429\b/u;

/**
 * Loads the package only when a render launches: it is the whole Playwright client, which no other
 * call needs to parse.
 */
const launchBrowserRun: BrowserLauncher = async (binding, options) => {
  const { launch } = await import("@cloudflare/playwright");

  return await launch(binding, options);
};

/**
 * The browser a subscriber's render launches: Browser Run with guardrails, or, without the
 * binding or a browser free, the `tool.render-unavailable` finding (RenderUnavailableError).
 */
export const serverBrowser = (
  binding: BrowserWorker | undefined,
  launch: BrowserLauncher = launchBrowserRun
): NonNullable<HostedProfile["browser"]> => ({
  launch: async () => {
    if (!binding) {
      throw new RenderUnavailableError(
        "This server has no browser to render with. Audit the page without `render`, or try again later."
      );
    }

    try {
      // SAFETY: `@cloudflare/playwright` is Playwright's client for Browser Run, with Playwright's
      // own Browser API; the core calls only what both have (newContext, routing, pages, close).
      return (await launch(binding, LAUNCH_OPTIONS)) as Browser;
    } catch (error) {
      if (error instanceof Error && NO_BROWSER_FREE.test(error.message)) {
        throw new RenderUnavailableError(
          "The server's browsers are all in use (Browser Run has no browser free). Try again in a minute, or audit the page without `render`."
        );
      }

      throw error;
    }
  },
});
