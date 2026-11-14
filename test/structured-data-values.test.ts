import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import { extractPage } from "../src/core/html/extract.js";
import type {
  JsonObject,
  JsonValue,
} from "../src/core/html/structured-data.js";
import type { Finding } from "../src/core/types.js";

const good = readFileSync(
  new URL("fixtures/good-page.html", import.meta.url),
  "utf-8"
);

const URL_ = "https://www.example.com/widgets/blue/";

const withJsonLd = (...items: JsonValue[]) =>
  `<!DOCTYPE html><html lang="en"><head><title>Blue widgets for home workshops</title>${items
    .map(
      (item) =>
        `<script type="application/ld+json">${JSON.stringify(item)}</script>`
    )
    .join("")}</head><body><h1>Blue widgets</h1></body></html>`;

const findingsOf = async (rule: string, html: string) => {
  const result = await auditHtml(html, { url: URL_, source: "url" });

  return result.findings.filter((f) => f.rule === rule);
};

const NEW_RULES = new Set([
  "structured-data.retired-type",
  "structured-data.invalid-value",
  "structured-data.relative-url",
  "structured-data.dangling-id",
]);

const CONTEXT = "https://schema.org";

const product = (offers: JsonObject, extra: JsonObject = {}): JsonObject => ({
  "@context": CONTEXT,
  "@type": "Product",
  name: "Blue widget",
  image: "https://www.example.com/img/blue.jpg",
  offers: {
    "@type": "Offer",
    availability: "https://schema.org/InStock",
    ...offers,
  },
  ...extra,
});

const rating = (r: JsonObject) =>
  withJsonLd(
    product(
      { price: "19.99", priceCurrency: "EUR" },
      { aggregateRating: { "@type": "AggregateRating", ...r } }
    )
  );

const crumbs = (...items: JsonObject[]) =>
  withJsonLd({
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((i) => ({ "@type": "ListItem", ...i })),
  });

