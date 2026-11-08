import type { LighthouseAuditSummary, LighthouseOpportunity, PerformanceResult } from './types.js';

export class LighthouseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LighthouseUnavailableError';
  }
}

export interface LighthouseRunOptions {
  formFactor?: 'mobile' | 'desktop';
  timeoutMs?: number;
  chromePath?: string;
  userAgent?: string;
  headers?: Record<string, string>;
}

export const LIGHTHOUSE_INSTALL_HINT = 'Install Lighthouse and a Chrome: `pnpm add -D lighthouse chrome-launcher` plus Google Chrome, or `pnpm exec playwright install chromium` (the Playwright Chromium is used automatically when found).';

/** Audits we already cover with our own rules; Lighthouse duplicates are suppressed. */
const COVERED_SEO_AUDITS = new Set(['document-title', 'meta-description', 'image-alt', 'canonical', 'hreflang', 'link-text', 'http-status-code', 'is-crawlable', 'structured-data', 'viewport']);

type LhrLike = {
  lighthouseVersion: string;
  requestedUrl?: string;
  finalDisplayedUrl?: string;
  finalUrl?: string;
  runtimeError?: { code: string; message: string };
  categories: Record<string, { score: number | null; auditRefs: { id: string; weight: number; group?: string }[] } | undefined>;
  audits: Record<string, LhAudit | undefined>;
};

type LhAudit = {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  displayValue?: string;
  metricSavings?: Record<string, number | undefined>;
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number };
};

export async function runLighthouse(url: string, options: LighthouseRunOptions = {}): Promise<PerformanceResult> {
  const formFactor = options.formFactor ?? 'mobile';
  let lighthouse: (typeof import('lighthouse'))['default'];
  let launch: (typeof import('chrome-launcher'))['launch'];
  try {
    lighthouse = (await import('lighthouse')).default;
    launch = (await import('chrome-launcher')).launch;
  } catch {
    throw new LighthouseUnavailableError(`Lighthouse or chrome-launcher is not installed. ${LIGHTHOUSE_INSTALL_HINT}`);
  }

  const chromePath = options.chromePath ?? process.env['CHROME_PATH'] ?? (await playwrightChromiumPath());
  let chrome: Awaited<ReturnType<typeof launch>>;
  try {
    chrome = await launch({
      chromeFlags: ['--headless=new', '--no-first-run', '--disable-gpu', '--no-default-browser-check'],
      ...(chromePath ? { chromePath } : {}),
      logLevel: 'silent',
    });
  } catch (err) {
    throw new LighthouseUnavailableError(`Could not launch Chrome: ${(err as Error).message}. ${LIGHTHOUSE_INSTALL_HINT}`);
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const config = formFactor === 'desktop' ? (await import('lighthouse/core/config/desktop-config.js')).default : undefined;
    const flags = {
      port: chrome.port,
      output: 'json' as const,
      logLevel: 'silent' as const,
      onlyCategories: ['performance', 'seo', 'agentic-browsing'],
      extraHeaders: options.headers,
      ...(options.userAgent ? { emulatedUserAgent: options.userAgent } : {}),
    };
    const run = lighthouse(url, flags as Parameters<typeof lighthouse>[1], config);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Lighthouse timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    const result = await Promise.race([run, timeout]);
    if (!result) throw new Error('Lighthouse returned no result');
    const lhr = result.lhr as unknown as LhrLike;
    if (lhr.runtimeError && lhr.runtimeError.code !== 'NO_ERROR') throw new Error(`Lighthouse runtime error ${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
    return summarize(lhr, url, formFactor);
  } finally {
    if (timer) clearTimeout(timer);
    chrome.kill();
  }
}

async function playwrightChromiumPath(): Promise<string | undefined> {
  try {
    const pw = await import('playwright');
    const p = pw.chromium.executablePath();
    const { promises: fs } = await import('node:fs');
    await fs.access(p);
    return p;
  } catch {
    return undefined;
  }
}

export function summarize(lhr: LhrLike, requestedUrl: string, formFactor: 'mobile' | 'desktop'): PerformanceResult {
  const numeric = (id: string): number | null => {
    const v = lhr.audits[id]?.numericValue;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const pct = (score: number | null | undefined): number | null => (typeof score === 'number' ? Math.round(score * 100) : null);

  const perfRefs = lhr.categories['performance']?.auditRefs ?? [];
  const opportunities: LighthouseOpportunity[] = [];
  for (const ref of perfRefs) {
    const audit = lhr.audits[ref.id];
    if (!audit || audit.score === null || audit.score >= 0.9) continue;
    if (ref.group === 'metrics' || ref.group === 'hidden') continue;
    const savings = audit.metricSavings ?? {};
    const msValues = ['LCP', 'FCP', 'TBT', 'INP', 'SI'].map((k) => savings[k]).filter((v): v is number => typeof v === 'number' && v > 0);
    const savingsMs = audit.details?.overallSavingsMs ?? (msValues.length ? Math.max(...msValues) : null);
    const savingsBytes = audit.details?.overallSavingsBytes ?? null;
    const hasSavings = (savingsMs ?? 0) > 0 || (savingsBytes ?? 0) > 0 || (typeof savings['CLS'] === 'number' && savings['CLS'] > 0) || audit.details?.type === 'opportunity';
    if (!hasSavings) continue;
    opportunities.push({ id: audit.id, title: audit.title, description: stripMarkdownLinks(audit.description), score: audit.score, savingsMs: savingsMs ?? null, savingsBytes });
  }
  opportunities.sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0) || (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0));

  const failed = (category: string, skip: Set<string>): LighthouseAuditSummary[] => {
    const refs = lhr.categories[category]?.auditRefs ?? [];
    const out: LighthouseAuditSummary[] = [];
    for (const ref of refs) {
      const audit = lhr.audits[ref.id];
      if (!audit || skip.has(audit.id)) continue;
      if (!['binary', 'numeric', 'metricSavings'].includes(audit.scoreDisplayMode)) continue;
      if (audit.score === null || audit.score >= 1) continue;
      out.push({ id: audit.id, title: audit.title, description: stripMarkdownLinks(audit.description), score: audit.score, displayValue: audit.displayValue ?? null });
    }
    return out;
  };

  return {
    tool: 'lighthouse',
    lighthouseVersion: lhr.lighthouseVersion,
    formFactor,
    requestedUrl,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? requestedUrl,
    metrics: {
      performanceScore: pct(lhr.categories['performance']?.score),
      seoScore: pct(lhr.categories['seo']?.score),
      agenticBrowsingScore: pct(lhr.categories['agentic-browsing']?.score),
      lcpMs: numeric('largest-contentful-paint'),
      cls: numeric('cumulative-layout-shift'),
      tbtMs: numeric('total-blocking-time'),
      fcpMs: numeric('first-contentful-paint'),
      speedIndexMs: numeric('speed-index'),
      ttfbMs: numeric('server-response-time'),
      inpMs: numeric('interaction-to-next-paint'),
    },
    opportunities,
    failedSeoAudits: failed('seo', COVERED_SEO_AUDITS),
    agenticBrowsingAudits: failed('agentic-browsing', new Set()),
  };
}

function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)').trim();
}
