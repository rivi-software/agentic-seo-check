import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";

import type * as Playwright from "playwright";

import { browserRequestHeaders, hasHeaders } from "./browser-headers.js";
import { ExpectedError } from "./errors.js";
import { DEFAULT_USER_AGENT } from "./fetch.js";
import { answerRoute, browserRequestOf } from "./render-fetch.js";
import type {
  FetchThrough,
  RenderRequestLimits,
  RequestLike,
  RouteLike,
} from "./render-fetch.js";

export class RenderUnavailableError extends ExpectedError {
  constructor(message: string) {
    super(message);
    this.name = "RenderUnavailableError";
  }
}

/** A console message, as renderPage reads it. */
export interface RenderConsoleMessage {
  type: () => string;
  text: () => string;
  /** Where the message came from: for a resource that failed to load, the resource's URL. */
  location: () => { url: string };
}

/** The part of a CDP session that sends the user's headers to the audited origin only. */
export interface RenderCdpSession {
  on: (
    event: "Fetch.requestPaused",
    listener: (paused: {
      requestId: string;
      request: { url: string; headers: Record<string, string> };
    }) => void
  ) => object;
  send: {
    (
      method: "Fetch.continueRequest",
      params: { requestId: string; headers: { name: string; value: string }[] }
    ): Promise<object>;
    (
      method: "Fetch.enable",
      params: { patterns: { urlPattern: string }[] }
    ): Promise<object>;
  };
}

/** The part of Playwright's Page that renderPage uses. */
export interface RenderPage {
  /**
   * Playwright's `newCDPSession` takes its own Page, which this type does not name: the page passed
   * is the one whose context this is.
   */
  context: () => {
    newCDPSession: (page: never) => Promise<RenderCdpSession>;
  };
  on: {
    (
      event: "console",
      listener: (message: RenderConsoleMessage) => void
    ): object;
    (event: "pageerror", listener: (error: Error) => void): object;
  };
  goto: (
    url: string,
    options: {
      waitUntil: "load" | "domcontentloaded" | "networkidle";
      timeout: number;
    }
  ) => Promise<object | null>;
  waitForTimeout: (timeout: number) => Promise<void>;
  content: () => Promise<string>;
  url: () => string;
}

/** The part of Playwright's BrowserContext that renderPage uses. */
export interface RenderContext {
  route: (
    url: string,
    handler: (
      route: RouteLike & { request: () => RequestLike }
    ) => Promise<void>
  ) => Promise<object>;
  routeWebSocket: (
    url: string,
    handler: (socket: { close: () => Promise<void> }) => Promise<void>
  ) => Promise<void>;
  newPage: () => Promise<RenderPage>;
}

/**
 * The part of a Playwright Browser that renderPage uses: Playwright's own, or another client's with
 * the same API, such as `@cloudflare/playwright`'s for Browser Run. A structural type, so the
 * library's types never need Playwright, which is optional.
 */
export interface RenderBrowser {
  newContext: (options: {
    userAgent: string;
    viewport: { width: number; height: number };
    serviceWorkers: "allow" | "block";
  }) => Promise<RenderContext>;
  close: () => Promise<void>;
}

/** A browser the caller supplies for a render, and what that render may send and hold. */
export interface SuppliedBrowser extends RenderRequestLimits {
  launch: () => Promise<RenderBrowser>;
}

export interface RenderOptions {
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  viewport?: { width: number; height: number };
  /** Wait condition passed to Playwright. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /**
   * Starts the browser instead of the installed Playwright (the hosted server's Browser Run).
   * Given, neither `import("playwright")` nor the fallback to an installed Chrome runs.
   */
  launch?: () => Promise<RenderBrowser>;
  /**
   * Sends every request the browser makes, so the browser fetches nothing itself (issue #230): it
   * applies the gate, the signature, the User-Agent and the rule for the user's headers, so
   * `headers` is not used. Service workers are blocked and WebSockets closed, since neither would
   * go through it.
   */
  fetchThrough?: FetchThrough;
}

export interface RenderOutput {
  html: string;
  finalUrl: string;
  consoleErrors: string[];
  /**
   * With `fetchThrough`: the browser's requests that were blocked (a refusal, a limit, a method
   * other than GET and HEAD) rather than sent.
   */
  blockedRequests?: number;
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
  options: {
    withDeps?: boolean;
    /**
     * Each line Playwright prints, instead of printing it: the CLI shows the download on its
     * progress line. Without it, Playwright's output goes to stderr as it is.
     */
    onLine?: (line: string) => void;
  } = {}
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

  const { onLine } = options;

  // Playwright's progress goes to stderr, like the CLI's own: stdout is for reports.
  const child = spawn(process.execPath, args, {
    stdio: onLine ? ["inherit", "pipe", "pipe"] : ["inherit", 2, "inherit"],
  });

  if (onLine) {
    for (const output of [child.stdout, child.stderr]) {
      if (output) {
        createInterface({ input: output, crlfDelay: Infinity }).on(
          "line",
          onLine
        );
      }
    }
  }

  await once(child, "close");

  if (child.exitCode !== 0) {
    throw new Error(
      `playwright install chromium exited with ${child.exitCode ?? child.signalCode}.`
    );
  }
};

