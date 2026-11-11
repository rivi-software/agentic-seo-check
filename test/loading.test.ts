import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { auditHtml } from "../src/core/audit.js";
import type { PageSource, ResponseInfo } from "../src/core/types.js";

const good = readFileSync(
  new URL("fixtures/good-page.html", import.meta.url),
  "utf-8"
);

const page = (body: string, head = "") =>
  `<!DOCTYPE html><html lang="en"><head><title>Blue widgets for home workshops</title>${head}</head><body>${body}</body></html>`;

const response = (
  url: string,
  headers: Record<string, string>
): ResponseInfo => ({
  status: 200,
  finalUrl: url,
  redirectChain: [],
  timeMs: 10,
  contentType: "text/html; charset=utf-8",
  headers,
});

interface Options {
  url?: string;
  source?: PageSource;
  headers?: Record<string, string>;
}

const findingsOf = async (
  rule: string,
  html: string,
  options: Options = {}
) => {
  const url = options.url ?? "https://www.example.com/widgets/blue/";
  const source = options.source ?? "url";

  const result = await auditHtml(
    html,
    options.headers
      ? { url, source, response: response(url, options.headers) }
      : { url, source }
  );

  return result.findings.filter((f) => f.rule === rule);
};

const NEW_RULES = new Set([
  "loading.render-blocking-script",
  "loading.no-compression",
  "img.lazy-above-fold",
  "img.srcset-missing",
  "favicon.missing",
]);

const words = (n: number) => `<p>${"word ".repeat(n)}</p>`;

describe("loading signals", () => {
  it("stay quiet on the good page", async () => {
    const result = await auditHtml(good, {
      url: "https://www.example.com/widgets/blue/",
      source: "url",
      response: response("https://www.example.com/widgets/blue/", {
        "content-encoding": "br",
      }),
    });

    expect(
      result.findings.map((f) => f.rule).filter((r) => NEW_RULES.has(r))
    ).toStrictEqual([]);
  });

  it("loading.render-blocking-script skips async, defer, modules, nomodule and JSON", async () => {
    const [f] = await findingsOf(
      "loading.render-blocking-script",
      page(
        "<h1>x</h1>",
        '<script src="/blocking.js"></script><script src="/a.js" async></script><script src="/d.js" defer></script><script type="module" src="/m.js"></script><script src="/legacy.js" nomodule></script><script type="application/json" src="/data.json"></script><script>inline()</script>'
      )
    );

    expect(f?.evidence).toStrictEqual({ count: 1, scripts: ["/blocking.js"] });
  });

  it("loading.no-compression reads Content-Encoding on public pages", async () => {
    const html = page(words(400));

    const [f] = await findingsOf("loading.no-compression", html, {
      headers: {},
    });

    expect(f?.severity).toBe("warning");

    await expect(
      findingsOf("loading.no-compression", html, {
        headers: { "content-encoding": "gzip" },
      })
    ).resolves.toStrictEqual([]);

    await expect(
      findingsOf("loading.no-compression", html, {
        url: "http://localhost:4321/",
        headers: {},
      })
    ).resolves.toStrictEqual([]);

    await expect(
      findingsOf("loading.no-compression", page("<p>tiny</p>"), { headers: {} })
    ).resolves.toStrictEqual([]);
  });

  it("loading.no-compression says nothing in a Cloudflare Worker, which never sees Content-Encoding", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

    try {
      await expect(
        findingsOf("loading.no-compression", page(words(400)), { headers: {} })
      ).resolves.toStrictEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("img.lazy-above-fold looks at the first large image only", async () => {
    const [f] = await findingsOf(
      "img.lazy-above-fold",
      page(
        `<header><img src="/logo.svg" alt="Logo" loading="lazy"><img src="/icon.png" width="32" height="32" alt="" loading="lazy"></header><h1>Blue widgets</h1><img src="/hero.jpg" alt="Hero" loading="lazy">${words(50)}`
      )
    );

    expect(f?.severity).toBe("info");
    expect(f?.evidence).toStrictEqual({ src: "/hero.jpg", wordsBefore: 2 });

    await expect(
      findingsOf(
        "img.lazy-above-fold",
        page(
          `<h1>Blue widgets</h1>${words(150)}<img src="/below.jpg" alt="Below" loading="lazy">`
        )
      )
    ).resolves.toStrictEqual([]);
  });

  it("img.lazy-above-fold skips an image inside <template> and checks the real first image", async () => {
    const [f] = await findingsOf(
      "img.lazy-above-fold",
      page(
        `<template><img src="/card.jpg" width="600" height="400" alt="Card" loading="lazy"></template><h1>Blue widgets</h1><img src="/hero.jpg" alt="Hero" loading="lazy">${words(50)}`
      )
    );

    expect(f?.evidence).toStrictEqual({ src: "/hero.jpg", wordsBefore: 2 });

    await expect(
      findingsOf(
        "img.lazy-above-fold",
        page(
          `<template><img src="/card.jpg" width="600" height="400" alt="Card" loading="lazy"></template><h1>Blue widgets</h1>${words(150)}`
        )
      )
    ).resolves.toStrictEqual([]);
  });

  it("img.lazy-above-fold warns about fetchpriority=high with loading=lazy anywhere", async () => {
    const [f] = await findingsOf(
      "img.lazy-above-fold",
      page(
        `${words(300)}<img src="/hero.jpg" alt="Hero" loading="lazy" fetchpriority="high">`
      )
    );

    expect(f?.severity).toBe("warning");
  });

  it("img.srcset-missing skips small, vector, srcset and <picture> images", async () => {
    const [f] = await findingsOf(
      "img.srcset-missing",
      page(
        '<img src="/hero.jpg" width="1200" height="600" alt="Hero"><img src="/thumb.jpg" width="320" height="200" alt="Thumb"><img src="/chart.svg" width="900" height="400" alt="Chart"><img src="/a.jpg" srcset="/a-480.jpg 480w, /a.jpg 960w" width="960" height="480" alt="A"><picture><source srcset="/b.avif" type="image/avif"><img src="/b.jpg" width="960" height="480" alt="B"></picture>'
      )
    );

    expect(f?.evidence).toStrictEqual({
      count: 1,
      examples: [{ src: "/hero.jpg", width: "1200" }],
    });
  });

  it("favicon.missing checks the home page only", async () => {
    const html = page("<h1>Widget Co</h1>");

    await expect(
      findingsOf("favicon.missing", html, { url: "https://www.example.com/" })
    ).resolves.toHaveLength(1);

    await expect(
      findingsOf(
        "favicon.missing",
        page(
          "<h1>Widget Co</h1>",
          '<link rel="shortcut icon" href="/favicon.ico">'
        ),
        { url: "https://www.example.com/" }
      )
    ).resolves.toStrictEqual([]);

    await expect(
      findingsOf("favicon.missing", html, {
        url: "https://www.example.com/widgets/",
      })
    ).resolves.toStrictEqual([]);

    await expect(
      findingsOf("favicon.missing", html, {
        url: "https://www.example.com/",
        source: "html",
      })
    ).resolves.toStrictEqual([]);

    const blocked = await auditHtml(html, {
      url: "https://www.example.com/",
      source: "url",
      response: { ...response("https://www.example.com/", {}), status: 403 },
    });

    expect(blocked.findings.map((f) => f.rule)).not.toContain(
      "favicon.missing"
    );
  });
});
