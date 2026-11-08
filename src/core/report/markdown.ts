import type { Audit, Finding, PageAudit, SiteAudit } from '../types.js';

export function renderMarkdown(audit: Audit): string {
  return audit.kind === 'page' ? pageMarkdown(audit) : siteMarkdown(audit);
}

function pageMarkdown(audit: PageAudit, heading = '#'): string {
  const lines: string[] = [];
  lines.push(`${heading} SEO audit: ${audit.url}`);
  lines.push('');
  lines.push(`Score **${audit.score}/100** · ${countsLine(audit.counts)}${audit.response?.status ? ` · HTTP ${audit.response.status}` : ''}${audit.response?.timeMs ? ` · ${audit.response.timeMs} ms` : ''}`);
  lines.push('');
  const s = audit.summary;
  lines.push(`${heading}# Summary`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Title | ${cell(s.title)} (${s.titleLength} chars) |`);
  lines.push(`| Meta description | ${cell(s.metaDescription)} (${s.metaDescriptionLength} chars) |`);
  lines.push(`| Canonical | ${cell(s.canonical)} |`);
  lines.push(`| Indexable | ${s.indexable ? 'yes' : 'no'}${s.robots.length ? ` (${s.robots.join(', ')})` : ''} |`);
  lines.push(`| Language | ${cell(s.lang)} |`);
  lines.push(`| H1 | ${s.h1.length ? s.h1.map(cell).join(' / ') : '—'} |`);
  lines.push(`| Words | ${s.wordCount} |`);
  lines.push(`| Images | ${s.images.total} (${s.images.missingAlt} without alt) |`);
  lines.push(`| Links | ${s.links.internal} internal, ${s.links.external} external |`);
  lines.push(`| Structured data | ${s.structuredDataTypes.length ? s.structuredDataTypes.join(', ') : '—'} |`);
  lines.push(`| Open Graph | ${Object.keys(s.openGraph).length ? Object.keys(s.openGraph).map((k) => `og:${k}`).join(', ') : '—'} |`);
  lines.push('');
  if (audit.performance) {
    const m = audit.performance.metrics;
    lines.push(`${heading}# Lighthouse (${audit.performance.formFactor})`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Performance score | ${m.performanceScore ?? '—'} |`);
    lines.push(`| SEO score | ${m.seoScore ?? '—'} |`);
    lines.push(`| LCP | ${ms(m.lcpMs)} |`);
    lines.push(`| CLS | ${m.cls === null ? '—' : m.cls.toFixed(3)} |`);
    lines.push(`| TBT | ${ms(m.tbtMs)} |`);
    lines.push(`| FCP | ${ms(m.fcpMs)} |`);
    lines.push(`| Speed Index | ${ms(m.speedIndexMs)} |`);
    lines.push(`| TTFB | ${ms(m.ttfbMs)} |`);
    lines.push('');
  }
  if (audit.rendering) {
    const r = audit.rendering;
    lines.push(`${heading}# Rendered vs server HTML`);
    lines.push('');
    lines.push('| Field | Server HTML | Rendered DOM |');
    lines.push('| --- | --- | --- |');
    lines.push(`| Title | ${cell(r.raw.title)} | ${cell(r.rendered.title)} |`);
    lines.push(`| Meta description | ${cell(r.raw.metaDescription)} | ${cell(r.rendered.metaDescription)} |`);
    lines.push(`| Canonical | ${cell(r.raw.canonical)} | ${cell(r.rendered.canonical)} |`);
    lines.push(`| Robots | ${r.raw.robots.join(', ') || '—'} | ${r.rendered.robots.join(', ') || '—'} |`);
    lines.push(`| H1 count | ${r.raw.h1Count} | ${r.rendered.h1Count} |`);
    lines.push(`| Words | ${r.raw.wordCount} | ${r.rendered.wordCount} |`);
    lines.push(`| Internal links | ${r.raw.internalLinks} | ${r.rendered.internalLinks} |`);
    lines.push(`| Structured data items | ${r.raw.structuredDataCount} | ${r.rendered.structuredDataCount} |`);
    lines.push('');
  }
  lines.push(...findingsSection(audit.findings, heading));
  return lines.join('\n');
}

