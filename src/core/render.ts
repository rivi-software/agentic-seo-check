import type { Browser } from "playwright";
import type * as Playwright from "playwright";

import { DEFAULT_USER_AGENT } from "./fetch.js";

export class RenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderUnavailableError";
  }
}

export interface RenderOptions {
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  viewport?: { width: number; height: number };
  /** Wait condition passed to Playwright. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface RenderOutput {
  html: string;
  finalUrl: string;
  consoleErrors: string[];
}

export const RENDER_INSTALL_HINT =
  "Install Playwright to enable rendering: `pnpm add -D playwright && pnpm exec playwright install chromium` (or npm/npx equivalents).";

const launchSystemBrowser = async (
  playwright: typeof Playwright
): Promise<Browser | null> => {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one browser at a time, in order of preference
      return await playwright.chromium.launch({ headless: true, channel });
    } catch {
      /* try next */
    }
  }

  return null;
};

const firstLine = (message: string): string =>
  message.split("\n")[0] ?? message;

/** Load the page in headless Chromium and return the rendered DOM. */
export const renderPage = async (
  url: string,
  options: RenderOptions = {}
): Promise<RenderOutput> => {
  let playwright: typeof Playwright;

  try {
    playwright = await import("playwright");
  } catch {
    throw new RenderUnavailableError(
      `Playwright is not installed. ${RENDER_INSTALL_HINT}`
    );
  }

  let browser: Browser;

  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    // No downloaded Playwright browser: fall back to an installed Google Chrome / Edge.
    const fallback = await launchSystemBrowser(playwright);

    if (!fallback) {
      throw new RenderUnavailableError(
        `Could not launch Chromium: ${firstLine(error instanceof Error ? error.message : String(error))}. ${RENDER_INSTALL_HINT}`
      );
    }

    browser = fallback;
  }

  const timeout = options.timeoutMs ?? 30_000;
  const consoleErrors: string[] = [];

  try {
    const context = await browser.newContext({
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      viewport: options.viewport ?? { width: 1366, height: 900 },
      extraHTTPHeaders: options.headers,
    });

    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text().slice(0, 300));
      }
    });
    page.on("pageerror", (err) =>
      consoleErrors.push(err.message.slice(0, 300))
    );

    try {
      await page.goto(url, {
        waitUntil: options.waitUntil ?? "networkidle",
        timeout,
      });
    } catch (error) {
      // networkidle can time out on pages with long-polling; fall back to whatever has loaded.
      if (!(error instanceof Error) || !/Timeout/iu.test(error.message)) {
        throw error;
      }
    }

    await page.waitForTimeout(250);
    const html = await page.content();

    return { html, finalUrl: page.url(), consoleErrors };
  } finally {
    // A browser that fails to close must not replace the page's result or its error.
    await browser.close().catch(() => null);
  }
};