describe("structured data values", () => {
  it("stay quiet on the good page", async () => {
    const result = await auditHtml(good, { url: URL_, source: "url" });

    expect(
      result.findings.map((f) => f.rule).filter((r) => NEW_RULES.has(r))
    ).toStrictEqual([]);
  });

  it("structured-data.retired-type names FAQPage, HowTo and SearchAction, and stops asking for their properties", async () => {
    const result = await auditHtml(
      withJsonLd(
        { "@context": CONTEXT, "@type": "FAQPage" },
        { "@context": CONTEXT, "@type": "HowTo", name: "Mount a widget" },
        {
          "@context": CONTEXT,
          "@type": "WebSite",
          name: "Widget Co",
          url: "https://www.example.com/",
          potentialAction: {
            "@type": "SearchAction",
            target: "https://www.example.com/search?q={q}",
            "query-input": "required name=q",
          },
        }
      ),
      { url: URL_, source: "url" }
    );

    const retired = result.findings.filter(
      (f) => f.rule === "structured-data.retired-type"
    );

    expect(retired.map((f) => f.evidence?.["type"])).toStrictEqual([
      "FAQPage",
      "HowTo",
      "SearchAction",
    ]);

    expect(
      result.findings.filter(
        (f) => f.rule === "structured-data.missing-required"
      )
    ).toStrictEqual([]);
  });

  it("still checks live types co-typed with or nested in a retired one", async () => {
    const result = await auditHtml(
      withJsonLd(
        {
          "@context": CONTEXT,
          "@type": ["WebPage", "FAQPage"],
          name: "Widget FAQ",
          breadcrumb: { "@type": "BreadcrumbList" },
          mainEntity: [{ "@type": "Question", name: "Which widget?" }],
        },
        {
          "@context": CONTEXT,
          "@type": "HowTo",
          name: "Mount a widget",
          video: { "@type": "VideoObject", name: "Mounting" },
          step: [{ "@type": "HowToStep" }],
        }
      ),
      { url: URL_, source: "url" }
    );

    const missing = result.findings
      .filter((f) => f.rule === "structured-data.missing-required")
      .map((f) => f.evidence?.["type"]);

    expect(missing).toStrictEqual(["BreadcrumbList", "VideoObject"]);
  });

  it("a review nested in a recipe needs no itemReviewed", async () => {
    const review = {
      "@type": "Review",
      author: { "@type": "Person", name: "Ann" },
      reviewRating: { "@type": "Rating", ratingValue: 5 },
    };

    await expect(
      findingsOf(
        "structured-data.missing-required",
        withJsonLd({
          "@context": CONTEXT,
          "@type": "Recipe",
          name: "Cookies",
          image: "https://www.example.com/img/cookies.jpg",
          review: [review],
        })
      )
    ).resolves.toStrictEqual([]);

    const [standalone] = await findingsOf(
      "structured-data.missing-required",
      withJsonLd({ "@context": CONTEXT, ...review })
    );

    expect(standalone?.evidence).toMatchObject({ missing: ["itemReviewed"] });
  });

  it("a Q&A page question may have only suggested answers", async () => {
    await expect(
      findingsOf(
        "structured-data.missing-required",
        withJsonLd({
          "@context": CONTEXT,
          "@type": "QAPage",
          mainEntity: {
            "@type": "Question",
            name: "Which widget fits a small bench?",
            answerCount: 1,
            suggestedAnswer: { "@type": "Answer", text: "The small one." },
          },
        })
      )
    ).resolves.toStrictEqual([]);
  });

  it("structured-data.invalid-value checks prices and currencies", async () => {
    const [comma] = await findingsOf(
      "structured-data.invalid-value",
      withJsonLd(product({ price: "19,99", priceCurrency: "EUR" }))
    );

    expect(comma?.evidence).toMatchObject({
      type: "Offer",
      path: "offers",
      problems: [
        'price "19,99" uses a comma for decimals; write it with a dot',
      ],
    });

    const [symbol] = await findingsOf(
      "structured-data.invalid-value",
      withJsonLd(product({ price: "€19.99", priceCurrency: "€" }))
    );

    expect(symbol?.evidence?.["problems"]).toHaveLength(2);

    await expect(
      findingsOf(
        "structured-data.invalid-value",
        withJsonLd(product({ price: 19.99, priceCurrency: "usd" }))
      )
    ).resolves.toStrictEqual([]);
  });

  it("structured-data.invalid-value checks rating scales and counts", async () => {
    const [outOfFive] = await findingsOf(
      "structured-data.invalid-value",
      rating({ ratingValue: 8.7, reviewCount: "12 reviews" })
    );

    expect(outOfFive?.evidence?.["problems"]).toStrictEqual([
      "ratingValue 8.7 is outside 1-5 (bestRating defaults to 5; set it when the scale is 10 or 100)",
      'reviewCount "12 reviews" is not a whole number',
    ]);

    const quiet = await Promise.all([
      findingsOf(
        "structured-data.invalid-value",
        rating({ ratingValue: "8.7", bestRating: "10", ratingCount: 31 })
      ),
      findingsOf(
        "structured-data.invalid-value",
        rating({ ratingValue: "60%", ratingCount: 31 })
      ),
    ]);

    expect(quiet.flat()).toStrictEqual([]);
  });

  it("structured-data.invalid-value checks breadcrumb trails", async () => {
    const [f] = await findingsOf(
      "structured-data.invalid-value",
      crumbs(
        { position: 0, name: "Home" },
        {
          position: 1,
          name: "Widgets",
          item: "https://www.example.com/widgets/",
        }
      )
    );

    expect(f?.evidence?.["problems"]).toStrictEqual([
      "positions are 0, 1; number them 1, 2, 3 from the start of the trail",
      "1 ListItem(s) before the last have no item (the URL of that crumb)",
    ]);

    const [single] = await findingsOf(
      "structured-data.invalid-value",
      crumbs({ position: 1, name: "Home", item: "https://www.example.com/" })
    );

    expect(single?.evidence?.["problems"]).toStrictEqual([
      "Google needs at least two ListItems in a breadcrumb trail",
    ]);

    const home = await auditHtml(
      crumbs({ position: 1, name: "Home", item: "https://www.example.com/" }),
      { url: "https://www.example.com/", source: "url" }
    );

    expect(home.findings.map((x) => x.rule)).not.toContain(
      "structured-data.invalid-value"
    );

    await expect(
      findingsOf(
        "structured-data.invalid-value",
        crumbs(
          { position: 1, name: "Home", item: "https://www.example.com/" },
          {
            position: 2,
            name: "Widgets",
            item: "https://www.example.com/widgets/",
          },
          { position: 3, name: "Blue" }
        )
      )
    ).resolves.toStrictEqual([]);
  });

  it("structured-data.relative-url flags paths, not absolute URLs or fragments", async () => {
    const [f] = await findingsOf(
      "structured-data.relative-url",
      withJsonLd({
        "@context": CONTEXT,
        "@type": "Organization",
        "@id": "#org",
        name: "Widget Co",
        url: "https://www.example.com/",
        logo: "logo.png",
        image: ["/img/team.jpg", "https://www.example.com/img/shop.jpg"],
        sameAs: ["https://www.linkedin.com/company/widget-co"],
      })
    );

    expect(f?.evidence).toStrictEqual({
      count: 2,
      examples: ["image: /img/team.jpg", "logo: logo.png"],
    });
  });

  it("structured-data.dangling-id still runs when only strings sit past the depth limit", async () => {
    let deep: JsonObject = { "@type": "PropertyValue", value: "leaf" };

    // Eight nested objects reach depth 8; only the string "leaf" sits at depth 9.
    for (let i = 0; i < 7; i += 1) {
      deep = { "@type": "PropertyValue", value: deep };
    }

    const [f] = await findingsOf(
      "structured-data.dangling-id",
      withJsonLd({
        "@context": CONTEXT,
        "@type": "Article",
        headline: "Blue widgets",
        author: { "@id": "https://www.example.com/#missing-person" },
        additionalProperty: deep,
      })
    );

    expect(f?.evidence).toStrictEqual({
      references: [
        { id: "https://www.example.com/#missing-person", path: "author" },
      ],
    });
  });

  it("structured-data.dangling-id resolves ids against the page and across @graph", async () => {
    const [f] = await findingsOf(
      "structured-data.dangling-id",
      withJsonLd(
        {
          "@context": CONTEXT,
          "@type": "Article",
          headline: "Blue widgets",
          author: { "@id": "https://www.example.com/#/schema/person/1" },
          publisher: { "@id": "#org" },
          about: { "@id": "https://www.wikidata.org/wiki/Q1234" },
          mainEntityOfPage: { "@id": URL_ },
        },
        {
          "@context": CONTEXT,
          "@type": "Organization",
          "@id": "https://www.example.com/widgets/blue/#org",
          name: "Widget Co",
        }
      )
    );

    expect(f?.evidence).toStrictEqual({
      references: [
        { id: "https://www.example.com/#/schema/person/1", path: "author" },
      ],
    });

    await expect(
      findingsOf(
        "structured-data.dangling-id",
        withJsonLd({
          "@context": CONTEXT,
          "@graph": [
            {
              "@type": "Article",
              headline: "Blue widgets",
              author: { "@id": "https://www.example.com/#person" },
            },
            {
              "@type": "Person",
              "@id": "https://www.example.com/#person",
              name: "Ann",
            },
          ],
        })
      )
    ).resolves.toStrictEqual([]);
  });
});

