import { MAKER, MAKER_URL, PRODUCT_NAME, REPOSITORY_URL } from "../../brand.js";
import { VERSION } from "../../version.js";
import {
  FIELD_LABELS,
  FIELD_METRICS,
  fieldBand,
  fieldValue,
  NO_FIELD_DATA_LABELS,
  sharePercent,
} from "../field-data.js";
import type { CORE_VITALS } from "../field-data.js";
import type {
  AeoAudit,
  AiBotAccess,
  AiCrawlerReport,
  Audit,
  BaselineComparison,
  FieldData,
  NoFieldData,
  Finding,
  FixEdit,
  LlmsTxtInfo,
  PageAudit,
  SiteAudit,
} from "../types.js";
import { withoutControls } from "./controls.js";

const cell = (value: string | null | undefined): string => {
  if (!value) {
    return "—";
  }

  return value.replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 120);
};

const ms = (value: number | null): string =>
  value === null ? "—" : `${Math.round(value)} ms`;

const countsLine = (c: {
  error: number;
  warning: number;
  info: number;
}): string => `${c.error} error(s), ${c.warning} warning(s), ${c.info} info`;

/** `text` as inline code, fenced with more backticks than it holds so a page's own backticks cannot end it. */
const codeSpan = (text: string): string => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/gu)].map((m) => m[0].length)
  );

  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";

  return `${fence}${pad}${text}${pad}${fence}`;
};

/** A labelled line for one line of code, or a fenced block under the label for several. */
const codeLines = (label: string, text: string, indent: string): string[] => {
  if (!text.includes("\n")) {
    return [`${indent}- ${label}: ${codeSpan(text)}`];
  }

  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/gu)].map((m) => m[0].length)
  );

  const fence = "`".repeat(longest + 1);

  return [
    `${indent}- ${label}:`,
    "",
    `${indent}  ${fence}`,
    ...text.split("\n").map((line) => `${indent}  ${line}`),
    `${indent}  ${fence}`,
    "",
  ];
};

const editLines = (e: FixEdit): string[] => {
  const where = [e.in, e.url, e.at ? codeSpan(e.at) : undefined]
    .filter(Boolean)
    .join(", ");

  const out = [`  - Edit: ${e.action} in ${where}`];

  if (e.current !== undefined) {
    out.push(...codeLines("Current", e.current, "    "));
  }

  if (e.code !== undefined) {
    out.push(...codeLines("Code", e.code, "    "));
  }

  if (e.write) {
    out.push(`    - Write: ${e.write}`);
  }

  return out;
};

const findingLines = (f: Finding): string[] => {
  const out = [
    `- **\`${f.rule}\`** ${f.message}`,
    `  - Fix: ${f.recommendation}`,
  ];

  for (const e of f.fix ?? []) {
    out.push(...editLines(e));
  }

  if (f.selector) {
    out.push(`  - Where: \`${f.selector}\``);
  }

  if (f.evidence && Object.keys(f.evidence).length) {
    out.push(`  - Evidence: \`${JSON.stringify(f.evidence).slice(0, 400)}\``);
  }

  return out;
};

/** What a re-check found: the findings fixed since the baseline, still open and new. */
const baselineLines = (b: BaselineComparison, heading: string): string[] => {
  const lines = [
    `${heading}# Re-check`,
    "",
    `${b.fixed.length} fixed · ${b.open.length} still open · ${b.new.length} new${b.notChecked ? ` · ${b.notChecked} not checked (their rule or page did not run this time)` : ""}`,
    "",
  ];

  for (const f of b.fixed) {
    lines.push(
      `- Fixed: \`${f.id}\`${f.message ? ` ${f.message}` : ""}${f.url ? ` (${f.url})` : ""}`
    );
  }

  for (const id of b.new) {
    lines.push(`- New: \`${id}\``);
  }

  if (b.fixed.length || b.new.length) {
    lines.push("");
  }

  return lines;
};

const SEVERITY_HEADINGS = {
  error: "Errors",
  warning: "Warnings",
  info: "Info",
} as const;

