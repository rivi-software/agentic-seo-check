import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditSite, auditUrl } from '../src/core/audit.js';
import { siteRoutes, startFixtureServer, type FixtureServer } from './helpers/fixture-server.js';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer(siteRoutes());
});
afterAll(async () => {
  await server.close();
});

const rulesOf = (findings: { rule: string }[]) => findings.map((f) => f.rule);

describe('auditUrl', () => {
  it('fetches, follows redirects and audits a live page', async () => {
    const audit = await auditUrl(`${server.origin}/redirect`);
    expect(audit.response?.status).toBe(200);
    expect(audit.response?.redirectChain).toHaveLength(1);
    expect(audit.url).toBe(`${server.origin}/about/`);
    expect(rulesOf(audit.findings)).toContain('response.redirected');
    expect(audit.summary.title).toBe('Home page title for fixture');
  });

  it('reports fetch failures as a finding instead of throwing', async () => {
    const audit = await auditUrl('http://127.0.0.1:9/', { fetch: { timeoutMs: 2000 } });
    expect(audit.findings[0]!.rule).toBe('response.fetch-failed');
    expect(audit.score).toBeLessThan(100);
  });
});

describe('auditSite', () => {
  it('crawls the fixture site and produces site-level findings', async () => {
    const site = await auditSite(server.origin, { maxPages: 20, maxDepth: 3, concurrency: 3 });
    const siteRules = rulesOf(site.siteFindings);
    const evidence = (rule: string) => site.siteFindings.find((f) => f.rule === rule)?.evidence as Record<string, unknown> | undefined;

    expect(site.kind).toBe('site');
    expect(site.robotsTxt?.found).toBe(true);
    expect(site.sitemaps.urlCount).toBe(5);
    expect(site.crawl.pagesCrawled).toBeGreaterThanOrEqual(3);
    expect(site.pages.map((p) => p.url)).toEqual(expect.arrayContaining([`${server.origin}/`, `${server.origin}/about/`, `${server.origin}/blog/post-1`]));

    expect(siteRules).toContain('site.broken-internal-links');
    expect(JSON.stringify(evidence('site.broken-internal-links'))).toContain('/missing');
    expect(siteRules).toContain('site.redirected-internal-links');
    expect(JSON.stringify(evidence('site.redirected-internal-links'))).toContain('/redirect');
    expect(siteRules).toContain('site.redirect-chains');
    expect(JSON.stringify(evidence('site.redirect-chains'))).toContain('/chain');
    expect(siteRules).toContain('site.sitemap-noindex-page');
    expect(JSON.stringify(evidence('site.sitemap-noindex-page'))).toContain('/blog/post-1');
    expect(siteRules).toContain('site.sitemap-broken-url');
    expect(JSON.stringify(evidence('site.sitemap-broken-url'))).toContain('/gone');
    expect(siteRules).toContain('site.orphan-pages');
    expect(JSON.stringify(evidence('site.orphan-pages'))).toContain('/orphan');
    expect(siteRules).toContain('site.duplicate-titles');
    expect(siteRules).toContain('site.robots-blocked-pages');
    expect(JSON.stringify(evidence('site.robots-blocked-pages'))).toContain('/private/secret');
    expect(siteRules).not.toContain('site.soft-404');
    expect(siteRules).not.toContain('site.sitemap-missing');
    expect(siteRules).not.toContain('site.robots-txt-missing');
    // robots-blocked page was not fetched
    expect(server.requests).not.toContain('/private/secret');
    // issues roll up page findings by rule
    expect(site.issues.length).toBeGreaterThan(0);
    expect(site.issues.every((i) => i.pages >= 1 && i.examples.length >= 1)).toBe(true);
    expect(site.score).toBeGreaterThanOrEqual(0);
  });

  it('respects maxPages and reports the limit', async () => {
    const site = await auditSite(server.origin, { maxPages: 1, maxDepth: 3 });
    expect(site.crawl.pagesCrawled).toBe(1);
    expect(site.crawl.hitPageLimit).toBe(true);
    expect(rulesOf(site.siteFindings)).toContain('site.crawl-limit-reached');
    expect(rulesOf(site.siteFindings)).not.toContain('site.orphan-pages');
  });

  it('can ignore robots.txt', async () => {
    const site = await auditSite(server.origin, { maxPages: 20, respectRobots: false });
    expect(site.pages.map((p) => p.url)).toContain(`${server.origin}/private/secret`);
  });

  it('pageDetail summary strips per-page findings', async () => {
    const site = await auditSite(server.origin, { maxPages: 5, pageDetail: 'summary' });
    expect(site.pages.every((p) => p.findings.length === 0)).toBe(true);
    expect(site.issues.length).toBeGreaterThan(0);
  });
});
