import type { Options as ChromeLaunchOptions } from "chrome-launcher";
import type { Flags as LighthouseFlags } from "lighthouse";
import { z } from "zod";

import { quote } from "./html/dom.js";
import { BROWSER_INSTALL_HINT } from "./render.js";
import type {
  LcpElement,
  LighthouseAuditSummary,
  LighthouseItem,
  LighthouseNode,
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

/** The peers `--lighthouse` loads, at the majors `peerDependencies` in package.json allows. */
export const LIGHTHOUSE_PEERS = ["lighthouse@13", "chrome-launcher@1"];

// Lighthouse is a peer and not a dependency because it is some 180 MB that every install and npx
// run would fetch for one option.
export const LIGHTHOUSE_INSTALL_HINT = `Lighthouse is an optional peer, so install it next to agentic-seo-check: \`npm i -D ${LIGHTHOUSE_PEERS.join(" ")}\` in a project, \`npm i -g @rivi-software/agentic-seo-check ${LIGHTHOUSE_PEERS.join(" ")}\` for a global install, or with npx run \`npx -y -p @rivi-software/agentic-seo-check ${LIGHTHOUSE_PEERS.map((p) => `-p ${p}`).join(" ")} agentic-seo-check …\`.`;

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
  /** Read through `detailsOf`, which keeps the fields a fix needs. */
  details?: object;
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

/** Rows a fix may name: enough to act on, few enough to keep the result small. */
const MAX_ITEMS = 10;

// Lighthouse reports what the page has, so every value is read leniently: a field of another
// shape is dropped (`catch`) instead of failing the run.
const optionalString = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

const lhNode = z.object({
  type: optionalString,
  lhId: optionalString,
  path: optionalString,
  selector: optionalString,
  snippet: optionalString,
  nodeLabel: optionalString,
  value: optionalString,
  boundingRect: z
    .object({ width: optionalNumber, height: optionalNumber })
    .optional()
    .catch(undefined),
});

type LhNodeValue = z.infer<typeof lhNode>;

const lhChecks = z.record(
  z.string(),
  z.object({ value: z.boolean().optional().catch(undefined) })
);

interface LhRow extends Omit<LhNodeValue, "value"> {
  url?: string;
  href?: string;
  resourceType?: string;
  node?: Omit<LhNodeValue, "value">;
  totalBytes?: number;
  wastedBytes?: number;
  wastedMs?: number;
  scripting?: number;
  line?: string;
  index?: number | string;
  message?: string;
  description?: string;
  text?: string;
  subpart?: string;
  duration?: number;
  items?: LhRow[] | z.infer<typeof lhChecks>;
  /** A list section's details, read with `lhDetails` where a list has sections. */
  value?: unknown;
  subItems?: { items: { cause?: string; extra?: LhNodeValue }[] };
}

interface LhDetails {
  type?: string;
  overallSavingsMs?: number;
  overallSavingsBytes?: number;
  items?: LhRow[] | z.infer<typeof lhChecks>;
  value?: LhDetails;
}

const lhRow: z.ZodType<LhRow> = z.lazy(() =>
  lhNode.extend({
    value: z.unknown().optional(),
    url: optionalString,
    href: optionalString,
    resourceType: optionalString,
    node: lhNode.optional().catch(undefined),
    totalBytes: optionalNumber,
    wastedBytes: optionalNumber,
    wastedMs: optionalNumber,
    scripting: optionalNumber,
    line: optionalString,
    index: z.union([z.number(), z.string()]).optional().catch(undefined),
    message: optionalString,
    description: optionalString,
    text: optionalString,
    subpart: optionalString,
    duration: optionalNumber,
    items: z
      .union([z.array(lhRow), lhChecks])
      .optional()
      .catch(undefined),
    subItems: z
      .object({
        items: z.array(
          z.object({
            cause: optionalString,
            extra: lhNode.optional().catch(undefined),
          })
        ),
      })
      .optional()
      .catch(undefined),
  })
);

const lhDetails: z.ZodType<LhDetails> = z.lazy(() =>
  z.object({
    type: optionalString,
    overallSavingsMs: optionalNumber,
    overallSavingsBytes: optionalNumber,
    items: z
      .union([z.array(lhRow), lhChecks])
      .optional()
      .catch(undefined),
    value: lhDetails.optional().catch(undefined),
  })
);

/** The details of an audit, with only the fields a fix reads. */
const detailsOf = (audit: LhAudit | undefined): LhDetails | undefined => {
  const parsed = lhDetails.safeParse(audit?.details);

  return parsed.success ? parsed.data : undefined;
};

const rowsIn = (items: LhDetails["items"]): LhRow[] =>
  Array.isArray(items) ? items : [];

/**
 * The rows of an audit's details, whatever its shape: a table or opportunity has rows, a list
 * holds tables, nodes and sections; checklists have none.
 */
const rowsOf = (details: LhDetails | undefined): LhRow[] => {
  if (!details) {
    return [];
  }

  if (details.type === "list") {
    return rowsIn(details.items).flatMap((entry): LhRow[] => {
      if (entry.type === "table") {
        return rowsIn(entry.items);
      }

      if (entry.type === "list-section") {
        const section = lhDetails.safeParse(entry.value);

        return section.success ? rowsOf(section.data) : [];
      }

      return entry.type === "node" ? [{ node: entry }] : [];
    });
  }

  return details.type === "table" || details.type === "opportunity"
    ? rowsIn(details.items)
    : [];
};

const httpUrl = (value: string | undefined): string | undefined =>
  value && /^https?:\/\//u.test(value) ? value : undefined;

const rounded = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : Math.round(value);

/** The element name of a node: the end of its lhId ("page-0-IMG") or of its path ("…,0,IMG"). */
const nodeName = (node: Omit<LhNodeValue, "value">): string | null => {
  const id = node.lhId?.split("-").at(-1) ?? node.path?.split(",").at(-1);

  return id && /^[a-z][\w-]*$/iu.test(id) ? id.toLowerCase() : null;
};

const nodeOf = (
  value: Omit<LhNodeValue, "value"> | undefined
): LighthouseNode | undefined => {
  if (value?.type !== "node" || !value.selector) {
    return undefined;
  }

  return {
    selector: quote(value.selector),
    snippet: quote(value.snippet ?? ""),
    label: value.nodeLabel ? quote(value.nodeLabel) : null,
    name: nodeName(value),
    width: rounded(value.boundingRect?.width),
    height: rounded(value.boundingRect?.height),
  };
};

/** Causes of a layout shift (cls-culprits), and the font or frame they name. */
const causesOf = (row: LhRow) => {
  const causes = row.subItems?.items ?? [];
  const text = causes.flatMap((c) => (c.cause ? [c.cause] : [])).join("; ");
  const url = causes.map((c) => httpUrl(c.extra?.value)).find(Boolean);

  return { text: text || undefined, url };
};

const SIZES = ["totalBytes", "wastedBytes", "wastedMs"] as const;

const itemOf = (row: LhRow): LighthouseItem => {
  const item: LighthouseItem = {};
  const causes = causesOf(row);
  const url = httpUrl(row.url) ?? httpUrl(row.href) ?? causes.url;
  const node = nodeOf(row.node) ?? nodeOf(row);

  if (url) {
    item.url = quote(url);
  }

  if (node) {
    item.node = node;
  }

  for (const key of SIZES) {
    const value = row[key];

    if (value !== undefined && value > 0) {
      item[key] = Math.round(value);
    }
  }

  if (row.line !== undefined) {
    item.line = quote(row.line);
  }

  const lineNumber = Number(row.index);

  if (row.index !== undefined && Number.isInteger(lineNumber)) {
    item.lineNumber = lineNumber;
  }

  const text = row.message ?? row.description ?? row.text ?? causes.text;

  if (text) {
    item.text = quote(text);
  }

  return item;
};

/** The first rows of an audit that name something: a URL, an element, a line or a message. */
const itemsOf = (audit: LhAudit | undefined): LighthouseItem[] =>
  rowsOf(detailsOf(audit))
    .flatMap((row) => {
      const item = itemOf(row);

      return (item.url ?? item.node ?? item.line ?? item.text) ? [item] : [];
    })
    .slice(0, MAX_ITEMS);

/** The checks of the first checklist in an audit's list (lcp-discovery). */
const checklistOf = (audit: LhAudit | undefined): Map<string, boolean> => {
  const checks = new Map<string, boolean>();
  const details = detailsOf(audit);
  const lists = details?.type === "list" ? rowsIn(details.items) : [];
  const checklist = lists.find((entry) => entry.type === "checklist");

  if (checklist?.items && !Array.isArray(checklist.items)) {
    for (const [name, check] of Object.entries(checklist.items)) {
      if (check.value !== undefined) {
        checks.set(name, check.value);
      }
    }
  }

  return checks;
};

/** The src an LCP <img> snippet names, without the "…" Lighthouse cuts long values with. */
const snippetSrc = (snippet: string): { src: string; cut: boolean } | null => {
  const raw = /\ssrc="(?<src>[^"]*)"/u.exec(snippet)?.groups?.src;

  if (!raw) {
    return null;
  }

  // The snippet is outerHTML, which writes an attribute's & as &amp; (and " < > as entities);
  // the request URL has them plain. &amp; goes last, so "&amp;lt;" stays "&lt;".
  const src = raw
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");

  return src.endsWith("…")
    ? { src: src.slice(0, -1), cut: true }
    : { src, cut: false };
};

