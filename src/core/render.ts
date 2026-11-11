import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { Browser } from "playwright";
import type * as Playwright from "playwright";

import { ExpectedError } from "./errors.js";
import { DEFAULT_USER_AGENT } from "./fetch.js";

export class RenderUnavailableError extends ExpectedError {
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
  "Playwright installs with agentic-seo-check as an optional dependency, so it is missing only where optional dependencies were left out (`--omit=optional`, `--no-optional`): reinstall with them, or add `playwright` next to agentic-seo-check.";

export const BROWSER_INSTALL_HINT =
  "Install Google Chrome, or download the Chromium build this Playwright expects with `agentic-seo-check install-browser` (`npx @rivi-software/agentic-seo-check install-browser` with npx).";

/**
 * Downloads the Chromium build the installed Playwright expects, through Playwright's own CLI: a
 * build fetched by `npx playwright install` for another Playwright version does not launch.
 */
export const installBrowser = async (
  options: { withDeps?: boolean } = {}
): Promise<void> => {
  let manifestPath: string;

  try {
    manifestPath = createRequire(import.meta.url).resolve(
      "playwright/package.json"
    );
  } catch {
    throw new RenderUnavailableError(
      `Playwright is not installed. ${RENDER_INSTALL_HINT}`
    );
  }

  // SAFETY: the manifest of an installed package; a missing bin fails the spawn below.
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
    bin?: { playwright?: string };
  };

  const cli = path.join(
    path.dirname(manifestPath),
    manifest.bin?.playwright ?? "cli.js"
  );

  const args = [cli, "install", "chromium"];

  if (options.withDeps) {
    args.push("--with-deps");
  }

  // Playwright's progress goes to stderr, like the CLI's own: stdout is for reports.
  const child = spawn(process.execPath, args, {
    stdio: ["inherit", 2, "inherit"],
  });

  await once(child, "close");

  if (child.exitCode !== 0) {
    throw new Error(
      `playwright install chromium exited with ${child.exitCode ?? child.signalCode}.`
    );
  }
};

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
        `Could not launch Chromium: ${firstLine(error instanceof Error ? error.message : String(error))}. ${BROWSER_INSTALL_HINT}`
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
      // A page that does not load (`net::ERR_CONNECTION_REFUSED`, as from a dev server that is not
      // running) is the site's failure, not a bug of ours (issue #60).
      if (error instanceof Error && /net::ERR_/u.test(error.message)) {
        throw new ExpectedError(error.message, { cause: error });
      }

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
