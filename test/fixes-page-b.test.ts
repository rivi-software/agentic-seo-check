import { describe, expect, it } from "vitest";

import { auditHtml, auditUrl } from "../src/core/audit.js";
import type { HtmlAuditInput } from "../src/core/audit.js";
import { extractPage } from "../src/core/html/extract.js";
import { ALL_RULES } from "../src/core/rules/index.js";
import type { Finding, ResponseInfo } from "../src/core/types.js";
import { incompleteEdits, unquotedEdits, withoutFix } from "./helpers/fixes.js";

const HOME = "https://www.example.com/";
const PAGE = "https://www.example.com/widgets/blue/";

const words = (n: number, word = "text"): string =>
  Array.from({ length: n }, () => word).join(" ");

const doc = (head: string, body: string, lang = "en") =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>Blue widgets for every workshop | Acme</title>${head}</head><body>${body}</body></html>`;

const response = (
  url: string,
  overrides: Partial<ResponseInfo> = {}
): ResponseInfo => ({
  status: 200,
  finalUrl: url,
  redirectChain: [],
  timeMs: 120,
  contentType: "text/html; charset=utf-8",
  headers: { "content-encoding": "gzip" },
  ...overrides,
});

interface Case {
  name: string;
  html: string;
  input: HtmlAuditInput;
  keyword?: string;
  /** A title other than the default, which names blue widgets. */
  retitle?: string;
}

const live = (url: string, overrides: Partial<ResponseInfo> = {}) => ({
  url,
  source: "url" as const,
  response: response(url, overrides),
});

const CASES: Case[] = [
  {
    name: "social tags with mistakes",
    html: doc(
      `<link rel="canonical" href="${PAGE}"><meta property="og:title" content="Blue widgets"><meta property="og:image" content="/img/share.png"><meta property="og:url" content="https://www.example.com/other/"><meta name="twitter:card" content="huge">`,
      `<h1>Blue widgets</h1><p>${words(320)}</p>`
    ),
    input: live(PAGE),
  },
  {
    name: "no social tags",
    html: doc(
      '<meta name="description" content="Blue widgets for workshops, garages and anyone who builds things with their hands.">',
      `<h1>Blue widgets</h1><p>${words(320)}</p>`
    ),
    input: live(PAGE),
  },
  {
    name: "loading: blocking script, lazy hero, large image",
    html: doc(
      '<script src="/app.js"></script>',
      `<h1>Blue widgets</h1><img src="/hero.jpg" width="1200" height="600" loading="lazy" alt="A blue widget"><p>${words(320)}</p>`
    ),
    input: live(PAGE, { headers: {} }),
  },
  {
    name: "loading: lazy and high priority at once",
    html: doc(
      "",
      `<h1>Blue widgets</h1><img src="/a.jpg" alt="A" loading="lazy" fetchpriority="high"><p>${words(320)}</p>`
    ),
    input: live(HOME),
  },
  {
    name: "structured data with mistakes",
    html: doc(
      `<script type="application/ld+json">{ "@type": "Product", "name": "X", }</script>