/**
 * The URL the LCP image was fetched from: the one image request in the network log that its src
 * names (or starts with, when Lighthouse cut the src short). Null when none or several match.
 */
const lcpImageUrl = (
  lhr: LhrLike,
  node: LighthouseNode,
  pageUrl: string
): string | null => {
  const found = snippetSrc(node.snippet);

  if (!found || node.name !== "img") {
    return null;
  }

  let { src } = found;

  if (!found.cut) {
    try {
      src = new URL(src, pageUrl).href;
    } catch {
      return null;
    }
  }

  const images = rowsOf(detailsOf(lhr.audits["network-requests"])).flatMap(
    (r) => (r.resourceType === "Image" && r.url ? [r.url] : [])
  );

  const matches = [
    ...new Set(
      images.filter((u) => (found.cut ? u.startsWith(src) : u === src))
    ),
  ];

  if (matches.length === 1 && matches[0]) {
    return quote(matches[0]);
  }

  // The src only when the log has no images at all: when it has some and none is the src, the
  // browser fetched another candidate (a <picture> <source>, AVIF or WebP), not this file.
  return !found.cut && images.length === 0 && httpUrl(src) ? quote(src) : null;
};

/** The LCP element and what lcp-discovery and lcp-breakdown found about it. */
const lcpElementOf = (
  lhr: LhrLike,
  pageUrl: string
): LcpElement | undefined => {
  const discovery = lhr.audits["lcp-discovery-insight"];
  const breakdown = rowsOf(detailsOf(lhr.audits["lcp-breakdown-insight"]));

  const node = [...rowsOf(detailsOf(discovery)), ...breakdown]
    .map((r) => nodeOf(r.node))
    .find(Boolean);

  if (!node) {
    return undefined;
  }

  const checks = checklistOf(discovery);
  const phases: Record<string, number> = {};

  for (const row of breakdown) {
    if (row.subpart && row.duration !== undefined) {
      phases[row.subpart] = Math.round(row.duration);
    }
  }

  return {
    node,
    imageUrl: lcpImageUrl(lhr, node, pageUrl),
    hasSrcset: /\ssrcset="/u.test(node.snippet),
    fetchpriorityHigh: checks.get("priorityHinted") ?? null,
    discoverable: checks.get("requestDiscoverable") ?? null,
    notLazy: checks.get("eagerlyLoaded") ?? null,
    phases,
  };
};