const findingsSection = (findings: Finding[], heading: string): string[] => {
  const lines: string[] = [`${heading}# Findings`, ""];

  if (!findings.length) {
    lines.push("No issues found.");

    return lines;
  }

  for (const severity of ["error", "warning", "info"] as const) {
    const group = findings.filter((f) => f.severity === severity);

    if (!group.length) {
      continue;
    }

    lines.push(
      `${heading}## ${SEVERITY_HEADINGS[severity]} (${group.length})`,
      ""
    );

    for (const f of group) {
      lines.push(...findingLines(f));
    }

    lines.push("");
  }

  return lines;
};

const FIELD_HEADING = "Field data (Chrome UX Report, phones)";

/** Whose record it is and the 28 days it covers. */
const fieldRecordLine = (field: FieldData): string =>
  `Real Chrome visits ${field.source === "url" ? "to this URL" : "to the whole origin, as this URL has too few of its own"}, ${field.period.firstDate} to ${field.period.lastDate}, at the 75th percentile.`;

/** Real-user Core Web Vitals at the 75th percentile, or why the audit has none. */
const fieldDataLines = (
  field: FieldData | NoFieldData,
  heading: string
): string[] => {
  if (field.source === null) {
    return [`${heading}# ${FIELD_HEADING}`, "", field.message, ""];
  }

  return [
    `${heading}# ${FIELD_HEADING}`,
    "",
    fieldRecordLine(field),
    "",
    "| Metric | p75 | Rating | Good | Needs improvement | Poor |",
    "| --- | --- | --- | --- | --- | --- |",
    ...FIELD_METRICS.map((key) => {
      const m = field[key];

      return m
        ? `| ${FIELD_LABELS[key]} | ${fieldValue(key, m.p75)} | ${fieldBand(key, m.p75)} | ${sharePercent(m.good)} | ${sharePercent(m.needsImprovement)} | ${sharePercent(m.poor)} |`
        : `| ${FIELD_LABELS[key]} | — | too few visits | — | — | — |`;
    }),
    "",
  ];
};

/** A Core Web Vital of a crawled page: "2.1 s (good)". */
const vital = (field: FieldData, key: (typeof CORE_VITALS)[number]): string => {
  const m = field[key];

  return m ? `${fieldValue(key, m.p75)} (${fieldBand(key, m.p75)})` : "—";
};

/** The Core Web Vitals of the pages a crawl asked the Chrome UX Report for. */
const siteFieldDataLines = (audit: SiteAudit): string[] => {
  const asked = audit.pages.filter((p) => p.fieldData);

  if (asked.length === 0) {
    return [];
  }

  return [
    `## ${FIELD_HEADING}`,
    "",
    "| URL | Record | LCP | INP | CLS |",
    "| --- | --- | --- | --- | --- |",
    ...asked.map((p) => {
      const field = p.fieldData;

      return field && field.source !== null
        ? `| ${p.url} | ${field.source} | ${vital(field, "lcpMs")} | ${vital(field, "inpMs")} | ${vital(field, "cls")} |`
        : `| ${p.url} | ${NO_FIELD_DATA_LABELS[field?.reason ?? "no-data"]} | — | — | — |`;
    }),
    "",
  ];
};

