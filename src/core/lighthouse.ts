import type { Options as ChromeLaunchOptions } from "chrome-launcher";
import type { Flags as LighthouseFlags } from "lighthouse";

import type {
  LighthouseAuditSummary,
  LighthouseOpportunity,
  PerformanceResult,
} from "./types.js";

export class LighthouseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LighthouseUnavailableError";
  }
}

export interface LighthouseRunOptions {
  formFactor?: "mobile" | "desktop";
  timeoutMs?: number;
  chromePath?: string;
  userAgent?: string;
  headers?: Record<string, string>;
}

export const LIGHTHOUSE_INSTALL_HINT =
  "Install Lighthouse and a Chrome: `pnpm add -D lighthouse chrome-launcher` plus Google Chrome, or `pnpm exec playwright install chromium` (the Playwright Chromium is used automatically when found).";

/** Audits we already cover with our own rules; Lighthouse duplicates are suppressed. */
const COVERED_SEO_AUDITS = new Set([
  "document-title",
  "meta-description",
  "image-alt",
  "canonical",
  "hreflang",
  "link-text",
  "http-status-code",
  "is-crawlable",
  "structured-data",
  "viewport",
]);

interface LhCategory {
  score: number | null;
  auditRefs: { id: string; weight: number; group?: string }[];
}

interface LhAudit {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  displayValue?: string;
  metricSavings?: Record<string, number | undefined>;
  details?: {
    type?: string;
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
  };
}

interface LhrLike {
  lighthouseVersion: string;
  requestedUrl?: string;
  finalDisplayedUrl?: string;
  finalUrl?: string;
  runtimeError?: { code: string; message: string };
  categories: Record<string, LhCategory | undefined>;
  audits: Record<string, LhAudit | undefined>;
}

/** The metrics whose savings Lighthouse reports in milliseconds. */
const MS_SAVINGS_METRICS = ["LCP", "FCP", "TBT", "INP", "SI"];

const stripMarkdownLinks = (text: string): string =>
  text
    .replaceAll(
      /\[(?<text>[^\]]+)\]\((?<href>https?:[^)]+)\)/gu,
      "$<text> ($<href>)"
    )
    .trim();

const percent = (score: number | null | undefined): number | null =>
  score === null || score === undefined ? null : Math.round(score * 100);

/** An audit in the performance category as an opportunity, or null when it saves nothing. */
const opportunityOf = (audit: LhAudit): LighthouseOpportunity | null => {
  const savings = audit.metricSavings ?? {};

  const msValues = MS_SAVINGS_METRICS.flatMap((metric) => {
    const value = savings[metric];

    return value !== undefined && value > 0 ? [value] : [];
  });

  const savingsMs =
    audit.details?.overallSavingsMs ??
    (msValues.length > 0 ? Math.max(...msValues) : null);

  const savingsBytes = audit.details?.overallSavingsBytes ?? null;

  const hasSavings =
    (savingsMs ?? 0) > 0 ||
    (savingsBytes ?? 0) > 0 ||
    (savings["CLS"] ?? 0) > 0 ||
    audit.details?.type === "opportunity";

  if (!hasSavings) {
    return null;
  }

  return {
    id: audit.id,
    title: audit.title,
    description: stripMarkdownLinks(audit.description),
    score: audit.score,
    savingsMs: savingsMs ?? null,
    savingsBytes,
  };
};

const opportunitiesOf = (lhr: LhrLike): LighthouseOpportunity[] => {
  const perfRefs = lhr.categories["performance"]?.auditRefs ?? [];
  const opportunities: LighthouseOpportunity[] = [];

  for (const ref of perfRefs) {
    const audit = lhr.audits[ref.id];

    if (!audit || audit.score === null || audit.score >= 0.9) {
      continue;
    }

    if (ref.group === "metrics" || ref.group === "hidden") {
      continue;
    }

    const opportunity = opportunityOf(audit);

    if (opportunity) {
      opportunities.push(opportunity);
    }
  }

  opportunities.sort(
    (a, b) =>
      (b.savingsMs ?? 0) - (a.savingsMs ?? 0) ||
      (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0)
  );

  return opportunities;
};

const failedAudits = (
  lhr: LhrLike,
  category: string,
  skip: Set<string>
): LighthouseAuditSummary[] => {
  const refs = lhr.categories[category]?.auditRefs ?? [];
  const out: LighthouseAuditSummary[] = [];

  for (const ref of refs) {
    const audit = lhr.audits[ref.id];

    if (!audit || skip.has(audit.id)) {
      continue;
    }

    if (
      !["binary", "numeric", "metricSavings"].includes(audit.scoreDisplayMode)
    ) {
      continue;
    }

    if (audit.score === null || audit.score >= 1) {
      continue;
    }

    out.push({
      id: audit.id,
      title: audit.title,
      description: stripMarkdownLinks(audit.description),
      score: audit.score,
      displayValue: audit.displayValue ?? null,
    });
  }

  return out;
};