const aeoGood = readFileSync(
  new URL("fixtures/aeo-good-page.html", import.meta.url),
  "utf-8"
);

const HOME = "https://www.example.com/";

const EARNS_NOTHING = new Set([
  "structured-data.paywall-invalid",
  "structured-data.self-serving-review",
  "structured-data.site-name-missing",
]);

/** The findings of `rule` alone on `html` at `url`. */
const ruleAt = async (rule: string, html: string, url = URL_) => {
  const audit = await auditHtml(
    html,
    { url, source: "url" },
    { onlyRules: [rule] }
  );

  return audit.findings;
};

/** `html` with each edit of `fix` that quotes it applied: replaced or removed. */
const applied = (html: string, fix: Finding["fix"]): string => {
  let out = html;

  for (const edit of fix ?? []) {
    if (edit.current !== undefined && out.includes(edit.current)) {
      out = out.replace(edit.current, () =>
        edit.action === "remove" ? "" : (edit.code ?? "")
      );
    }
  }

  return out;
};

const article = (extra: JsonObject): JsonObject => ({
  "@context": CONTEXT,
  "@type": "NewsArticle",
  headline: "Blue widgets",
  ...extra,
});

const section = (cssSelector: JsonValue, free: JsonValue = false) => ({
  "@type": "WebPageElement",
  isAccessibleForFree: free,
  cssSelector,
});

const withBody = (body: string, ...items: JsonValue[]) =>
  withJsonLd(...items).replace(
    "<body><h1>Blue widgets</h1></body>",
    `<body><h1>Blue widgets</h1>${body}</body>`
  );