<script type="application/ld+json">{ "@type": "Product" "name": "X" }</script>
<script type="application/ld+json"></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","description":"A widget","image":"/img/a.png","offers":{"@type":"Offer","price":"€19,99","priceCurrency":"€"},"aggregateRating":{"@type":"AggregateRating","ratingValue":8,"reviewCount":"1,234"},"author":{"@id":"https://www.example.com/#me"}}</script>
<script type="application/ld+json">{"@type":"Article","headline":"Blue widgets","datePublished":"14/03/2026"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","name":"untyped"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":0,"name":"Widgets"}]}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q?","acceptedAnswer":{"@type":"Answer","text":"A."}}]}</script>`,
      `<h1>Blue widget X</h1><p>${words(320)}</p>`
    ),
    input: live(PAGE),
  },
  {
    name: "structured data Google reads but cannot use",
    html: doc(
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Blue widgets","isAccessibleForFree":false,"hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":"#paywall"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Red widgets","isAccessibleForFree":"False","hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".members-only"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Green widgets","isAccessibleForFree":false}</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "@id": "https://www.example.com/#business",
  "name": "Acme Widgets",
  "address": "1 Main Street, Springfield",
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": 4.8, "reviewCount": 120 },
  "review": [{ "@type": "Review", "author": { "@type": "Person", "name": "Ann" }, "reviewRating": { "@type": "Rating", "ratingValue": 5 } }]
}
</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"Widget fair","startDate":"2026-05-01","location":{"@type":"Place","name":"Hall","address":"Main Street"},"eventStatus":"cancelled","eventAttendanceMode":"https://schema.org/OfflineEventAttendanceMode","offers":{"@type":"Offer","price":"10.00","priceCurrency":"EUR","availability":"sold out"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Widget maker","employmentType":"Full-time"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Occupation","name":"Widget maker"}</script>`,
      `<h1>Blue widgets</h1><div class="paywall"><p>${words(320)}</p></div>`
    ),
    input: live(PAGE),
  },
  {
    name: "a home page with structured data but no WebSite item",
    html: doc(
      '<meta property="og:site_name" content="Acme"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://www.example.com/"}</script>',
      `<h1>Blue widgets</h1><p>${words(320)}</p>`
    ),
    input: live(HOME),
  },
  {
    name: "no structured data",
    html: doc("", `<h1>Blue widgets</h1><p>${words(320)}</p>`),
    input: live(PAGE),
  },
  {
    name: "URLs and links with mistakes",
    html: doc(
      "",
      `<h1>Blue widgets</h1><p>${words(320)}</p>
<a href="/about?utm_source=menu&utm_medium=web">About</a>
<a href="/cart?PHPSESSID=abcdef1234567890">Cart</a>
<a href="http://localhost:3000/dev">Dev server</a>
<a href="#nope">Jump</a>
<script src="http://cdn.example.com/a.js"></script>
<img src="http://cdn.example.com/b.png" alt="B">`
    ),
    input: live("https://www.example.com/Blue_Widgets/"),
  },
  {
    name: "a canonical on localhost",
    html: doc(
      '<link rel="canonical" href="http://localhost:3000/widgets/">',
      `<h1>Blue widgets</h1><p>${words(320)}</p>`
    ),
    input: live(PAGE),
  },
  {
    name: "a session id in the page URL",
    html: doc("", `<h1>Blue widgets</h1><p>${words(320)}</p>`),
    input: live("https://www.example.com/shop;jsessionid=ABCDEF123456"),
  },
  {
    name: "content: empty",
    html: doc("", "<div id=root></div>"),
    input: live(PAGE),
  },
  {
    name: "content: thin, placeholder",
    html: doc(
      "",
      "<h1>Blue widgets</h1><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>"
    ),
    input: live(PAGE),
  },
  {
    name: "content: hard to read",
    html: doc(
      "",
      `<h1>Blue widgets</h1><p>${Array.from(
        { length: 6 },
        () =>
          "Notwithstanding considerable organisational heterogeneity, institutional administrators systematically underestimate infrastructural interdependencies, consequently necessitating comprehensive multidimensional reconceptualisation of operational accountability frameworks across interconnected organisational hierarchies"
      ).join(". ")}.</p>`
    ),
    input: live(PAGE),
  },
  {
    name: "keyword missing everywhere",
    html: doc(
      '<meta name="description" content="Tools for workshops, garages and anyone who builds things with their hands.">',
      `<h1>Workshop tools</h1><p>${words(320)}</p>`
    ),
    input: live("https://www.example.com/tools/workshop/"),
    keyword: "blue widgets",
    retitle: "Workshop tools for every garage | Acme",
  },
  {
    name: "keyword stuffed",
    html: doc(
      "",
      `<h1>Blue widgets</h1><p>${Array.from({ length: 30 }, () => "Blue widgets are great").join(". ")}.</p>`
    ),
    input: live(PAGE),
    keyword: "blue widgets",
  },
  {
    name: "response: error status",
    html: doc("", `<h1>Not found</h1><p>${words(320)}</p>`),
    input: live(PAGE, { status: 404 }),
  },
  {
    name: "response: redirect chain, slow, plain http",
    html: doc("", `<h1>Blue widgets</h1><p>${words(320)}</p>`),
    input: live("http://shop.example.com/widgets/", {
      redirectChain: [
        { url: "http://shop.example.com/old", status: 302 },
        { url: "http://shop.example.com/widgets", status: 301 },
      ],
      timeMs: 4200,
    }),
  },
  {
    name: "response: one redirect, slow with cookies, not HTML",
    html: doc("", `<h1>Blue widgets</h1><p>${words(320)}</p>`),
    input: live(PAGE, {
      redirectChain: [
        { url: "https://www.example.com/widgets/blue", status: 301 },
      ],
      timeMs: 4200,
      contentType: "text/plain",
      headers: { "content-encoding": "gzip", "set-cookie": "s=1" },
    }),
  },
  {
    name: "response: read only in part",
    html: doc("", `<h1>Blue widgets</h1><p>${words(320)}</p>`),
    input: live(PAGE, { truncated: true }),
  },
];

/** Every finding of every case, with the case's HTML. */
const auditAll = () =>
  Promise.all(
    CASES.map(async (c) => {
      const html = c.retitle
        ? c.html.replace("Blue widgets for every workshop | Acme", c.retitle)
        : c.html;

      const audit = await auditHtml(html, c.input, { keyword: c.keyword });

      return { ...c, html, findings: audit.findings };
    })
  );

const MY_RULES = new Set(
  ALL_RULES.filter(
    (r) =>
      /^(?:og|twitter|structured-data|content|keyword|response)\./u.test(
        r.id
      ) ||
      [
        "loading.render-blocking-script",
        "loading.no-compression",
        "img.lazy-above-fold",
        "img.srcset-missing",
        "favicon.missing",
        "url.uppercase",
        "url.underscores",
        "url.session-id",
        "links.tracking-parameters",
        "links.local-host",
        "links.missing-fragment",
        "https.mixed-content",
      ].includes(r.id)
  ).map((r) => r.id)
);

/** The fix of the nth finding of `rule` across the cases. */
const fixOf = (all: { findings: Finding[] }[], rule: string, nth = 0) =>
  all.flatMap((c) => c.findings).filter((f) => f.rule === rule)[nth]?.fix;

/** Every edit of every finding of `rule` across the cases. */
const editsFor = (all: { findings: Finding[] }[], rule: string) =>
  all
    .flatMap((c) => c.findings)
    .filter((f) => f.rule === rule)
    .flatMap((f) => f.fix ?? []);

describe("fixes of the loading, response, social, structured data, URL, content and keyword rules", () => {
  it("every rule fires in a case and every finding has a complete fix", async () => {
    const all = await auditAll();
    const findings = all.flatMap((c) => c.findings);
    const fired = new Set(findings.map((f) => f.rule));

    // Response edits name the redirecting URL, which other pages link to, not this page's HTML.
    const unquoted = all.flatMap((c) =>
      unquotedEdits(
        c.findings.filter((f) => !f.rule.startsWith("response.")),
        c.html
      )
    );

    expect([...MY_RULES].filter((r) => !fired.has(r))).toStrictEqual([]);
    expect(withoutFix(findings)).toStrictEqual([]);
    expect(incompleteEdits(findings)).toStrictEqual([]);
    expect(unquoted).toStrictEqual([]);
  });

  it("writes social tags from what the page states", async () => {
    const all = await auditAll();

    expect({
      image: fixOf(all, "og.image-not-absolute"),
      url: fixOf(all, "og.url-mismatch")?.[0]?.code,
      // The first page has an og:image, so its card can be large.
      invalidCard: fixOf(all, "twitter.card-invalid")?.[0]?.code,
      missingCard: fixOf(all, "twitter.card-missing")?.[0]?.code,
      incomplete: fixOf(all, "og.incomplete")?.[0]?.code,
    }).toStrictEqual({
      image: [
        {
          in: "html",
          action: "replace",
          at: 'head > meta[property="og:image"]',
          current: '<meta property="og:image" content="/img/share.png">',
          code: '<meta property="og:image" content="https://www.example.com/img/share.png">',
        },
      ],
      url: `<meta property="og:url" content="${PAGE}">`,
      invalidCard: '<meta name="twitter:card" content="summary_large_image">',
      missingCard: '<meta name="twitter:card" content="summary">',
      incomplete:
        '<meta property="og:description" content="{{share description}}">\n<meta property="og:type" content="website">',
    });
    expect(fixOf(all, "og.missing")?.[0]).toMatchObject({
      in: "html",
      action: "add",
      at: "head",
      code: expect.stringContaining(
        '<meta property="og:description" content="Blue widgets for workshops, garages and anyone who builds things with their hands.">'
      ),
    });
  });

  it("repairs broken JSON-LD only where the repair is certain", async () => {
    const all = await auditAll();

    expect(
      [0, 1, 2].map((n) => fixOf(all, "structured-data.invalid-json", n))
    ).toStrictEqual([
      [
        {
          in: "html",
          action: "replace",
          at: 'script[type="application/ld+json"]',
          current: '{ "@type": "Product", "name": "X", }',
          code: '{ "@type": "Product", "name": "X" }',
        },
      ],
      [
        {
          in: "html",
          action: "replace",
          at: 'script[type="application/ld+json"]',
          current: '{ "@type": "Product" "name": "X" }',
          code: "{{the same data as valid JSON}}",
          write: expect.stringContaining("Invalid JSON"),
        },
      ],
      [
        {
          in: "html",
          action: "remove",
          at: 'script[type="application/ld+json"]',
          current: '<script type="application/ld+json"></script>',
        },
      ],
    ]);
  });

  it("writes structured data values in the form Google reads", async () => {
    const all = await auditAll();

    expect(editsFor(all, "structured-data.invalid-value")).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          current: '"price":"€19,99"',
          code: '"price": "19.99"',
        }),
        expect.objectContaining({
          current: '"priceCurrency":"€"',
          code: '"priceCurrency": "EUR"',
        }),
        expect.objectContaining({
          current: '"reviewCount":"1,234"',
          code: '"reviewCount": 1234',
        }),
        expect.objectContaining({ action: "add", code: '"bestRating": 10' }),
        expect.objectContaining({
          at: 'script[type="application/ld+json"] > ListItem at itemListElement[0]',
          current: '"position":0',
          code: '"position": 1',
        }),
        expect.objectContaining({
          current: '"eventStatus":"cancelled"',
          code: '"eventStatus": "https://schema.org/EventCancelled"',
        }),
        expect.objectContaining({
          current: '"availability":"sold out"',
          code: '"availability": "https://schema.org/SoldOut"',
        }),
        expect.objectContaining({
          current: '"employmentType":"Full-time"',
          code: '"employmentType": "FULL_TIME"',
        }),
      ])
    );
    expect({
      date: fixOf(all, "structured-data.invalid-date")?.[0],
      relative: fixOf(all, "structured-data.relative-url")?.[0],
      starter: fixOf(all, "structured-data.missing")?.[0]?.code,
    }).toMatchObject({
      date: {
        action: "replace",
        current: '"datePublished":"14/03/2026"',
        code: '"datePublished": "2026-03-14"',
      },
      relative: {
        current: '"/img/a.png"',
        code: '"https://www.example.com/img/a.png"',
      },

      starter: expect.stringContaining('"name": "Blue widgets"'),
    });

    // Answer engines read FAQPage, so nothing changes: the finding has no fix.
    const retired = all
      .flatMap((c) => c.findings)
      .find((f) => f.rule === "structured-data.retired-type");

    expect(retired?.rule).toBe("structured-data.retired-type");
    expect(retired).not.toHaveProperty("fix");
    expect(fixOf(all, "structured-data.missing-required")?.[0]).toMatchObject({
      action: "add",
      code: expect.stringContaining('"name": "Blue widget X"'),
    });
  });

  it("names the paywalled section, drops self-serving review markup and adds the site name", async () => {
    const all = await auditAll();

    const paywall = all
      .flatMap((c) => c.findings)
      .filter((f) => f.rule === "structured-data.paywall-invalid");

    expect(paywall.map((f) => [f.severity, f.fix?.[0]])).toStrictEqual([
      [
        "warning",
        {
          in: "html",
          action: "replace",
          at: 'script[type="application/ld+json"] > WebPageElement at hasPart',
          current: '"cssSelector":"#paywall"',
          code: '"cssSelector": ".{{class of the paywalled section, e.g. paywall}}"',
          write: expect.stringContaining("Google reads only a .class selector"),
        },
      ],
      [
        "warning",
        expect.objectContaining({
          action: "add",
          at: 'script[type="application/ld+json"] > BlogPosting',
          code: expect.stringContaining(
            '"hasPart": { "@type": "WebPageElement"'
          ),
        }),
      ],
      [
        "info",
        expect.objectContaining({
          action: "add",
          at: "body",
          code: '<div class="members-only">{{the paywalled part of the article, as it is now}}</div>',
        }),
      ],
    ]);

    expect(fixOf(all, "structured-data.self-serving-review")).toStrictEqual([
      expect.objectContaining({
        action: "remove",
        current:
          ',\n  "aggregateRating": { "@type": "AggregateRating", "ratingValue": 4.8, "reviewCount": 120 }',
      }),
      expect.objectContaining({
        action: "remove",
        current: expect.stringMatching(/^,\n {2}"review": \[/u),
      }),
    ]);

    expect(fixOf(all, "structured-data.site-name-missing")?.[0]?.code).toBe(
      '<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "WebSite",\n  "name": "Acme",\n  "url": "https://www.example.com/"\n}\n</script>'
    );
    expect(fixOf(all, "structured-data.missing-required")?.[0]).toMatchObject({
      action: "add",
      code: expect.stringContaining('"name": "Blue widget X"'),
    });
  });

  it("strips tracking and session parameters from links and moves dev URLs to production", async () => {
    const all = await auditAll();

    expect({
      tracking: fixOf(all, "links.tracking-parameters"),
      sessionLink: fixOf(all, "url.session-id", 0)?.[0],
      sessionPage: fixOf(all, "url.session-id", 1)?.[0],
      localCanonical: fixOf(all, "links.local-host", 1)?.[0],
    }).toMatchObject({
      tracking: [
        {
          in: "html",
          action: "replace",
          at: 'a[href="/about?utm_source=menu&utm_medium=web"]',
          current: '<a href="/about?utm_source=menu&utm_medium=web">',
          code: '<a href="/about">',
        },
      ],
      sessionLink: {
        current: '<a href="/cart?PHPSESSID=abcdef1234567890">',
        code: '<a href="/cart">',
      },
      sessionPage: {
        action: "add",
        at: "head",
        code: '<link rel="canonical" href="https://www.example.com/shop">',
      },
      localCanonical: {
        current: '<link rel="canonical" href="http://localhost:3000/widgets/">',
        code: '<link rel="canonical" href="{{https://www.example.com}}/widgets/">',
      },
    });
    expect(editsFor(all, "https.mixed-content")).toContainEqual(
      expect.objectContaining({
        current: "http://cdn.example.com/a.js",
        code: "https://cdn.example.com/a.js",
      })
    );
    // The page keeps its URL; the other spelling redirects to it.
    expect({
      uppercase: fixOf(all, "url.uppercase")?.[0],
      underscores: fixOf(all, "url.underscores")?.[0],
    }).toMatchObject({
      uppercase: {
        in: "http",
        url: "https://www.example.com/blue_widgets/",
        code: "HTTP/1.1 301 Moved Permanently\nLocation: https://www.example.com/Blue_Widgets/",
      },
      underscores: { url: "https://www.example.com/Blue-Widgets/" },
    });
  });

  it("rewrites image and script tags for loading", async () => {
    const all = await auditAll();

    expect({
      lazyHero: fixOf(all, "img.lazy-above-fold", 0)?.[0],
      lazyAndHigh: fixOf(all, "img.lazy-above-fold", 1)?.[0],
      blocking: fixOf(all, "loading.render-blocking-script")?.[0],
      compression: fixOf(all, "loading.no-compression")?.[0],
    }).toMatchObject({
      lazyHero: {
        current:
          '<img src="/hero.jpg" width="1200" height="600" loading="lazy" alt="A blue widget">',
        code: '<img src="/hero.jpg" width="1200" height="600" alt="A blue widget" fetchpriority="high">',
      },
      lazyAndHigh: { code: '<img src="/a.jpg" alt="A" fetchpriority="high">' },
      blocking: {
        action: "replace",
        at: 'head > script[src="/app.js"]',
        current: '<script src="/app.js">',
        code: '<script src="/app.js" defer>',
      },
      compression: { in: "http", code: "Content-Encoding: gzip" },
    });
    expect(fixOf(all, "img.srcset-missing")?.[0]?.code).toContain(
      '/hero.jpg 1200w" sizes="{{display width, e.g. 100vw}}"'
    );
  });

  it("gives response findings HTTP edits", async () => {
    const all = await auditAll();

    expect({
      error: fixOf(all, "response.error-status")?.[0],
      chain: fixOf(all, "response.redirect-chain")?.[0],
      https: fixOf(all, "response.not-https")?.[0]?.code,
      notHtml: fixOf(all, "response.not-html")?.[0],
      redirected: fixOf(all, "response.redirected")?.[0],
    }).toMatchObject({
      error: {
        in: "http",
        current: "HTTP/1.1 404 Not Found",
        code: "HTTP/1.1 200 OK",
      },
      chain: {
        in: "http",
        action: "replace",
        url: "http://shop.example.com/old",
        at: "status line and Location",
        current:
          "HTTP/1.1 302 Found\nLocation: http://shop.example.com/widgets",
        code: "HTTP/1.1 302 Found\nLocation: http://shop.example.com/widgets/",
      },
      https:
        "HTTP/1.1 301 Moved Permanently\nLocation: https://shop.example.com/widgets/",
      notHtml: {
        current: "Content-Type: text/plain",
        code: "Content-Type: text/html; charset=utf-8",
      },
      redirected: {
        current: "https://www.example.com/widgets/blue",
        code: PAGE,
      },
    });
    // A response that sets cookies must not be cached for everyone.
    expect(
      [0, 1].map((n) => fixOf(all, "response.slow", n)?.[0])
    ).toMatchObject([
      { action: "add", code: expect.stringContaining("Cache-Control: public") },
      { action: "replace", at: "time to first byte" },
    ]);
  });

  it("fixes a page that could not be fetched with the response it should give", async () => {
    const audit = await auditUrl("http://127.0.0.1:9/", {
      fetch: { timeoutMs: 2000 },
    });

    expect(audit.findings[0]?.fix?.[0]).toMatchObject({
      in: "http",
      action: "add",
      code: "HTTP/1.1 200 OK\nContent-Type: text/html; charset=utf-8",
    });
  });
});

describe("text fixes on long input", () => {
  it("reads the text blocks of a deeply nested page full of empty paragraphs quickly", () => {
    // Each empty <p> once walked all its ancestors: thousands of them under deep nesting took 43 s.
    // One walk takes about 2 s with parsing; the limit leaves room for a busy machine.
    const html = `<!doctype html><html lang="en"><body>${"<div>".repeat(3000)}${"<p></p>".repeat(100_000)}${"</div>".repeat(3000)}</body></html>`;
    const started = performance.now();
    const page = extractPage(html, { url: "https://www.example.com/" });

    expect(performance.now() - started).toBeLessThan(15_000);
    expect(page.markup.blocks).toStrictEqual([]);
  });

  it("read a long paragraph without a full stop once, not once from every word", async () => {
    // Before, finding sentences here retried from every position: 40 KB took seconds.
    const html = `<!doctype html><html lang="en"><head><title>Long</title></head><body><p>${"incomprehensibilities ".repeat(10_000)}</p><p>A short sentence that ends.</p></body></html>`;
    const started = performance.now();

    const audit = await auditHtml(
      html,
      { url: "https://www.example.com/long" },
      { onlyRules: ["content.readability-low", "content.placeholder-text"] }
    );

    expect(performance.now() - started).toBeLessThan(2000);
    expect(audit.findings.map((f) => f.rule)).toStrictEqual([
      "content.readability-low",
    ]);
  });
});

/** A pretty-printed breadcrumb trail with these positions, one crumb per name. */
const trail = (...positions: number[]) =>
  doc(
    `<script type="application/ld+json">${JSON.stringify(
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: positions.map((position, i) => ({
          "@type": "ListItem",
          position,
          name: `Crumb ${i}`,
          item: `https://www.example.com/${i}/`,
        })),
      },
      null,
      2
    )}</script>`,
    "<h1>Blue widgets</h1>"
  );

/** An Offer with `price` as written. */
const offer = (price: string) =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Offer","price":"${price}","priceCurrency":"EUR"}</script>`;

