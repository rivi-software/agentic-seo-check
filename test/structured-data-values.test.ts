import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import type {
  JsonObject,
  JsonValue,
} from "../src/core/html/structured-data.js";

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