describe("structured data Google reads but cannot use", () => {
  it.each([
    ["good-page.html", good, URL_],
    ["good-page.html as a home page", good, HOME],
    [
      "aeo-good-page.html",
      aeoGood,
      "https://www.example.com/guides/choose-a-widget/",
    ],
  ])("stay quiet on %s", async (_, html, url) => {
    const result = await auditHtml(html, { url, source: "url" });

    expect(
      result.findings
        .map((f) => f.rule)
        .filter(
          (r) => EARNS_NOTHING.has(r) || r === "structured-data.invalid-value"
        )
    ).toStrictEqual(
      url === HOME && !html.includes('"WebSite"')
        ? ["structured-data.site-name-missing"]
        : []
    );
  });

  it("structured-data.paywall-invalid wants a .class section that the HTML has", async () => {
    const html = withBody(
      '<div class="paywall"><p>Members read on.</p></div>',
      article({
        isAccessibleForFree: false,
        hasPart: [section("div.paywall"), section(".gone")],
      }),
      article({ "@type": "Article", isAccessibleForFree: "False" })
    );

    const findings = await ruleAt("structured-data.paywall-invalid", html);

    expect(
      findings.map((f) => [f.severity, f.evidence?.["problems"]])
    ).toStrictEqual([
      [
        "warning",
        [
          'cssSelector "div.paywall" is not a .class selector, the only kind Google reads',
          "no element in the HTML has the class .gone, so Google cannot find the paywalled section",
        ],
      ],
      [
        "warning",
        [
          "isAccessibleForFree is false, but hasPart names no paywalled section (a WebPageElement with isAccessibleForFree false and a cssSelector)",
        ],
      ],
    ]);

    // div.paywall becomes .paywall, which the page has; .gone is still missing, and only info.
    const after = await ruleAt(
      "structured-data.paywall-invalid",
      applied(html, findings[0]?.fix)
    );

    const first = after.find((f) => f.evidence?.["type"] === "NewsArticle");

    expect([first?.severity, first?.evidence?.["problems"]]).toStrictEqual([
      "info",
      [
        "no element in the HTML has the class .gone, so Google cannot find the paywalled section",
      ],
    ]);
  });

  it("structured-data.paywall-invalid stays quiet on free entry, paid courses, references and valid markup", async () => {
    const quiet = await Promise.all(
      [
        withBody(
          '<section class="paywall">More</section>',
          article({
            isAccessibleForFree: false,
            hasPart: section([".paywall"]),
          })
        ),
        withJsonLd({
          "@context": CONTEXT,
          "@type": "Event",
          name: "Widget fair",
          isAccessibleForFree: false,
        }),
        withJsonLd({
          "@context": CONTEXT,
          "@type": "Course",
          name: "Widget making",
          isAccessibleForFree: false,
        }),
        withJsonLd(
          article({
            isAccessibleForFree: false,
            hasPart: { "@id": "https://www.example.com/widgets/blue/#paywall" },
          })
        ),
        withJsonLd(article({ isAccessibleForFree: true })),
      ].map((html) => ruleAt("structured-data.paywall-invalid", html))
    );

    expect(quiet.flat()).toStrictEqual([]);
  });
});

const business = (extra: JsonObject): JsonObject => ({
  "@context": CONTEXT,
  "@type": "Dentist",
  name: "Bright Smiles",
  address: "1 Main Street, Springfield",
  aggregateRating: {
    "@type": "AggregateRating",
    ratingValue: 4.8,
    reviewCount: 120,
  },
  ...extra,
});