/** `html` with each replace edit applied in turn; throws when an edit's `current` is gone by then. */
const applyInTurn = (html: string, fix: Finding["fix"]): string => {
  let out = html;

  for (const edit of fix ?? []) {
    if (edit.action === "replace" && edit.current !== undefined) {
      if (!out.includes(edit.current)) {
        throw new Error(`Not in the page any more: ${edit.current}`);
      }

      out = out.replace(edit.current, () => edit.code ?? "");
    }
  }

  return out;
};

/** The findings of `rule` alone on `html`. */
const ruleOn = async (
  rule: string,
  html: string,
  input?: HtmlAuditInput
): Promise<Finding[]> => {
  const audit = await auditHtml(html, input ?? { url: PAGE }, {
    onlyRules: [rule],
  });

  return audit.findings;
};

describe("fixes applied one after another", () => {
  // Minified, past 500 characters: each comma is quoted from 30 characters before it.
  const minified = `{"@context":"https://schema.org","@type":"Product","name":"Blue widget","description":"${words(80, "blue")}","offers":{"@type":"Offer","price":"19.99","priceCurrency":"EUR",},"x":[1,2,],"sku":"A1"}`;

  // Pretty-printed: both commas are near the start of one line, so both quotes start there.
  const pretty = `{\n"@context":"https://schema.org","@type":"Product","name":"Blue widget",\n"a":[1,],"b":{"c":1,},\n"description":"${words(80, "blue")}"\n}`;

  it.each([
    ["minified", minified],
    ["pretty-printed", pretty],
  ])(
    "removes trailing commas whose quotes would overlap in one edit (%s)",
    async (_, json) => {
      const html = doc(
        `<script type="application/ld+json">${json}</script>`,
        "<h1>Blue widget</h1>"
      );

      const [found] = await ruleOn("structured-data.invalid-json", html);

      expect(json.length).toBeGreaterThan(500);
      expect(found?.fix).toHaveLength(1);

      await expect(
        ruleOn("structured-data.invalid-json", applyInTurn(html, found?.fix))
      ).resolves.toStrictEqual([]);
    }
  );

  it("asks for a price it cannot read for certain", async () => {
    // "1.299" is 1299 in much of Europe and 1.299 elsewhere; "1.299,-" is a whole number of euros.
    // A range or a price with its VAT rate holds two numbers, whose digits must not be joined.
    const prices = [
      "€1.299",
      "€ 1.299,-",
      "10 - 20",
      "€19,99 incl. 21% VAT",
      "€1.299,00",
    ];

    const findings = await ruleOn(
      "structured-data.invalid-value",
      doc(prices.map(offer).join(""), "")
    );

    expect(findings.map((f) => f.fix?.[0]?.code)).toStrictEqual([
      '"price": "{{price, e.g. 19.99}}"',
      '"price": "{{price, e.g. 19.99}}"',
      '"price": "{{price, e.g. 19.99}}"',
      '"price": "{{price, e.g. 19.99}}"',
      '"price": "1299.00"',
    ]);
  });

  it("writes out a relative URL under an http <base href> without doubling its query", async () => {
    const html = doc(
      '<base href="http://cdn.example.com/">',
      '<h1>Blue widgets</h1><img src="/img.php?w=1&amp;h=2" alt="A widget">'
    );

    const [found] = await ruleOn("https.mixed-content", html, live(PAGE));
    const fixed = applyInTurn(html, found?.fix);

    expect(fixed).toContain(
      '<img src="https://cdn.example.com/img.php?w=1&amp;h=2" alt="A widget">'
    );
  });

  it.each([
    ["0, 1, 2", [0, 1, 2]],
    ["3, 4, 5", [3, 4, 5]],
  ])(
    "renumbers a pretty-printed breadcrumb trail numbered %s, each quote unique when it is applied",
    async (_, positions) => {
      const html = trail(...positions);
      const [found] = await ruleOn("structured-data.invalid-value", html);
      let fixed = html;

      expect(found?.fix).toHaveLength(3);

      for (const edit of found?.fix ?? []) {
        expect(edit.action).toBe("replace");
        expect(fixed.split(edit.current ?? "").length - 1).toBe(1);
        fixed = fixed.replace(edit.current ?? "", () => edit.code ?? "");
      }

      await expect(
        ruleOn("structured-data.invalid-value", fixed)
      ).resolves.toStrictEqual([]);
    }
  );

  it.each([
    // 2 → 1 and 1 → 2: whichever edit goes first writes the value the other still quotes.
    ["go round", [2, 1, 5], 3],
    // "position": 1 is also the start of "position": 10.
    ["are not unique as text", [10, 1], 2],
  ])(
    "names each crumb instead of quoting positions that %s",
    async (_, positions, count) => {
      const [found] = await ruleOn(
        "structured-data.invalid-value",
        trail(...positions)
      );

      expect(found?.fix).toHaveLength(count);
      expect(found?.fix?.[0]).toStrictEqual({
        in: "html",
        action: "add",
        at: 'script[type="application/ld+json"] > ListItem at itemListElement[0]',
        code: '"position": 1',
        write: 'This replaces the "position" the object has.',
      });
      expect(found?.fix?.map((e) => e.action)).toStrictEqual(
        Array.from({ length: count }, () => "add")
      );
    }
  );
});
