import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import {
  auditDirectory,
  auditHtml,
  auditSite,
  auditUrl,
} from "../src/core/audit.js";
import {
  CRUX_ENDPOINT,
  FieldDataKeyError,
  notPublicReason,
} from "../src/core/field-data.js";
import type { FieldDataCache } from "../src/core/field-data.js";
import { baselineFromAudit } from "../src/core/recheck.js";
import { renderMarkdown } from "../src/core/report/markdown.js";
import { renderText } from "../src/core/report/text.js";
import type { Finding } from "../src/core/types.js";
import { incompleteEdits, unquotedEdits, withoutFix } from "./helpers/fixes.js";
import { tableUnder } from "./helpers/tables.js";

const KEY = "test-crux-key";

const CruxQuery = z.object({
  url: z.string().optional(),
  origin: z.string().optional(),
  formFactor: z.string(),
  metrics: z.array(z.string()),
});

type Query = z.infer<typeof CruxQuery>;

interface Answer {
  status: number;
  body?: unknown;
}

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** The API's answer for a URL or origin without a record. */
const NOT_FOUND: Answer = {
  status: 404,
  body: {
    error: {
      code: 404,
      message: "chrome ux report data not found",
      status: "NOT_FOUND",
    },
  },
};

/** Every query the Chrome UX Report got, with the key it came with. */
const queries: (Query & { key: string | null })[] = [];

/** Every request to a site. */
const pageRequests: string[] = [];

/**
 * The web the core's fetch() sees: `routes` by absolute URL, and the Chrome UX Report, which
 * answers each query with `crux`.
 */
const serve = (
  routes: Record<string, Route>,
  crux: (query: Query) => Answer = () => NOT_FOUND
) => {
  queries.length = 0;
  pageRequests.length = 0;

  vi.stubGlobal(
    "fetch",
    // oxlint-disable-next-line eslint/require-await -- fetch() answers with a promise
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));

      if (`${url.origin}${url.pathname}` === CRUX_ENDPOINT) {
        const query = CruxQuery.parse(JSON.parse(String(init?.body)));
        queries.push({ ...query, key: url.searchParams.get("key") });
        const answer = crux(query);

        return Response.json(answer.body ?? {}, { status: answer.status });
      }

      pageRequests.push(url.href);
      const route = routes[url.href];

      return new Response(route ? (route.body ?? "") : "Not found", {
        status: route ? (route.status ?? 200) : 404,
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...route?.headers,
        },
      });
    }
  );
};

/** One metric as the API sends it: three bins and the 75th percentile, CLS as text. */
const metric = (
  p75: number,
  [good, poor]: readonly [number, number],
  densities: readonly [number, number, number],
  text = false
) => {
  const value = (n: number) => (text ? n.toFixed(2) : n);

  return {
    histogram: [
      { start: value(0), end: value(good), density: densities[0] },
      { start: value(good), end: value(poor), density: densities[1] },
      { start: value(poor), density: densities[2] },
    ],
    percentiles: { p75: value(p75) },
  };
};

interface P75 {
  lcp?: number;
  inp?: number;
  cls?: number;
  fcp?: number;
  ttfb?: number;
}

/** Each metric's API name and thresholds, by its key in P75. */
const API_METRICS = {
  lcp: ["largest_contentful_paint", [2500, 4000]],
  inp: ["interaction_to_next_paint", [200, 500]],
  cls: ["cumulative_layout_shift", [0.1, 0.25]],
  fcp: ["first_contentful_paint", [1800, 3000]],
  ttfb: ["experimental_time_to_first_byte", [800, 1800]],
} as const;

const GOOD: P75 = { lcp: 1800, inp: 120, cls: 0.02, fcp: 1200, ttfb: 400 };

const SLOW: P75 = { lcp: 4800, inp: 640, cls: 0.3, fcp: 2600, ttfb: 1300 };