describe("structured-data.self-serving-review", () => {
  it("fires on an organization's own home page, by url or by @id", async () => {
    const byUrl = await ruleAt(
      "structured-data.self-serving-review",
      withJsonLd(business({ url: "https://example.com/" })),
      "https://www.example.com/about/"
    );

    const byId = await ruleAt(
      "structured-data.self-serving-review",
      withJsonLd(business({ "@id": "https://www.example.com/#dentist" })),
      "https://www.example.com/contact/"
    );

    const unnamedOnHome = await ruleAt(
      "structured-data.self-serving-review",
      withJsonLd(business({})),
      HOME
    );

    expect(
      [...byUrl, ...byId, ...unnamedOnHome].map(
        (f) => f.evidence?.["properties"]
      )
    ).toStrictEqual([
      ["aggregateRating"],
      ["aggregateRating"],
      ["aggregateRating"],
    ]);
  });

  it("stays quiet on a review site's page about another business, and on products", async () => {
    const quiet = await Promise.all([
      // A review site's page about a dentist: the dentist's url is the dentist's own site.
      ruleAt(
        "structured-data.self-serving-review",
        withJsonLd(business({ url: "https://www.brightsmiles.example/" })),
        "https://www.reviews.example/dentists/bright-smiles/"
      ),
      // No url, on a page that is not the home page: whose it is cannot be told.
      ruleAt(
        "structured-data.self-serving-review",
        withJsonLd(business({})),
        "https://www.reviews.example/dentists/bright-smiles/"
      ),
      // An organization's other page, not its home page.
      ruleAt(
        "structured-data.self-serving-review",
        withJsonLd(business({ url: "https://www.example.com/team/" })),
        "https://www.example.com/team/"
      ),
      ruleAt(
        "structured-data.self-serving-review",
        withJsonLd(
          product(
            { price: "19.99", priceCurrency: "EUR" },
            {
              url: HOME,
              aggregateRating: {
                "@type": "AggregateRating",
                ratingValue: 4.5,
                reviewCount: 9,
              },
            }
          )
        ),
        HOME
      ),
    ]);

    expect(quiet.flat()).toStrictEqual([]);
  });

  it("removes the review markup with its comma, leaving JSON that parses", async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>Bright Smiles dental care</title><script type="application/ld+json">${JSON.stringify(
      business({
        url: HOME,
        review: [
          { "@type": "Review", reviewBody: 'Great {care}, "best" in town' },
        ],
      }),
      null,
      2
    )}</script></head><body><h1>Bright Smiles</h1></body></html>`;

    const [found] = await ruleAt(
      "structured-data.self-serving-review",
      html,
      HOME
    );

    const fixed = applied(html, found?.fix);

    // The extractor reads the script, so the test needs no regular expression over HTML.
    const script =
      extractPage(fixed, { url: HOME }).structuredData[0]?.scriptText ?? "";

    expect(found?.fix?.map((e) => e.action)).toStrictEqual([
      "remove",
      "remove",
    ]);
    expect(Object.keys(JSON.parse(script))).toStrictEqual([
      "@context",
      "@type",
      "name",
      "address",
      "url",
    ]);
    await expect(
      ruleAt("structured-data.self-serving-review", fixed, HOME)
    ).resolves.toStrictEqual([]);
  });
});

describe("structured-data.site-name-missing", () => {
  const organization = {
    "@context": CONTEXT,
    "@type": "Organization",
    name: "Widget Co",
    url: HOME,
  };

  it("fires on a home page with structured data but no WebSite item", async () => {
    const [found] = await ruleAt(
      "structured-data.site-name-missing",
      withJsonLd(organization),
      HOME
    );

    expect(found?.fix?.[0]).toMatchObject({
      action: "add",
      at: "head",
      code: expect.stringContaining('"name": "{{site name}}"'),
    });
  });

  it("stays quiet with a WebSite item, without structured data, off the home page and on bare HTML", async () => {
    const quiet = await Promise.all([
      ruleAt(
        "structured-data.site-name-missing",
        withJsonLd(organization, {
          "@context": CONTEXT,
          "@type": "WebSite",
          name: "Widget Co",
          url: HOME,
        }),
        HOME
      ),
      // structured-data.missing adds the WebSite item there.
      ruleAt("structured-data.site-name-missing", withJsonLd(), HOME),
      ruleAt("structured-data.site-name-missing", withJsonLd(organization)),
      auditHtml(
        withJsonLd(organization),
        { url: HOME, source: "html" },
        { onlyRules: ["structured-data.site-name-missing"] }
      ).then((a) => a.findings),
    ]);

    expect(quiet.flat()).toStrictEqual([]);
  });
});

const offer = (availability: JsonValue, itemCondition?: JsonValue) => {
  const offers: JsonObject = {
    price: "19.99",
    priceCurrency: "EUR",
    availability,
  };

  if (itemCondition !== undefined) {
    offers["itemCondition"] = itemCondition;
  }

  return withJsonLd(product(offers));
};

const job = (employmentType: JsonValue) =>
  withJsonLd({
    "@context": CONTEXT,
    "@type": "JobPosting",
    title: "Widget maker",
    employmentType,
  });

const event = (extra: JsonObject) =>
  withJsonLd({
    "@context": CONTEXT,
    "@type": "Event",
    name: "Widget fair",
    ...extra,
  });

describe("structured-data.invalid-value enumerations", () => {
  it("accepts every form of a schema.org value, and employmentType as Google writes it", async () => {
    const quiet = await Promise.all(
      [
        offer("https://schema.org/InStock", "https://schema.org/NewCondition"),
        offer("http://schema.org/OutOfStock", "schema:UsedCondition"),
        offer("schema:PreOrder", "DamagedCondition"),
        offer("instock", "refurbishedcondition"),
        offer({ "@id": "https://schema.org/SoldOut" }),
        job(["FULL_TIME", "PART_TIME"]),
        job("PER_DIEM"),
        event({
          eventStatus: "https://schema.org/EventMovedOnline",
          eventAttendanceMode: "MixedEventAttendanceMode",
        }),
      ].map((html) => ruleAt("structured-data.invalid-value", html))
    );

    expect(quiet.flat()).toStrictEqual([]);
  });

  it("writes the value a free-text one plainly means, and a slot for the rest", async () => {
    const codes = await Promise.all(
      [
        offer("in stock", "Used"),
        job(["Full-time", "contract", "seasonal"]),
        job("full_time"),
        event({ eventStatus: "canceled", eventAttendanceMode: "online" }),
      ].map(async (html) => {
        const findings = await ruleAt("structured-data.invalid-value", html);

        return findings.flatMap((f) => (f.fix ?? []).map((e) => e.code));
      })
    );

    expect(codes).toStrictEqual([
      [
        '"availability": "https://schema.org/InStock"',
        '"itemCondition": "https://schema.org/UsedCondition"',
      ],
      [
        '"employmentType": ["FULL_TIME", "CONTRACTOR", "{{one of FULL_TIME, PART_TIME, CONTRACTOR, TEMPORARY, INTERN, VOLUNTEER, PER_DIEM, OTHER}}"]',
      ],
      ['"employmentType": "FULL_TIME"'],
      [
        '"eventStatus": "https://schema.org/EventCancelled"',
        '"eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode"',
      ],
    ]);
  });

  it("is quiet once its fix is applied", async () => {
    const html = offer("Out of stock", "new");
    const [found] = await ruleAt("structured-data.invalid-value", html);

    expect(found?.evidence?.["problems"]).toHaveLength(2);
    await expect(
      ruleAt("structured-data.invalid-value", applied(html, found?.fix))
    ).resolves.toStrictEqual([]);
  });
});

describe("structured-data.retired-type, 2025", () => {
  it("names Estimated Salary, Learning Video and Book Actions markup, and asks for none of their properties", async () => {
    const result = await auditHtml(
      withJsonLd(
        {
          "@context": CONTEXT,
          "@type": "OccupationAggregationByEmployer",
          name: "Widget maker",
        },
        {
          "@context": CONTEXT,
          "@type": ["VideoObject", "LearningResource"],
          name: "Mounting a widget",
          thumbnailUrl: "https://www.example.com/img/mount.jpg",
          uploadDate: "2026-01-05",
        },
        {
          "@context": CONTEXT,
          "@type": "Book",
          name: "Widgets",
          workExample: {
            "@type": "Book",
            potentialAction: [
              { "@type": "ReadAction" },
              { "@type": "BorrowAction" },
            ],
          },
        }
      ),
      { url: URL_, source: "url" }
    );

    const retired = result.findings.filter(
      (f) => f.rule === "structured-data.retired-type"
    );

    expect(retired.map((f) => f.evidence)).toStrictEqual([
      { type: "OccupationAggregationByEmployer", count: 1 },
      { type: "LearningResource", count: 1 },
      { type: "ReadAction", count: 1 },
      { type: "BorrowAction", count: 1 },
    ]);
    expect(retired[1]?.message).toContain("VideoObject itself still earns");
    expect(
      result.findings.filter(
        (f) => f.rule === "structured-data.missing-required"
      )
    ).toStrictEqual([]);
  });

  it("leaves a math solver's LearningResource, a VideoObject and a ReadAction outside a Book alone", async () => {
    await expect(
      ruleAt(
        "structured-data.retired-type",
        withJsonLd(
          {
            "@context": CONTEXT,
            "@type": ["MathSolver", "LearningResource"],
            name: "Widget maths",
          },
          {
            "@context": CONTEXT,
            "@type": "VideoObject",
            name: "Mounting a widget",
          },
          {
            "@context": CONTEXT,
            "@type": "WebSite",
            name: "Widget Co",
            potentialAction: { "@type": "ReadAction" },
          }
        )
      )
    ).resolves.toStrictEqual([]);
  });
});