const pageMarkdown = (audit: PageAudit, heading = "#"): string => {
  const lines: string[] = [
    `${heading} SEO audit: ${audit.url}`,
    "",
    `Score **${audit.score}/100** · ${countsLine(audit.counts)}${audit.response?.status ? ` · HTTP ${audit.response.status}` : ""}${audit.response?.timeMs ? ` · ${audit.response.timeMs} ms` : ""}`,
    "",
  ];

  const s = audit.summary;

  lines.push(
    `${heading}# Summary`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Title | ${cell(s.title)} (${s.titleLength} chars) |`,
    `| Meta description | ${cell(s.metaDescription)} (${s.metaDescriptionLength} chars) |`,
    `| Canonical | ${cell(s.canonical)} |`,
    `| Indexable | ${s.indexable ? "yes" : "no"}${s.robots.length ? ` (${s.robots.join(", ")})` : ""} |`,
    `| Language | ${cell(s.lang)} |`,
    `| H1 | ${s.h1.length ? s.h1.map(cell).join(" / ") : "—"} |`,
    `| Words | ${s.wordCount} |`,
    `| Images | ${s.images.total} (${s.images.missingAlt} without alt) |`,
    `| Links | ${s.links.internal} internal, ${s.links.external} external |`,
    `| Structured data | ${s.structuredDataTypes.length ? s.structuredDataTypes.join(", ") : "—"} |`,
    `| Open Graph | ${
      Object.keys(s.openGraph).length
        ? Object.keys(s.openGraph)
            .map((k) => `og:${k}`)
            .join(", ")
        : "—"
    } |`,
    ""
  );

  if (audit.fieldData) {
    lines.push(...fieldDataLines(audit.fieldData, heading));
  }

  if (audit.performance) {
    const m = audit.performance.metrics;

    lines.push(
      `${heading}# Lighthouse (${audit.performance.formFactor})`,
      "",
      "| Metric | Value |",
      "| --- | --- |",
      `| Performance score | ${m.performanceScore ?? "—"} |`,
      `| SEO score | ${m.seoScore ?? "—"} |`,
      `| LCP | ${ms(m.lcpMs)} |`,
      `| CLS | ${m.cls === null ? "—" : m.cls.toFixed(3)} |`,
      `| TBT | ${ms(m.tbtMs)} |`,
      `| FCP | ${ms(m.fcpMs)} |`,
      `| Speed Index | ${ms(m.speedIndexMs)} |`,
      `| TTFB | ${ms(m.ttfbMs)} |`,
      ""
    );
  }

  if (audit.rendering) {
    const r = audit.rendering;

    lines.push(
      `${heading}# Rendered vs server HTML`,
      "",
      "| Field | Server HTML | Rendered DOM |",
      "| --- | --- | --- |",
      `| Title | ${cell(r.raw.title)} | ${cell(r.rendered.title)} |`,
      `| Meta description | ${cell(r.raw.metaDescription)} | ${cell(r.rendered.metaDescription)} |`,
      `| Canonical | ${cell(r.raw.canonical)} | ${cell(r.rendered.canonical)} |`,
      `| Robots | ${r.raw.robots.join(", ") || "—"} | ${r.rendered.robots.join(", ") || "—"} |`,
      `| H1 count | ${r.raw.h1Count} | ${r.rendered.h1Count} |`,
      `| Words | ${r.raw.wordCount} | ${r.rendered.wordCount} |`,
      `| Internal links | ${r.raw.internalLinks} | ${r.rendered.internalLinks} |`,
      `| Structured data items | ${r.raw.structuredDataCount} | ${r.rendered.structuredDataCount} |`,
      ""
    );
  }

  if (audit.baseline) {
    lines.push(...baselineLines(audit.baseline, heading));
  }

  lines.push(...findingsSection(audit.findings, heading));

  return lines.join("\n");
};

const robotsTxtResult = (audit: SiteAudit): string => {
  if (!audit.robotsTxt) {
    return "not checked";
  }

  if (audit.robotsTxt.found) {
    return `found (${audit.robotsTxt.sitemaps.length} sitemap(s) declared)`;
  }

  return `not found (HTTP ${audit.robotsTxt.status ?? "n/a"})`;
};

