import { describe, expect, it } from "vitest";

import {
  FALLBACK_BADGE,
  PRODUCT_HUNT_BADGE_PATH,
  PRODUCT_HUNT_BADGE_URL,
  productHuntBadgeResponse,
} from "../src/ui/product-hunt.ts";
import type { BadgeCache } from "../src/ui/product-hunt.ts";

const SITE = "https://agentic-seo.rivi.software";

const BADGE = `<?xml version="1.0" encoding="UTF-8"?>\n<svg width="250" height="54" xmlns="http://www.w3.org/2000/svg"><text>12</text></svg>\n`;

const svgAnswer = (body = BADGE, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "content-type": "image/svg+xml", ...headers },
  });

/** A Cache API of one location, kept in a map, and Product Hunt answering with `answers` in turn. */
const setup = (...answers: (Response | Error)[]) => {
  const kept = new Map<string, Response>();
  const asked: string[] = [];
  const later: Promise<unknown>[] = [];

  const cache: BadgeCache = {
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

  const badge = async (method = "GET") => {
    const res = await productHuntBadgeResponse(
      new Request(`${SITE}${PRODUCT_HUNT_BADGE_PATH}`, { method }),
      { waitUntil: (promise) => later.push(promise) },
      { cache, fetch: fetcher }
    );

    await Promise.all(later);

    return { res, text: await res.text() };
  };

  return { asked, badge, kept };
};

describe("the Product Hunt badge", () => {
  it("is Product Hunt's, fetched once and then served from the location's cache", async () => {
    const { asked, badge, kept } = setup(svgAnswer());

    const first = await badge();
    const second = await badge();

    expect(asked).toStrictEqual([PRODUCT_HUNT_BADGE_URL]);
    expect([...kept.keys()]).toStrictEqual([
      `${SITE}${PRODUCT_HUNT_BADGE_PATH}`,
    ]);
    expect([first.text, second.text]).toStrictEqual([BADGE, BADGE]);
    expect(
      kept
        .get(`${SITE}${PRODUCT_HUNT_BADGE_PATH}`)
        ?.headers.get("cache-control")
    ).toBe("public, max-age=14400");

    for (const { res } of [first, second]) {
      expect(Object.fromEntries(res.headers)).toStrictEqual({
        "content-type": "image/svg+xml",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=3600",
      });
    }
  });

  it("answers a HEAD with the headers only", async () => {
    const { badge } = setup(svgAnswer());

    const { res, text } = await badge("HEAD");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(text).toBe("");
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
    ["a failed request", new Error("connect ETIMEDOUT")],
  ])(
    "shows the artwork without the count, kept five minutes, when Product Hunt answers with %s",
    async (_, answer) => {
      const { asked, badge, kept } = setup(answer, svgAnswer());

      const first = await badge();
      const second = await badge();

      expect({
        texts: [first.text, second.text],
        browser: second.res.headers.get("cache-control"),
        location: kept
          .get(`${SITE}${PRODUCT_HUNT_BADGE_PATH}`)
          ?.headers.get("cache-control"),
        asked: asked.length,
      }).toStrictEqual({
        texts: [FALLBACK_BADGE, FALLBACK_BADGE],
        browser: "public, max-age=300",
        location: "public, max-age=300",
        asked: 1,
      });

      // Once the location's copy expires, it asks again and keeps Product Hunt's badge.
      kept.clear();
      const third = await badge();

      expect([third.text, asked.length]).toStrictEqual([BADGE, 2]);
    }
  );

  it("draws its fallback at the badge's size", () => {
    expect(FALLBACK_BADGE).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="250" height="54" viewBox="0 0 250 54">.*<\/svg>$/u
    );
    expect(FALLBACK_BADGE).toContain("Product Hunt");
  });
});
