import type { ExtractedPage, Finding, RenderComparison, RenderSnapshot, ResponseInfo, RuleMeta } from './types.js';
import { robotsDirectives } from './rules/indexing.js';
import { finding, GOOGLE_DOCS } from './rules/rule.js';

const meta = (id: string, severity: RuleMeta['severity'], description: string, recommendation: string): RuleMeta => ({
  id,
  category: 'rendering',
  severity,
  description,
  recommendation,
  docs: GOOGLE_DOCS.javascript,
  requires: 'render',
});

const SSR_FIX = 'Render this in the server HTML (SSR/SSG/prerender). Googlebot queues JavaScript rendering separately and other crawlers and link previews never run it.';

export const RENDER_RULES: RuleMeta[] = [
  meta('rendering.title-client-only', 'warning', 'The <title> only exists after JavaScript runs.', SSR_FIX),
  meta('rendering.title-changed', 'info', 'JavaScript changes the <title> after load.', 'Make the server HTML title match the final title so both agree.'),
  meta('rendering.description-client-only', 'warning', 'The meta description only exists after JavaScript runs.', SSR_FIX),
  meta('rendering.canonical-client-only', 'warning', 'The canonical link only exists after JavaScript runs.', SSR_FIX),
  meta('rendering.canonical-changed', 'warning', 'JavaScript changes the canonical URL after load, sending conflicting signals.', 'Emit the final canonical in the server HTML and do not modify it client-side.'),
  meta('rendering.noindex-client-only', 'error', 'A noindex directive is injected by JavaScript. Google applies it when it renders the page, which removes the page from the index.', 'Remove the client-side noindex (often a framework/head-manager default or an auth guard) or move the decision to the server.'),
  meta('rendering.noindex-removed-by-js', 'warning', 'The server HTML says noindex but JavaScript removes it. Google honours the server noindex and skips rendering, so the page stays out of the index.', 'Remove noindex from the server HTML if the page should be indexed.'),
  meta('rendering.h1-client-only', 'warning', 'The <h1> only exists after JavaScript runs.', SSR_FIX),
  meta('rendering.content-client-only', 'warning', 'Most of the body text only exists after JavaScript runs.', SSR_FIX),
  meta('rendering.links-client-only', 'warning', 'Most internal links only exist after JavaScript runs, delaying discovery of the linked pages.', `${SSR_FIX} At minimum, render the main navigation and content links server-side.`),
  meta('rendering.structured-data-client-only', 'info', 'Structured data is only added by JavaScript.', 'Google processes JSON-LD injected by JavaScript, but other consumers do not. Prefer emitting it in the server HTML.'),
  meta('rendering.console-errors', 'info', 'The page logged JavaScript errors while rendering.', 'Fix runtime errors; a failing script can leave crawlers with an incomplete page.'),
];

const byId = new Map(RENDER_RULES.map((r) => [r.id, r]));
const m = (id: string): RuleMeta => byId.get(id)!;

export function snapshot(page: ExtractedPage, response?: ResponseInfo): RenderSnapshot {
  return {
    title: page.title,
    metaDescription: page.metaDescription,
    canonical: page.canonical,
    robots: robotsDirectives(page, response).directives,
    h1Count: page.h1s.filter(Boolean).length,
    wordCount: page.wordCount,
    internalLinks: page.links.filter((l) => l.internal).length,
    structuredDataCount: page.structuredData.length,
  };
}

export function compareRender(
  raw: ExtractedPage,
  rendered: ExtractedPage,
  renderedUrl: string,
  consoleErrors: string[],
  rawResponse?: ResponseInfo,
): { comparison: RenderComparison; findings: Finding[] } {
  const a = snapshot(raw, rawResponse);
  const b = snapshot(rendered);
  const findings: Finding[] = [];
  const url = rawResponse?.finalUrl ?? raw.url;
  const add = (f: Finding) => findings.push({ ...f, url });

  if (!a.title && b.title) add(finding(m('rendering.title-client-only'), `Title "${b.title}" is only present after rendering.`, { selector: 'head > title', evidence: { raw: a.title, rendered: b.title } }));
  else if (a.title && b.title && a.title !== b.title) add(finding(m('rendering.title-changed'), 'Title differs between server HTML and rendered DOM.', { selector: 'head > title', evidence: { raw: a.title, rendered: b.title } }));

  if (!a.metaDescription && b.metaDescription) add(finding(m('rendering.description-client-only'), 'Meta description is only present after rendering.', { selector: 'head > meta[name="description"]', evidence: { rendered: b.metaDescription } }));

  if (!a.canonical && b.canonical) add(finding(m('rendering.canonical-client-only'), `Canonical ${b.canonical} is only present after rendering.`, { selector: 'head > link[rel="canonical"]', evidence: { rendered: b.canonical } }));
  else if (a.canonical && b.canonical && a.canonical !== b.canonical) add(finding(m('rendering.canonical-changed'), 'Canonical differs between server HTML and rendered DOM.', { selector: 'head > link[rel="canonical"]', evidence: { raw: a.canonical, rendered: b.canonical } }));

  const rawNoindex = a.robots.some((d) => d === 'noindex' || d === 'none');
  const renderedNoindex = b.robots.some((d) => d === 'noindex' || d === 'none');
  if (!rawNoindex && renderedNoindex) add(finding(m('rendering.noindex-client-only'), 'noindex is added by JavaScript.', { selector: 'head > meta[name="robots"]', evidence: { raw: a.robots, rendered: b.robots } }));
  if (rawNoindex && !renderedNoindex) add(finding(m('rendering.noindex-removed-by-js'), 'Server HTML contains noindex; JavaScript removes it.', { selector: 'head > meta[name="robots"]', evidence: { raw: a.robots, rendered: b.robots } }));

  if (a.h1Count === 0 && b.h1Count > 0) add(finding(m('rendering.h1-client-only'), 'The <h1> is only present after rendering.', { selector: 'h1', evidence: { rawH1Count: a.h1Count, renderedH1Count: b.h1Count } }));

  if (b.wordCount - a.wordCount >= 100 && a.wordCount < b.wordCount * 0.5) {
    add(finding(m('rendering.content-client-only'), `Server HTML has ${a.wordCount} words; rendered DOM has ${b.wordCount}.`, { evidence: { rawWords: a.wordCount, renderedWords: b.wordCount } }));
  }
  if (b.internalLinks - a.internalLinks >= 10 && a.internalLinks < b.internalLinks * 0.5) {
    add(finding(m('rendering.links-client-only'), `Server HTML has ${a.internalLinks} internal links; rendered DOM has ${b.internalLinks}.`, { evidence: { rawLinks: a.internalLinks, renderedLinks: b.internalLinks } }));
  }
  if (a.structuredDataCount === 0 && b.structuredDataCount > 0) add(finding(m('rendering.structured-data-client-only'), `${b.structuredDataCount} structured data item(s) are only present after rendering.`, { evidence: { renderedCount: b.structuredDataCount } }));
  if (consoleErrors.length) add(finding(m('rendering.console-errors'), `${consoleErrors.length} JavaScript error(s) logged during render.`, { evidence: { errors: consoleErrors.slice(0, 5) } }));

  return { comparison: { tool: 'playwright', renderedUrl, consoleErrors: consoleErrors.slice(0, 20), raw: a, rendered: b }, findings };
}