function siteMarkdown(audit: SiteAudit): string {
  const lines: string[] = [];
  lines.push(`# SEO site audit: ${audit.target}`);
  lines.push('');
  lines.push(`Score **${audit.score}/100** · ${countsLine(audit.counts)} · ${audit.crawl.pagesCrawled} pages audited, ${audit.crawl.pagesDiscovered} discovered${audit.crawl.hitPageLimit ? ` (page limit ${audit.crawl.maxPages} reached)` : ''} · ${(audit.crawl.durationMs / 1000).toFixed(1)} s`);
  lines.push('');
  lines.push('| Check | Result |');
  lines.push('| --- | --- |');
  lines.push(`| robots.txt | ${audit.robotsTxt ? (audit.robotsTxt.found ? `found (${audit.robotsTxt.sitemaps.length} sitemap(s) declared)` : `not found (HTTP ${audit.robotsTxt.status ?? 'n/a'})`) : 'not checked'} |`);
  lines.push(`| Sitemaps | ${audit.sitemaps.sources.length ? `${audit.sitemaps.sources.length} file(s), ${audit.sitemaps.urlCount} URLs` : 'none found'}${audit.sitemaps.errors.length ? `, ${audit.sitemaps.errors.length} error(s)` : ''} |`);
  lines.push('');
  if (audit.siteFindings.length) {
    lines.push('## Site-wide findings');
    lines.push('');
    for (const f of audit.siteFindings) lines.push(...findingLines(f));
    lines.push('');
  }
  if (audit.issues.length) {
    lines.push('## Page issues by rule');
    lines.push('');
    lines.push('| Severity | Rule | Pages | Example |');
    lines.push('| --- | --- | --- | --- |');
    for (const i of audit.issues) lines.push(`| ${i.severity} | \`${i.rule}\` | ${i.pages} | ${i.examples[0] ?? ''} |`);
    lines.push('');
  }
  lines.push('## Pages');
  lines.push('');
  lines.push('| Score | E/W/I | URL | Title |');
  lines.push('| --- | --- | --- | --- |');
  for (const p of audit.pages) lines.push(`| ${p.score} | ${p.counts.error}/${p.counts.warning}/${p.counts.info} | ${p.url} | ${cell(p.summary.title)} |`);
  lines.push('');
  const detailed = audit.pages.filter((p) => p.findings.length > 0);
  if (detailed.length) {
    lines.push('## Page details');
    lines.push('');
    for (const p of detailed) {
      lines.push(`### ${p.url}`);
      lines.push('');
      lines.push(`Score ${p.score}/100 · ${countsLine(p.counts)}`);
      lines.push('');
      for (const f of p.findings) lines.push(...findingLines(f));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function findingsSection(findings: Finding[], heading: string): string[] {
  const lines: string[] = [];
  lines.push(`${heading}# Findings`);
  lines.push('');
  if (!findings.length) {
    lines.push('No issues found.');
    return lines;
  }
  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = findings.filter((f) => f.severity === severity);
    if (!group.length) continue;
    lines.push(`${heading}## ${severity === 'error' ? 'Errors' : severity === 'warning' ? 'Warnings' : 'Info'} (${group.length})`);
    lines.push('');
    for (const f of group) lines.push(...findingLines(f));
    lines.push('');
  }
  return lines;
}

function findingLines(f: Finding): string[] {
  const out = [`- **\`${f.rule}\`** ${f.message}`];
  out.push(`  - Fix: ${f.recommendation}`);
  if (f.selector) out.push(`  - Where: \`${f.selector}\``);
  if (f.evidence && Object.keys(f.evidence).length) out.push(`  - Evidence: \`${JSON.stringify(f.evidence).slice(0, 400)}\``);
  return out;
}

function countsLine(c: { error: number; warning: number; info: number }): string {
  return `${c.error} error(s), ${c.warning} warning(s), ${c.info} info`;
}

function cell(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
}

function ms(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}
