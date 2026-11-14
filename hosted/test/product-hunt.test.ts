import { describe, expect, it } from "vitest";

import {
  PRODUCT_HUNT_BADGE_URL,
  PRODUCT_HUNT_URL,
  productHuntBadge,
  productHuntUpvotes,
  upvotesIn,
} from "../src/ui/product-hunt.ts";
import type { UpvoteCache } from "../src/ui/product-hunt.ts";

const SITE = "https://agentic-seo.org";

/** Where a location keeps the count. */
const KEPT = `${SITE}/product-hunt/upvotes`;

/** Product Hunt's badge as it draws it, cut to its words and the upvotes `count`. */
const phBadge = (count: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<svg width="250" height="54" viewBox="0 0 250 54" version="1.1" xmlns="http://www.w3.org/2000/svg">
  <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
    <text font-family="Helvetica-Bold, Helvetica" font-size="9" font-weight="bold" fill="#EEF2FF">
      <tspan x="53" y="20">FIND US ON</tspan>
    </text>
    <text font-family="Helvetica-Bold, Helvetica" font-size="21" font-weight="bold" fill="#EEF2FF">
      <tspan x="52" y="40">Product Hunt</tspan>
    </text>
    <g transform="translate(201.000000, 13.000000)" fill="#EEF2FF">
      <g>
        <polygon points="26.0024997 10 15 10 20.5012498 0"></polygon>
        <text font-family="Helvetica-Bold, Helvetica" font-size="13" font-weight="bold" line-spacing="20">
          <tspan x="15.7" y="27">${count}</tspan>
        </text>
      </g>
    </g>
  </g>
</svg>
`;

const svgAnswer = (
  body = phBadge("12"),
  headers: Record<string, string> = {}
) =>
  new Response(body, {
    headers: { "content-type": "image/svg+xml", ...headers },
  });

/** A Cache API of one location, kept in a map, and Product Hunt answering with `answers` in turn. */
const setup = (...answers: (Response | Error)[]) => {
  const kept = new Map<string, Response>();
  const asked: string[] = [];
  const later: Promise<unknown>[] = [];

  const cache: UpvoteCache = {
    match: async (request) => {
      await Promise.resolve();

      return kept.get(request.url)?.clone();
    },
    put: async (request, response) => {
      await Promise.resolve();
      kept.set(request.url, response);
    },
  };

  const fetcher = async (url: string): Promise<Response> => {
    await Promise.resolve();
    asked.push(url);
    const next = answers.shift() ?? new Error("no more answers");

    if (next instanceof Error) {
      throw next;
    }

    return next;
  };

  const upvotes = async (path = "/") => {
    const count = await productHuntUpvotes(
      new Request(`${SITE}${path}`),
      { waitUntil: (promise) => later.push(promise) },
      { cache, fetch: fetcher }
    );

    await Promise.all(later);

    return count;
  };

  return { asked, kept, upvotes };
};

describe("the Product Hunt badge", () => {
  it("reads the upvotes from Product Hunt's badge once, and then from the location's cache", async () => {
    const { asked, kept, upvotes } = setup(svgAnswer());

    // The homepage and the audit form's answer share the location's count.
    const counts = [await upvotes("/"), await upvotes("/audit")];

    expect(counts).toStrictEqual(["12", "12"]);
    expect(asked).toStrictEqual([PRODUCT_HUNT_BADGE_URL]);
    expect([...kept.keys()]).toStrictEqual([KEPT]);
    expect(kept.get(KEPT)?.headers.get("cache-control")).toBe(
      "public, max-age=14400"
    );
  });

  it.each([
    ["an error", new Response("Bad gateway", { status: 502 })],
    [
      "a page that is not an SVG",
      new Response("<!doctype html><title>Hi</title>"),
    ],
    [
      "an answer far larger than the badge",
      svgAnswer(`<svg>${"x".repeat(70_000)}</svg>`),
    ],
    ["a badge with no count", svgAnswer(phBadge("soon"))],
    ["a failed request", new Error("connect ETIMEDOUT")],
  ])(
    "has no count for five minutes when Product Hunt answers with %s",
    async (_, answer) => {
      const { asked, kept, upvotes } = setup(answer, svgAnswer());

      const counts = [await upvotes(), await upvotes()];

      expect({
        counts,
        location: kept.get(KEPT)?.headers.get("cache-control"),
        asked: asked.length,
      }).toStrictEqual({
        counts: [undefined, undefined],
        location: "public, max-age=300",
        asked: 1,
      });

      // Once the location's copy expires, it asks again and keeps the count.
      kept.clear();

      expect([await upvotes(), asked.length]).toStrictEqual(["12", 2]);
    }
  );

  it.each([
    ["7", "7"],
    ["1,204", "1,204"],
    ["1.2K", "1.2K"],
    ["", undefined],
    ["12<script>", undefined],
    ["1234567890123", undefined],
  ])("reads %j after the upvote arrow as %j", (count, read) => {
    expect(upvotesIn(phBadge(count))).toBe(read);
  });

  it("reads no count from a badge without the upvote arrow, nor from text before it, nor from a long answer of nothing", () => {
    expect([
      upvotesIn('<svg><text><tspan x="1">12</tspan></text></svg>'),
      upvotesIn('<svg><tspan x="1">12</tspan><polygon points="0 0"/></svg>'),
      upvotesIn(`<polygon${"<tspan".repeat(10_000)}`),
      upvotesIn(""),
    ]).toStrictEqual([undefined, undefined, undefined, undefined]);
  });

  it("is drawn as the Claude Directory's badge is, with the count, or an invitation without it", () => {
    const href = PRODUCT_HUNT_URL.replaceAll("&", "&amp;");
    const arrow = /<svg class="icon" [^>]+>.*?<\/svg>/u;

    expect(
      [productHuntBadge("12"), productHuntBadge("1"), productHuntBadge()].map(
        (html) => html.replace(arrow, "▲")
      )
    ).toStrictEqual([
      `<a class="badge" href="${href}" target="_blank" rel="noopener noreferrer"><span class="badge-key">Product Hunt</span><span class="badge-value">▲12<span class="sr-only"> upvotes</span></span></a>`,
      `<a class="badge" href="${href}" target="_blank" rel="noopener noreferrer"><span class="badge-key">Product Hunt</span><span class="badge-value">▲1<span class="sr-only"> upvote</span></span></a>`,
      `<a class="badge" href="${href}" target="_blank" rel="noopener noreferrer"><span class="badge-key">Product Hunt</span><span class="badge-value">▲Upvote</span></a>`,
    ]);
  });
});