const siteMarkdown = (audit: SiteAudit): string => {
  const lines: string[] = [
    `# SEO site audit: ${audit.target}`,
    "",
    `Score **${audit.score}/100** · ${countsLine(audit.counts)} · ${audit.crawl.pagesCrawled} pages audited, ${audit.crawl.pagesDiscovered} discovered${audit.crawl.hitPageLimit ? ` (page limit ${audit.crawl.maxPages} reached)` : ""} · ${(audit.crawl.durationMs / 1000).toFixed(1)} s`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| robots.txt | ${robotsTxtResult(audit)} |`,
    `| Sitemaps | ${audit.sitemaps.sources.length ? `${audit.sitemaps.sources.length} file(s), ${audit.sitemaps.urlCount} URLs` : "none found"}${audit.sitemaps.errors.length ? `, ${audit.sitemaps.errors.length} error(s)` : ""} |`,
    "",
  ];

  if (audit.baseline) {
    lines.push(...baselineLines(audit.baseline, "#"));
  }

  if (audit.siteFindings.length) {
    lines.push("## Site-wide findings", "");

    for (const f of audit.siteFindings) {
      lines.push(...findingLines(f));
    }

    lines.push("");
  }

  if (audit.issues.length) {
    lines.push(
      "## Page issues by rule",
      "",
      "| Severity | Rule | Pages | Example |",
      "| --- | --- | --- | --- |"
    );

    for (const i of audit.issues) {
      lines.push(
        `| ${i.severity} | \`${i.rule}\` | ${i.pages} | ${i.examples[0] ?? ""} |`
      );
    }

    lines.push("");
  }

  lines.push(
    ...siteFieldDataLines(audit),
    "## Pages",
    "",
    "| Score | E/W/I | URL | Title |",
    "| --- | --- | --- | --- |"
  );

  for (const p of audit.pages) {
    lines.push(
      `| ${p.score} | ${p.counts.error}/${p.counts.warning}/${p.counts.info} | ${p.url} | ${cell(p.summary.title)} |`
    );
  }

  lines.push("");
  const detailed = audit.pages.filter((p) => p.findings.length > 0);

  if (detailed.length) {
    lines.push("## Page details", "");

    for (const p of detailed) {
      lines.push(
        `### ${p.url}`,
        "",
        `Score ${p.score}/100 · ${countsLine(p.counts)}`,
        ""
      );

      for (const f of p.findings) {
        lines.push(...findingLines(f));
      }

      lines.push("");
    }
  }

  return lines.join("\n");
};

/** One line under every report: which tool and version wrote it, and who makes it. */
const footer = `_Audited with [${PRODUCT_NAME}](${REPOSITORY_URL}) ${VERSION}, made by [${MAKER}](${MAKER_URL})._`;

const robotsCell = (bot: AiBotAccess, pages: number): string => {
  if (!bot.allowed) {
    return "**blocked**";
  }

  return bot.blockedPages > 0
    ? `blocked on ${bot.blockedPages} of ${pages} pages`
    : "allowed";
};

const probeCell = (bot: AiBotAccess): string => {
  if (!bot.probe) {
    return "—";
  }

  return bot.probe.blocked
    ? `**${cell(bot.probe.reason)}**`
    : String(bot.probe.status ?? "—");
};

const llmsTxtLine = (llms: LlmsTxtInfo | null): string => {
  if (!llms) {
    return "not checked";
  }

  if (llms.status === "found") {
    return `found ("${cell(llms.title)}", ${llms.links} links)`;
  }

  return llms.status === "invalid"
    ? `invalid (${cell(llms.problems.join("; "))})`
    : "not found";
};

const crawlerLines = (
  crawlers: AiCrawlerReport,
  llms: LlmsTxtInfo | null,
  pages: number
): string[] => {
  const probed = Boolean(crawlers.probeBaseline);

  const lines = [
    "## AI crawler access",
    "",
    `robots.txt ${crawlers.status}${crawlers.httpStatus ? ` (HTTP ${crawlers.httpStatus})` : ""} · shared AI training preference (\`__usage_ai-training\`): ${crawlers.trainingPreference} · llms.txt ${llmsTxtLine(llms)}`,
    "",
    `| Bot | Operator | Purpose | Used for | robots.txt |${probed ? " Server |" : ""}`,
    `| --- | --- | --- | --- | --- |${probed ? " --- |" : ""}`,
  ];

  for (const bot of crawlers.bots) {
    lines.push(
      `| ${bot.name} | ${bot.operator} | ${bot.purpose} | ${cell(bot.usedFor)} | ${robotsCell(bot, pages)} |${probed ? ` ${probeCell(bot)} |` : ""}`
    );
  }

  if (crawlers.probeBaseline) {
    lines.push(
      "",
      `Server column: what the server answered each bot's User-Agent, sent from this machine (the audit's own request got HTTP ${crawlers.probeBaseline.status ?? "—"}).`
    );
  }

  if (crawlers.contentSignals.length) {
    lines.push("", "Content-Signal lines:", "");

    for (const signal of crawlers.contentSignals) {
      lines.push(
        `- ${signal.userAgents.join(", ") || "(no user agent)"}${signal.path ? ` on ${signal.path}` : ""}: ${
          Object.entries(signal.signals)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "(empty)"
        }`
      );
    }
  }

  lines.push("");

  return lines;
};

