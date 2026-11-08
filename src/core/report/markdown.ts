import type { Audit, Finding, PageAudit, SiteAudit } from "../types.js";

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

const findingLines = (f: Finding): string[] => {
  const out = [
    `- **\`${f.rule}\`** ${f.message}`,
    `  - Fix: ${f.recommendation}`,
  ];

  if (f.selector) {
    out.push(`  - Where: \`${f.selector}\``);
  }

  if (f.evidence && Object.keys(f.evidence).length) {
    out.push(`  - Evidence: \`${JSON.stringify(f.evidence).slice(0, 400)}\``);
  }

  return out;
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

export const renderMarkdown = (audit: Audit): string =>
  audit.kind === "page" ? pageMarkdown(audit) : siteMarkdown(audit);
