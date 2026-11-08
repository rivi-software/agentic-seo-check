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

async function launchSystemBrowser(
  playwright: typeof import("playwright")
): Promise<import("playwright").Browser | null> {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return await playwright.chromium.launch({ headless: true, channel });
    } catch {
      /* try next */
    }
  }

  return null;
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

/** Load the page in headless Chromium and return the rendered DOM. */
export async function renderPage(
  url: string,
  options: RenderOptions = {}
): Promise<RenderOutput> {
  let playwright: typeof import("playwright");

  try {
    playwright = await import("playwright");
  } catch {
    throw new RenderUnavailableError(
      `Playwright is not installed. ${RENDER_INSTALL_HINT}`
    );
  }

  let browser: import("playwright").Browser;

  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (err) {
    // No downloaded Playwright browser: fall back to an installed Google Chrome / Edge.
    const fallback = await launchSystemBrowser(playwright);

    if (!fallback) {
      throw new RenderUnavailableError(
        `Could not launch Chromium: ${firstLine((err as Error).message)}. ${RENDER_INSTALL_HINT}`
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
    } catch (err) {
      // networkidle can time out on pages with long-polling; fall back to whatever has loaded.
      if (!(err instanceof Error) || !/Timeout/i.test(err.message)) {
        throw err;
      }
    }

    await page.waitForTimeout(250);
    const html = await page.content();

    return { html, finalUrl: page.url(), consoleErrors };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
