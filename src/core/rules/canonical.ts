import { hostOf, normalizeUrl, samePath } from '../url.js';
import { cap, defineRule, GOOGLE_DOCS } from './rule.js';

const SELECTOR = 'head > link[rel="canonical"]';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function isLocalHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.test');
}

export const canonicalRules = [
  defineRule(
    {
      id: 'canonical.missing',
      category: 'canonical',
      severity: 'warning',
      description: 'No <link rel="canonical"> is present.',
      recommendation: 'Add a self-referencing canonical with the absolute preferred URL (scheme, host, trailing slash) so duplicate URLs (query strings, www/non-www) consolidate to it.',
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page }, make) => (page.canonicals.length === 0 ? make('Page has no canonical link.', { selector: SELECTOR }) : null),
  ),
  defineRule(
    {
      id: 'canonical.multiple',
      category: 'canonical',
      severity: 'error',
      description: 'More than one canonical link is present. When they disagree, search engines ignore all of them.',
      recommendation: 'Emit exactly one canonical link per page. Check for a framework default plus a hand-written one.',
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page }, make) => {
      if (page.canonicals.length <= 1) return null;
      const distinct = new Set(page.canonicals.map((c) => c.trim()));
      return make(`Page has ${page.canonicals.length} canonical links${distinct.size > 1 ? ' with different targets' : ' (identical)'}.`, {
        selector: SELECTOR,
        severity: distinct.size > 1 ? 'error' : 'warning',
        evidence: { canonicals: cap(page.canonicals) },
      });
    },
  ),
  defineRule(
    {
      id: 'canonical.invalid',
      category: 'canonical',
      severity: 'error',
      description: 'The canonical href is empty or cannot be resolved to an http(s) URL.',
      recommendation: 'Set the canonical href to a valid absolute URL such as https://www.example.com/path/.',
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page }, make) => {
      const first = page.canonicals[0];
      if (first === undefined) return null;
      return page.canonical ? null : make(`Canonical href "${first}" is not a valid URL.`, { selector: SELECTOR, evidence: { href: first } });
    },
  ),
  defineRule(
    {
      id: 'canonical.relative',
      category: 'canonical',
      severity: 'warning',
      description: 'The canonical href is a relative URL.',
      recommendation: 'Use an absolute URL in the canonical link. Relative canonicals are error-prone and some crawlers resolve them unexpectedly.',
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page }, make) => {
      const first = page.canonicals[0];
      if (!first || !page.canonical) return null;
      return /^https?:\/\//i.test(first) ? null : make(`Canonical href "${first}" is relative.`, { selector: SELECTOR, evidence: { href: first, resolved: page.canonical } });
    },
  ),
  defineRule(
    {
      id: 'canonical.protocol-mismatch',
      category: 'canonical',
      severity: 'warning',
      description: 'The page is served over https but the canonical points to http.',
      recommendation: 'Point the canonical at the https URL.',
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page, source }, make) => {
      if (source !== 'url' || !page.canonical) return null;
      return page.url.startsWith('https://') && page.canonical.startsWith('http://')
        ? make('Canonical uses http:// while the page is served over https://.', { selector: SELECTOR, evidence: { canonical: page.canonical, page: page.url } })
        : null;
    },
  ),
  defineRule(
    {
      id: 'canonical.other-page',
      category: 'canonical',
      severity: 'info',
      description: 'The canonical points to a different URL, so search engines will treat this page as a duplicate of that URL.',
      recommendation: 'If this page should rank on its own, make the canonical self-referencing. If it is intentionally a duplicate (print view, filtered list, tracking URL), this is correct.',
      docs: GOOGLE_DOCS.canonical,
    },
    ({ page, source }, make) => {
      if (!page.canonical) return null;
      const pageUrl = normalizeUrl(page.url);
      const canon = normalizeUrl(page.canonical);
      if (!pageUrl || !canon) return null;
      // For files and local dev servers the host is synthetic; compare paths only.
      const pathOnly = source !== 'url' || isLocalHost(page.url);
      const same = pathOnly ? samePath(pageUrl, canon) : stripTrailingSlash(pageUrl) === stripTrailingSlash(canon);
      return same
        ? null
        : make(`Canonical points to ${page.canonical}, not to this page.`, {
            selector: SELECTOR,
            evidence: { canonical: page.canonical, page: page.url, comparedBy: pathOnly ? 'path' : 'url' },
          });
    },
  ),
];

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') && new URL(url).pathname !== '/' ? url.slice(0, -1) : url;
}