export const summarize = (
  lhr: LhrLike,
  requestedUrl: string,
  formFactor: "mobile" | "desktop"
): PerformanceResult => {
  const numeric = (id: string): number | null => {
    const value = lhr.audits[id]?.numericValue;

    return value !== undefined && Number.isFinite(value) ? value : null;
  };

  return {
    tool: "lighthouse",
    lighthouseVersion: lhr.lighthouseVersion,
    formFactor,
    requestedUrl,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? requestedUrl,
    metrics: {
      performanceScore: percent(lhr.categories["performance"]?.score),
      seoScore: percent(lhr.categories["seo"]?.score),
      agenticBrowsingScore: percent(lhr.categories["agentic-browsing"]?.score),
      lcpMs: numeric("largest-contentful-paint"),
      cls: numeric("cumulative-layout-shift"),
      tbtMs: numeric("total-blocking-time"),
      fcpMs: numeric("first-contentful-paint"),
      speedIndexMs: numeric("speed-index"),
      ttfbMs: numeric("server-response-time"),
      inpMs: numeric("interaction-to-next-paint"),
    },
    opportunities: opportunitiesOf(lhr),
    failedSeoAudits: failedAudits(lhr, "seo", COVERED_SEO_AUDITS),
    agenticBrowsingAudits: failedAudits(lhr, "agentic-browsing", new Set()),
  };
};

const playwrightChromiumPath = async (): Promise<string | undefined> => {
  try {
    const pw = await import("playwright");
    const p = pw.chromium.executablePath();
    const { promises: fs } = await import("node:fs");
    await fs.access(p);

    return p;
  } catch {
    return undefined;
  }
};

/** Lighthouse and chrome-launcher are optional peers, so they load only when a run asks for them. */
const loadLighthouse = async () => {
  try {
    const lighthouseModule = await import("lighthouse");
    const chromeLauncher = await import("chrome-launcher");

    return {
      lighthouse: lighthouseModule.default,
      launch: chromeLauncher.launch,
    };
  } catch {
    throw new LighthouseUnavailableError(
      `Lighthouse or chrome-launcher is not installed. ${LIGHTHOUSE_INSTALL_HINT}`
    );
  }
};

export const runLighthouse = async (
  url: string,
  options: LighthouseRunOptions = {}
): Promise<PerformanceResult> => {
  const formFactor = options.formFactor ?? "mobile";
  const { lighthouse, launch } = await loadLighthouse();

  const chromePath =
    options.chromePath ??
    process.env["CHROME_PATH"] ??
    (await playwrightChromiumPath());

  const launchOptions: ChromeLaunchOptions = {
    chromeFlags: [
      "--headless=new",
      "--no-first-run",
      "--disable-gpu",
      "--no-default-browser-check",
    ],
    logLevel: "silent",
  };

  if (chromePath) {
    launchOptions.chromePath = chromePath;
  }

  let chrome: Awaited<ReturnType<typeof launch>>;

  try {
    chrome = await launch(launchOptions);
  } catch (error) {
    throw new LighthouseUnavailableError(
      `Could not launch Chrome: ${error instanceof Error ? error.message : String(error)}. ${LIGHTHOUSE_INSTALL_HINT}`
    );
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  let timer: NodeJS.Timeout | undefined;

  try {
    let config;

    if (formFactor === "desktop") {
      const desktop = await import("lighthouse/core/config/desktop-config.js");
      config = desktop.default;
    }

    const flags: LighthouseFlags = {
      port: chrome.port,
      output: "json",
      logLevel: "silent",
      onlyCategories: ["performance", "seo", "agentic-browsing"],
      extraHeaders: options.headers,
    };

    if (options.userAgent) {
      flags.emulatedUserAgent = options.userAgent;
    }

    const run = lighthouse(url, flags, config);

    // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form that can be cleared without settling it
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Lighthouse timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
    });

    const result = await Promise.race([run, timeout]);

    if (!result) {
      throw new Error("Lighthouse returned no result");
    }

    const lhr: LhrLike = result.lhr;

    if (lhr.runtimeError && lhr.runtimeError.code !== "NO_ERROR") {
      throw new Error(
        `Lighthouse runtime error ${lhr.runtimeError.code}: ${lhr.runtimeError.message}`
      );
    }

    return summarize(lhr, url, formFactor);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }

    chrome.kill();
  }
};