const launchSystemBrowser = async (
  playwright: typeof Playwright
): Promise<Playwright.Browser | null> => {
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

/**
 * Puts the user's headers on the page's requests to the audited origin, and on no other: see
 * `browserRequestHeaders`.
 */
const sendHeadersToOrigin = async (
  page: RenderPage,
  headers: Record<string, string>,
  url: string
): Promise<void> => {
  // SAFETY: `page` is a page of the browser whose context is asked, which is what it takes.
  const client = await page.context().newCDPSession(page as never);

  client.on("Fetch.requestPaused", (paused) => {
    client
      .send("Fetch.continueRequest", {
        requestId: paused.requestId,
        headers: browserRequestHeaders(
          paused.request.headers,
          paused.request.url,
          headers,
          url
        ),
      })
      // A request the page gave up on, or a page that closed, has nothing left to continue.
      .catch(() => null);
  });

  await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
};

/** The installed Playwright's Chromium, or else an installed Google Chrome or Edge. */
const launchLocal = async (): Promise<Playwright.Browser> => {
  let playwright: typeof Playwright;

  try {
    playwright = await import("playwright");
  } catch {
    throw new RenderUnavailableError(
      `Playwright is not installed. ${RENDER_INSTALL_HINT}`
    );
  }

  let browser: Playwright.Browser;

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

  return browser;
};

/** What a render's network blocked and failed, for the console messages it explains. */
interface Unsent {
  /** URLs the browser was given a network error for instead of an answer. */
  failed: Set<string>;
  /** Requests blocked rather than sent: a refusal, a limit, a method other than GET and HEAD. */
  blocked: number;
}

/**
 * Answers every request of the context from `fetchThrough`, a worker's and a frame's included,
 * which a CDP session on the page alone would miss. WebSockets are closed before they connect:
 * request interception does not see them.
 */
const routeThrough = async (
  context: RenderContext,
  fetchThrough: FetchThrough,
  unsent: Unsent
): Promise<void> => {
  await context.route("**/*", async (route) => {
    const url = route.request().url();

    try {
      const answer = await fetchThrough(
        await browserRequestOf(route.request())
      );

      if (answer.kind === "fail") {
        unsent.failed.add(url);

        if (answer.reason === "BlockedByClient") {
          unsent.blocked += 1;
        }
      }

      try {
        await answerRoute(route, answer);
      } finally {
        fetchThrough.delivered(answer);
      }
    } catch {
      unsent.failed.add(url);
      // A request the page gave up on, or a page that closed, has nothing left to answer.
      await route.abort("failed").catch(() => null);
    }
  });

  await context.routeWebSocket("**", (ws) => ws.close());
};

/** Chromium's console error for a resource it got no answer for: the URL is its location. */
const FAILED_TO_LOAD = /^Failed to load resource: net::ERR_/u;

/** A console error, by its text and where it came from. */
export interface ConsoleError {
  text: string;
  url: string;
}

/**
 * The console errors that are the page's, without those about requests the audit itself blocked or
 * failed (`failed`): Chromium's "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT" for a
 * refused script is no error of the page. A message that names such a URL goes too.
 */
export const pageConsoleErrors = (
  errors: readonly ConsoleError[],
  failed: ReadonlySet<string>
): string[] =>
  errors.flatMap(({ text, url }) =>
    (FAILED_TO_LOAD.test(text) && failed.has(url)) ||
    [...failed].some((unsent) => text.includes(unsent))
      ? []
      : [text.slice(0, 300)]
  );

/** Load the page in headless Chromium and return the rendered DOM. */
export const renderPage = async (
  url: string,
  options: RenderOptions = {}
): Promise<RenderOutput> => {
  const browser: RenderBrowser = await (options.launch ?? launchLocal)();
  const { fetchThrough } = options;
  const timeout = options.timeoutMs ?? 30_000;
  const consoleErrors: ConsoleError[] = [];
  const unsent: Unsent = { failed: new Set(), blocked: 0 };

  try {
    const context = await browser.newContext({
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      viewport: options.viewport ?? { width: 1366, height: 900 },
      // A service worker fetches past the routes, so none may register; "allow" is the default.
      serviceWorkers: fetchThrough ? "block" : "allow",
    });

    if (fetchThrough) {
      await routeThrough(context, fetchThrough, unsent);
    }

    const page = await context.newPage();

    if (!fetchThrough && hasHeaders(options.headers)) {
      await sendHeadersToOrigin(page, options.headers, url);
    }

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        // A long message is cut where it is kept: the filter reads the start of it only.
        consoleErrors.push({
          text: msg.text().slice(0, 2000),
          url: msg.location().url,
        });
      }
    });
    page.on("pageerror", (err) =>
      consoleErrors.push({ text: err.message.slice(0, 2000), url: "" })
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

    return {
      html,
      finalUrl: page.url(),
      consoleErrors: pageConsoleErrors(consoleErrors, unsent.failed),
      ...(fetchThrough && { blockedRequests: unsent.blocked }),
    };
  } finally {
    // A browser that fails to close must not replace the page's result or its error.
    await browser.close().catch(() => null);
  }
};