const aeoPageLines = (audit: AeoAudit): string[] => {
  const s = audit.summary.page;

  if (!s) {
    return [];
  }

  return [
    audit.pages ? "## Start page" : "## Page",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Indexable | ${s.indexable ? "yes" : "no"} |`,
    `| Google snippets and AI Overviews | ${s.googleSnippets} |`,
    `| Copilot answers | ${s.copilotAnswers} |`,
    `| Words in the HTML | ${s.wordCount} |`,
    `| Question headings | ${s.questions} |`,
    `| Structured data | ${s.structuredDataTypes.length ? s.structuredDataTypes.join(", ") : "—"} |`,
    `| Author | ${cell(s.author)} |`,
    `| Published / modified | ${cell(s.datePublished)} / ${cell(s.dateModified)} |`,
    "",
  ];
};

const aeoMarkdown = (audit: AeoAudit): string => {
  const lines: string[] = [
    `# AEO audit: ${audit.source === "directory" || audit.source === "crawl" ? audit.target : audit.url}`,
    "",
    `AEO score **${audit.score}/100** · ${countsLine(audit.counts)} · ${audit.summary.pages} page(s) audited`,
    "",
  ];

  if (audit.crawlers) {
    lines.push(
      ...crawlerLines(audit.crawlers, audit.llmsTxt, audit.summary.pages)
    );
  }

  lines.push(
    ...aeoPageLines(audit),
    ...(audit.baseline ? baselineLines(audit.baseline, "#") : []),
    ...findingsSection(audit.findings, "#")
  );

  if (audit.issues?.length) {
    lines.push(
      "",
      "## Page issues by rule",
      "",
      "| Severity | Rule | Pages | Example |",
      "| --- | --- | --- | --- |"
    );

    for (const i of audit.issues) {
      lines.push(
        `| ${i.severity} | \`${i.rule}\` | ${i.pages} | ${i.examples[0] ?? ""} |`
      );
    }
  }

  if (audit.pages?.length) {
    lines.push(
      "",
      "## Pages",
      "",
      "| AEO score | E/W/I | URL | Snippets | Copilot | Questions |",
      "| --- | --- | --- | --- | --- | --- |"
    );

    for (const p of audit.pages) {
      lines.push(
        `| ${p.score} | ${p.counts.error}/${p.counts.warning}/${p.counts.info} | ${p.url} | ${p.summary.googleSnippets} | ${p.summary.copilotAnswers} | ${p.summary.questions} |`
      );
    }
  }

  return lines.join("\n");
};

/**
 * The report under its footer, without the control characters a page may hold (GHSA-f4fr-vv3h-fxwg):
 * the report quotes the page, and a person prints it to a terminal with `-f md`, `cat` or an MCP
 * client, where an escape sequence from the page would run.
 */
const finish = (body: string): string =>
  withoutControls(`${body.trimEnd()}\n\n---\n\n${footer}\n`);

/** The Markdown report of an AEO audit. */
export const renderAeoMarkdown = (audit: AeoAudit): string =>
  finish(aeoMarkdown(audit));

export const renderMarkdown = (audit: Audit): string =>
  finish(audit.kind === "page" ? pageMarkdown(audit) : siteMarkdown(audit));