/** A record of the Chrome UX Report with these 75th percentiles. */
const record = (
  p75: P75,
  densities: readonly [number, number, number] = [0.7, 0.2, 0.1]
): Answer => {
  const metrics: Record<string, ReturnType<typeof metric>> = {};

  for (const name of ["lcp", "inp", "cls", "fcp", "ttfb"] as const) {
    const [apiName, thresholds] = API_METRICS[name];
    const value = p75[name];

    if (value !== undefined) {
      metrics[apiName] = metric(value, thresholds, densities, name === "cls");
    }
  }

  return {
    status: 200,
    body: {
      record: {
        key: { formFactor: "PHONE" },
        metrics,
        collectionPeriod: {
          firstDate: { year: 2026, month: 10, day: 13 },
          lastDate: { year: 2026, month: 11, day: 9 },
        },
      },
    },
  };
};

const slowLcp = () => record({ ...GOOD, lcp: 4600 });

const PAGE_URL = "https://www.example.com/widgets";

const page = (body = "<p>Blue widgets for every workshop.</p>", head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Blue widgets for every workshop | Acme</title>${head}</head><body><h1>Blue widgets</h1>${body}</body></html>`;

const FIELD = { apiKey: KEY };

const fieldFindings = (findings: Finding[]) =>
  findings.filter((f) => f.rule.startsWith("perf.field-"));

const rulesOf = (findings: Finding[]) => findings.map((f) => f.rule);

/** Audits `html` at PAGE_URL with field data, checking every field finding's fix. */
const auditPage = async (
  html: string,
  crux: (query: Query) => Answer,
  options: Parameters<typeof auditUrl>[1] = {}
) => {
  serve({ [PAGE_URL]: { body: html } }, crux);
  const audit = await auditUrl(PAGE_URL, { fieldData: FIELD, ...options });
  const mine = fieldFindings(audit.findings);

  expect(withoutFix(mine)).toStrictEqual([]);
  expect(incompleteEdits(mine)).toStrictEqual([]);
  expect(unquotedEdits(mine, html)).toStrictEqual([]);

  return { audit, mine };
};

describe("field data (issue #130)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("of a page", () => {
    it("reads the URL's record: each metric's 75th percentile and its share of visits", async () => {
      const { audit, mine } = await auditPage(page(), () => record(GOOD));
      const shares = { good: 0.7, needsImprovement: 0.2, poor: 0.1 };

      expect(audit.fieldData).toStrictEqual({
        source: "url",
        formFactor: "PHONE",
        period: { firstDate: "2026-10-13", lastDate: "2026-11-09" },
        lcpMs: { p75: 1800, ...shares },
        inpMs: { p75: 120, ...shares },
        cls: { p75: 0.02, ...shares },
        fcpMs: { p75: 1200, ...shares },
        ttfbMs: { p75: 400, ...shares },
      });
      expect(mine).toStrictEqual([]);
    });

    it("asks for the page's URL on phones, for the five metrics, with the key", async () => {
      serve({ [`${PAGE_URL}?utm_source=news`]: { body: page() } }, () =>
        record(GOOD)
      );

      await auditUrl(`${PAGE_URL}?utm_source=news`, { fieldData: FIELD });

      expect(queries).toStrictEqual([
        {
          url: PAGE_URL,
          formFactor: "PHONE",
          metrics: [
            "largest_contentful_paint",
            "interaction_to_next_paint",
            "cumulative_layout_shift",
            "first_contentful_paint",
            "experimental_time_to_first_byte",
          ],
          key: KEY,
        },
      ]);
    });

    it("asks for the origin when the URL has no record, and says whose record it is", async () => {
      const { audit, mine } = await auditPage(page(), (q) =>
        q.origin ? slowLcp() : NOT_FOUND
      );

      expect(queries.map((q) => q.url ?? q.origin)).toStrictEqual([
        PAGE_URL,
        "https://www.example.com",
      ]);
      expect(audit.fieldData?.source).toBe("origin");
      expect(rulesOf(mine)).toStrictEqual(["perf.field-lcp-poor"]);
      expect(mine[0]?.message).toContain("for the whole origin");
      expect(mine[0]?.evidence).toMatchObject({
        source: "origin",
        lcpMs: 4600,
      });
    });

    it("reports nothing when neither the URL nor its origin has a record", async () => {
      const { audit, mine } = await auditPage(page(), () => NOT_FOUND);

      expect(audit.fieldData).toMatchObject({
        source: null,
        reason: "no-data",
      });
      expect(mine).toStrictEqual([]);
    });

    it("reports a poor metric as a warning and one that needs improvement as info", async () => {
      const { mine } = await auditPage(page(), () =>
        record({ lcp: 3100, inp: 650, cls: 0.12, fcp: 2000, ttfb: 500 })
      );

      expect(mine.map((f) => [f.rule, f.severity])).toStrictEqual([
        ["perf.field-inp-poor", "warning"],
        ["perf.field-cls-needs-improvement", "info"],
        ["perf.field-lcp-needs-improvement", "info"],
      ]);
      // CrUX gives CLS to two places, as the message shows it.
      expect(
        mine.find((f) => f.rule === "perf.field-cls-needs-improvement")?.message
      ).toContain("is 0.12 over 28 days");
    });

    it("stays quiet on good-page.html with a good record, and quotes it in the fixes of a poor one", async () => {
      const html = readFileSync(
        new URL("fixtures/good-page.html", import.meta.url),
        "utf-8"
      );

      const good = await auditPage(html, () => record(GOOD));
      const poor = await auditPage(html, () => record(SLOW));

      expect(good.mine).toStrictEqual([]);
      expect(rulesOf(poor.mine)).toStrictEqual([
        "perf.field-cls-poor",
        "perf.field-inp-poor",
        "perf.field-lcp-poor",
      ]);
    });

    it("says a directory's first pages have no URL to ask for, and names the reason in the report", async () => {
      vi.stubEnv("CRUX_API_KEY", "");
      serve({});
      const dir = await mkdtemp(nodePath.join(tmpdir(), "agentic-seo-field-"));

      onTestFinished(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      await writeFile(
        nodePath.join(dir, "index.html"),
        page('<a href="/a.html">A</a>')
      );
      await writeFile(nodePath.join(dir, "a.html"), page());

      const audit = await auditDirectory(dir, {
        baseUrl: PAGE_URL,
        fieldData: { maxPages: 1 },
      });

      expect(
        audit.pages
          .map((p) =>
            p.fieldData?.source === null ? p.fieldData.reason : "none"
          )
          .toSorted()
      ).toStrictEqual(["none", "not-public"]);
      expect(renderMarkdown(audit)).toMatch(/\| not sent \| — \| — \| — \|/u);
      expect(queries).toStrictEqual([]);
    });

    it("says HTML has no URL to ask for, without a key or a query", async () => {
      vi.stubEnv("CRUX_API_KEY", "");
      serve({});

      const audit = await auditHtml(
        page(),
        { url: PAGE_URL, source: "html" },
        { fieldData: true }
      );

      expect(audit.fieldData).toMatchObject({
        source: null,
        reason: "not-public",
        message: expect.stringContaining("The audit read HTML"),
      });
      expect(queries).toStrictEqual([]);
    });

    it("says the value, whose it is and the period", async () => {
      const { mine } = await auditPage(page(), () =>
        record({ ...GOOD, inp: 650 })
      );

      const inp = mine.find((f) => f.rule === "perf.field-inp-poor");

      expect(inp?.message).toBe(
        "On phones, the 75th percentile of Interaction to Next Paint (INP) is 650 ms over 28 days of real Chrome visits for this URL (poor: over 500 ms); 10% of visits were poor."
      );
      expect(inp?.evidence).toStrictEqual({
        inpMs: 650,
        source: "url",
        period: { firstDate: "2026-10-13", lastDate: "2026-11-09" },
        good: 0.7,
        needsImprovement: 0.2,
        poor: 0.1,
      });
    });

    it("never shows a value just over a threshold as the threshold", async () => {
      const { mine } = await auditPage(page(), () =>
        record({ ...GOOD, lcp: 2543 })
      );

      expect(mine[0]?.message).toContain(
        "is 2,543 ms over 28 days of real Chrome visits for this URL (needs improvement: over 2,500 ms)"
      );
    });

    it("keeps quiet at Google's thresholds, which are still good", async () => {
      const { mine } = await auditPage(page(), () =>
        record({ lcp: 2500, inp: 200, cls: 0.1, fcp: 1800, ttfb: 800 })
      );

      expect(mine).toStrictEqual([]);
    });

    it("judges only the metrics the record has", async () => {
      const { audit, mine } = await auditPage(page(), () =>
        record({ lcp: 5000, cls: 0.4 })
      );

      expect(audit.fieldData).toMatchObject({ inpMs: null, fcpMs: null });
      expect(rulesOf(mine)).toStrictEqual([
        "perf.field-cls-poor",
        "perf.field-lcp-poor",
      ]);
    });

    it("never sends a local, private or IP address", () => {
      const local = [
        "http://localhost:3000/",
        "http://shop.local/",
        "http://192.168.1.10/",
        "http://[::1]:8080/",
        "http://intranet/",
        "https://staging.example.test/",
      ].filter((url) => notPublicReason(url, false) === null);

      expect(local).toStrictEqual([]);
      expect(notPublicReason(PAGE_URL, false)).toBeNull();
      expect(notPublicReason(PAGE_URL, true)).toContain("request headers");
    });

    it("tells a page on localhost or behind a login why it has no field data", async () => {
      serve({ "http://localhost:3000/": { body: page() } }, () => record(GOOD));

      const local = await auditUrl("http://localhost:3000/", {
        fieldData: FIELD,
      });

      serve({ [PAGE_URL]: { body: page() } }, () => record(GOOD));

      const login = await auditUrl(PAGE_URL, {
        fieldData: FIELD,
        fetch: { headers: { authorization: "Basic dGVzdDp0ZXN0" } },
      });

      expect(local.fieldData).toMatchObject({ reason: "not-public" });
      expect(login.fieldData).toMatchObject({ reason: "not-public" });
      expect(queries).toStrictEqual([]);
    });

    it("asks nothing for a page that did not answer 200", async () => {
      serve({ [PAGE_URL]: { status: 404, body: page() } }, () => record(GOOD));
      const audit = await auditUrl(PAGE_URL, { fieldData: FIELD });

      expect(audit.fieldData).toBeUndefined();
      expect(queries).toStrictEqual([]);
    });

    it("reads the key from CRUX_API_KEY", async () => {
      vi.stubEnv("CRUX_API_KEY", "key-from-env");
      serve({ [PAGE_URL]: { body: page() } }, () => record(GOOD));
      await auditUrl(PAGE_URL, { fieldData: true });

      expect(queries.map((q) => q.key)).toStrictEqual(["key-from-env"]);
    });

    it("fails before any request without a key, and says how to get one", async () => {
      vi.stubEnv("CRUX_API_KEY", "");
      serve({ [PAGE_URL]: { body: page() } }, () => record(GOOD));

      const failed = auditUrl(PAGE_URL, { fieldData: true });

      await expect(failed).rejects.toThrow(FieldDataKeyError);
      await expect(failed).rejects.toThrow(
        /console\.cloud\.google\.com\/apis\/credentials/u
      );
      expect(pageRequests).toStrictEqual([]);
    });

    it("stops at a key the API refuses, and says why", async () => {
      serve({ [PAGE_URL]: { body: page() } }, () => ({
        status: 403,
        body: {
          error: {
            code: 403,
            message:
              "Chrome UX Report API has not been used in project 1 before or it is disabled.",
            status: "PERMISSION_DENIED",
          },
        },
      }));

      await expect(auditUrl(PAGE_URL, { fieldData: FIELD })).rejects.toThrow(
        /refused the API key \(403: Chrome UX Report API has not been used/u
      );
    });

    it("gives the reason when the API is busy, and reports nothing", async () => {
      const { audit, mine } = await auditPage(page(), () => ({
        status: 429,
        body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } },
      }));

      expect(audit.fieldData).toMatchObject({
        source: null,
        reason: "unavailable",
        message: expect.stringContaining("quota"),
      });
      expect(mine).toStrictEqual([]);
    });

    it("keeps records and missing records in the cache, but not a failed answer", async () => {
      const kept = new Map<string, string>();

      const cache: FieldDataCache = {
        // oxlint-disable-next-line eslint/require-await -- the cache's methods answer with promises
        get: async (key) => kept.get(key),
        // oxlint-disable-next-line eslint/require-await -- the cache's methods answer with promises
        put: async (key, value) => {
          kept.set(key, value);
        },
      };

      let busy = true;

      serve({ [PAGE_URL]: { body: page() } }, (q) => {
        if (q.url && busy) {
          return { status: 503, body: {} };
        }

        return q.url ? record(GOOD) : NOT_FOUND;
      });

      const options = { fieldData: { apiKey: KEY, cache } };
      const first = await auditUrl(PAGE_URL, options);
      busy = false;
      const second = await auditUrl(PAGE_URL, options);
      const third = await auditUrl(PAGE_URL, options);

      expect(first.fieldData).toMatchObject({ reason: "unavailable" });
      expect(third.fieldData).toStrictEqual(second.fieldData);
      // The busy URL, the origin, the URL again; the third audit asked the cache alone.
      expect(queries.map((q) => q.url ?? q.origin)).toStrictEqual([
        PAGE_URL,
        "https://www.example.com",
        PAGE_URL,
      ]);
      expect([...kept.keys()].filter((k) => k.includes(KEY))).toStrictEqual([]);
    });
  });

  describe("the fixes of field findings", () => {
    it("loads a lazy first image at once, defers blocking scripts and caches a slow first byte", async () => {
      const html = page(
        '<img src="/hero.jpg" alt="A blue widget" width="1200" height="600" loading="lazy">',
        '<script src="/js/app.js"></script>'
      );

      const { mine } = await auditPage(html, () => record(SLOW));
      const lcp = mine.find((f) => f.rule === "perf.field-lcp-poor");

      expect(lcp?.fix).toMatchObject([
        {
          in: "html",
          action: "replace",
          current:
            '<img src="/hero.jpg" alt="A blue widget" width="1200" height="600" loading="lazy">',
          code: '<img src="/hero.jpg" alt="A blue widget" width="1200" height="600" fetchpriority="high">',
        },
        { in: "html", action: "replace", current: '<script src="/js/app.js">' },
        {
          in: "http",
          at: "Cache-Control",
          write: expect.stringContaining(
            "Real visits on phones wait 1300 ms for the first byte of the HTML at the 75th percentile."
          ),
        },
      ]);
    });

    it("names the page's scripts for a slow answer to a tap, and a viewport it lacks", async () => {
      const html = page(
        '<script src="/js/app.js" defer></script><script src="https://widgets.example.net/chat.js" async></script>'
      ).replace(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        ""
      );

      const { mine } = await auditPage(html, () => record(SLOW));
      const inp = mine.find((f) => f.rule === "perf.field-inp-poor");

      expect(inp?.fix).toMatchObject([
        {
          in: "html",
          action: "add",
          at: "head",
          code: expect.stringContaining("width=device-width"),
        },
        {
          in: "asset",
          url: "https://www.example.com/js/app.js",
          at: "whole file",
          write: expect.stringContaining("scheduler.yield()"),
        },
        {
          in: "asset",
          url: "https://widgets.example.net/chat.js",
          write: expect.stringContaining("after the load event"),
        },
      ]);
    });

    it("sizes the images that lack a width or height", async () => {
      const html = page(
        '<img src="/a.png" alt="A"><img src="/b.png" alt="B" width="10" height="10">'
      );

      const { mine } = await auditPage(html, () => record(SLOW));
      const cls = mine.find((f) => f.rule === "perf.field-cls-poor");

      expect(cls?.fix).toMatchObject([
        {
          in: "html",
          action: "replace",
          current: '<img src="/a.png" alt="A">',
          code: '<img src="/a.png" alt="A" width="{{width}}" height="{{height}}">',
        },
      ]);
    });

    it("says where to look when the page shows no cause", async () => {
      const { mine } = await auditPage(page(), () =>
        record({ ...SLOW, ttfb: 300 })
      );

      const fixOf = (rule: string) => mine.find((f) => f.rule === rule)?.fix;

      expect(fixOf("perf.field-lcp-poor")).toMatchObject([
        {
          in: "html",
          at: "head",
          code: expect.stringContaining('rel="preload" as="image"'),
        },
      ]);
      expect(fixOf("perf.field-inp-poor")).toMatchObject([
        {
          in: "html",
          at: "script",
          write: expect.stringContaining("scheduler.yield()"),
        },
      ]);
      expect(fixOf("perf.field-cls-poor")).toMatchObject([
        { in: "html", at: "head", code: expect.stringContaining("min-height") },
      ]);
    });
  });

  describe("of a crawl", () => {
    const SITE = "https://shop.example.com";

    const site = (paths: string[]): Record<string, Route> => {
      const links = paths.map((p) => `<a href="${p}">Page ${p}</a>`).join(" ");

      return Object.fromEntries([
        [
          `${SITE}/robots.txt`,
          {
            headers: { "content-type": "text/plain" },
            body: "User-agent: *\nAllow: /\n",
          },
        ],
        ...paths.map((path) => [
          `${SITE}${path}`,
          {
            body: page(links).replace(
              "Blue widgets for every workshop | Acme",
              `Page ${path} of the fixture shop`
            ),
          },
        ]),
      ]);
    };

    it("asks for the first pages' URLs and, for the start page alone, its origin", async () => {
      serve(site(["/", "/a", "/b", "/c"]), (q) => {
        if (q.origin) {
          return slowLcp();
        }

        return q.url === `${SITE}/a`
          ? record({ ...GOOD, cls: 0.4 })
          : NOT_FOUND;
      });

      const audit = await auditSite(`${SITE}/`, {
        fieldData: { apiKey: KEY, maxPages: 3 },
        pageDetail: "full",
      });

      const sources = new Map(
        audit.pages.map((p) => [p.url, p.fieldData?.source])
      );

      const fired = new Map(
        audit.pages.map((p) => [p.url, rulesOf(fieldFindings(p.findings))])
      );

      // The start page, /a, and one of /b and /c: three URLs and the start page's origin.
      expect(queries.map((q) => (q.origin ? "origin" : "url"))).toStrictEqual([
        "url",
        "url",
        "url",
        "origin",
      ]);
      expect([sources.get(`${SITE}/`), sources.get(`${SITE}/a`)]).toStrictEqual(
        ["origin", "url"]
      );
      expect(
        [sources.get(`${SITE}/b`), sources.get(`${SITE}/c`)].toSorted()
      ).toStrictEqual([null, undefined]);
      expect([fired.get(`${SITE}/`), fired.get(`${SITE}/a`)]).toStrictEqual([
        ["perf.field-lcp-poor"],
        ["perf.field-cls-poor"],
      ]);
    });

    it("sends no more queries once the quota is used up for the minute", async () => {
      serve(site(["/", "/a", "/b", "/c", "/d", "/e", "/f"]), () => ({
        status: 429,
        body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } },
      }));

      const audit = await auditSite(`${SITE}/`, { fieldData: FIELD });

      // The four in flight when the first answer came, of seven pages and the origin.
      expect(queries.length).toBeLessThanOrEqual(4);
      expect(
        audit.pages.map((p) => p.fieldData).filter((f) => f?.source !== null)
      ).toStrictEqual([]);
    });

    it("lists each asked page's vitals in the reports", async () => {
      serve(site(["/", "/a"]), (q) =>
        q.url === `${SITE}/a` ? record({ ...GOOD, cls: 0.4 }) : NOT_FOUND
      );

      const audit = await auditSite(`${SITE}/`, { fieldData: FIELD });
      const markdown = renderMarkdown(audit);
      const text = renderText(audit, { width: 100 });
      expect(markdown).toContain("## Field data (Chrome UX Report, phones)");
      expect(markdown).toContain(
        `| ${SITE}/a | url | 1,800 ms (good) | 120 ms (good) | 0.40 (poor) |`
      );
      expect(markdown).toContain(`| ${SITE}/ | no record | — | — | — |`);
      expect(text).toContain("Field data (Chrome UX Report, phones) (2)");
      expect(tableUnder(text, "Field data")).toStrictEqual([
        ["LCP", "INP", "CLS", "Record", "Page"],
        ["–", "–", "–", "no record", "/"],
        ["1,800 ms", "120 ms", "0.40", "URL", "/a"],
      ]);
    });
  });

  describe("a re-check of field findings", () => {
    it("calls a finding fixed only on a page whose record it read again", async () => {
      serve({ [PAGE_URL]: { body: page() } }, slowLcp);
      const before = await auditUrl(PAGE_URL, { fieldData: FIELD });
      const baseline = baselineFromAudit(JSON.stringify(before));

      serve({ [PAGE_URL]: { body: page() } }, () => NOT_FOUND);
      const unread = await auditUrl(PAGE_URL, { fieldData: FIELD, baseline });

      serve({ [PAGE_URL]: { body: page() } }, () => record(GOOD));
      const faster = await auditUrl(PAGE_URL, { fieldData: FIELD, baseline });

      expect(rulesOf(fieldFindings(before.findings))).toStrictEqual([
        "perf.field-lcp-poor",
      ]);
      expect(unread.baseline?.fixed.map((f) => f.rule)).not.toContain(
        "perf.field-lcp-poor"
      );
      expect(faster.baseline?.fixed.map((f) => f.rule)).toContain(
        "perf.field-lcp-poor"
      );
    });
  });

  describe("in the reports", () => {
    it("shows the page's vitals", async () => {
      serve({ [PAGE_URL]: { body: page() } }, () =>
        record({ ...GOOD, inp: 650 })
      );

      const audit = await auditUrl(PAGE_URL, { fieldData: FIELD });
      const markdown = renderMarkdown(audit);
      const text = renderText(audit, { width: 100 });

      expect(markdown).toContain("## Field data (Chrome UX Report, phones)");
      expect(markdown).toContain("| INP | 650 ms | poor | 70% | 20% | 10% |");
      expect(markdown).toContain(
        "Real Chrome visits to this URL, 2026-10-13 to 2026-11-09"
      );
      expect(text).toContain("650 ms · poor · 70% of visits good");
    });

    it("says why a page has none", async () => {
      serve({ [PAGE_URL]: { body: page() } }, () => NOT_FOUND);
      const none = await auditUrl(PAGE_URL, { fieldData: FIELD });

      expect(renderMarkdown(none)).toContain(
        "The Chrome UX Report has no record for this URL or its origin"
      );
      expect(renderText(none, { width: 100 })).toContain(
        "too few Chrome visits"
      );
    });
  });
});
