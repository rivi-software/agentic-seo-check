import { describe, expect, it } from "vitest";

import { freshResponse } from "../src/fresh.ts";

const URL = "https://agentic-seo.org/";

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
};

const request = (init: RequestInit = {}) => new Request(URL, init);

const ask = (ifNoneMatch: string, method = "GET") =>
  request({ method, headers: { "if-none-match": ifNoneMatch } });

describe("freshResponse (issue #160)", () => {
  it("lets a browser keep a page but ask for it on every visit, with a weak ETag of its bytes", async () => {
    const res = await freshResponse(request(), "<p>one</p>", HEADERS);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("<p>one</p>");
    expect(Object.fromEntries(res.headers)).toStrictEqual({
      ...HEADERS,
      "cache-control": "no-cache",
      etag: expect.stringMatching(/^W\/"[\da-f]{32}"$/u),
    });
  });

  it("gives the same bytes the same ETag, and other bytes another", async () => {
    const tags = await Promise.all(
      ["<p>one</p>", "<p>one</p>", "<p>two</p>"].map(async (body) => {
        const res = await freshResponse(request(), body, HEADERS);

        return res.headers.get("etag");
      })
    );

    expect(tags[0]).toBe(tags[1]);
    expect(tags[0]).not.toBe(tags[2]);
  });

  it("answers 304 without a body or a content type when If-None-Match names the ETag", async () => {
    const first = await freshResponse(request(), "<p>one</p>", HEADERS);
    const etag = first.headers.get("etag") ?? "";
    const strong = etag.slice(2);

    const answers = await Promise.all(
      [etag, strong, `W/"other", ${etag}`, "*"].map(async (tag) => {
        const res = await freshResponse(ask(tag), "<p>one</p>", HEADERS);

        return [res.status, await res.text(), Object.fromEntries(res.headers)];
      })
    );

    expect(answers).toStrictEqual(
      Array.from({ length: 4 }, () => [
        304,
        "",
        {
          "x-content-type-options": "nosniff",
          "cache-control": "no-cache",
          etag,
        },
      ])
    );
  });

  it("sends the new page when the browser's copy is of another deploy", async () => {
    const old = await freshResponse(request(), "<p>one</p>", HEADERS);

    const res = await freshResponse(
      ask(old.headers.get("etag") ?? ""),
      "<p>two</p>",
      HEADERS
    );

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("<p>two</p>");
  });

  it("answers a HEAD with the headers only, and with 304 as a GET is", async () => {
    const head = await freshResponse(
      request({ method: "HEAD" }),
      "<p>one</p>",
      HEADERS
    );

    const etag = head.headers.get("etag") ?? "";
    const again = await freshResponse(ask(etag, "HEAD"), "<p>one</p>", HEADERS);

    expect([head.status, head.body, again.status]).toStrictEqual([
      200,
      null,
      304,
    ]);
  });

  it("gives a page that is no 200 no ETag, so it never answers 304", async () => {
    const res = await freshResponse(ask("*"), "<p>not found</p>", HEADERS, 404);

    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe("<p>not found</p>");
    expect([
      res.headers.get("cache-control"),
      res.headers.get("etag"),
    ]).toStrictEqual(["no-cache", null]);
  });
});