/** Rows of an audit only when it failed: a passing audit's rows are not problems. */
const failingItems = (audit: LhAudit | undefined): LighthouseItem[] =>
  audit && audit.score !== null && audit.score < 0.9 ? itemsOf(audit) : [];

/** Scripts by main-thread script evaluation time (bootup-time), most first. */
const scriptsOf = (lhr: LhrLike): LighthouseItem[] =>
  rowsOf(detailsOf(lhr.audits["bootup-time"]))
    .flatMap((r): LighthouseItem[] => {
      const url = httpUrl(r.url);

      return url && r.scripting !== undefined && r.scripting > 0
        ? [{ url: quote(url), wastedMs: Math.round(r.scripting) }]
        : [];
    })
    .toSorted((a, b) => (b.wastedMs ?? 0) - (a.wastedMs ?? 0))
    .slice(0, MAX_ITEMS);

const percent = (score: number | null | undefined): number | null =>
  score === null || score === undefined ? null : Math.round(score * 100);

/** An audit in the performance category as an opportunity, or null when it saves nothing. */
const opportunityOf = (audit: LhAudit): LighthouseOpportunity | null => {
  const savings = audit.metricSavings ?? {};

  const msValues = MS_SAVINGS_METRICS.flatMap((metric) => {
    const value = savings[metric];

    return value !== undefined && value > 0 ? [value] : [];
  });

  const details = detailsOf(audit);

  const savingsMs =
    details?.overallSavingsMs ??
    (msValues.length > 0 ? Math.max(...msValues) : null);

  const savingsBytes = details?.overallSavingsBytes ?? null;

  const hasSavings =
    (savingsMs ?? 0) > 0 ||
    (savingsBytes ?? 0) > 0 ||
    (savings["CLS"] ?? 0) > 0 ||
    details?.type === "opportunity";

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
    items: itemsOf(audit),
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
      items: itemsOf(audit),
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

  const finalUrl = lhr.finalDisplayedUrl ?? lhr.finalUrl ?? requestedUrl;

  const result: PerformanceResult = {
    tool: "lighthouse",
    lighthouseVersion: lhr.lighthouseVersion,
    formFactor,
    requestedUrl,
    finalUrl,
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

  const lcpElement = lcpElementOf(lhr, finalUrl);

  if (lcpElement) {
    result.lcpElement = lcpElement;
  }

  // The details a fix names, kept only when Lighthouse found something.
  const unsizedImages = failingItems(lhr.audits["unsized-images"]);

  const layoutShifts = itemsOf(lhr.audits["cls-culprits-insight"]).filter(
    (i) => i.node
  );

  const renderBlocking = failingItems(lhr.audits["render-blocking-insight"]);
  const scripts = scriptsOf(lhr);

  if (unsizedImages.length) {
    result.unsizedImages = unsizedImages;
  }

  if (layoutShifts.length) {
    result.layoutShifts = layoutShifts;
  }

  if (renderBlocking.length) {
    result.renderBlocking = renderBlocking;
  }

  if (scripts.length) {
    result.scripts = scripts;
  }

  return result;
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
      `Could not launch Chrome: ${error instanceof Error ? error.message : String(error)}. ${BROWSER_INSTALL_HINT}`
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
