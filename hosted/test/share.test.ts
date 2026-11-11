/**
 * Sharing a report (issue #54): the signed link, the post each network gets, the share page and
 * the share image, in Node. test/worker.test.ts follows a link from the form's answer in workerd.
 */
import { readFileSync } from "node:fs";

import { initWasm } from "@resvg/resvg-wasm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditAeoHtml } from "../../src/core/aeo/audit.ts";
import { auditHtml } from "../../src/core/audit.ts";
import { SITE_ORIGIN } from "../src/site/layout.ts";
import { renderReport } from "../src/site/report.ts";
import { shareMenu, sharePage } from "../src/site/share-page.ts";
import {
  openShare,
  shareImageCacheKey,
  shareResult,
  shareTargets,
  signShare,
} from "../src/site/share.ts";
import type { ShareResult } from "../src/site/share.ts";
import { OG_IMAGE } from "../src/ui/og.ts";
import { drawShareCard, shareCardSvg } from "../src/ui/share-card.ts";

const ENV = { SHARE_KEY: "the key that signs" };

const RESULT: ShareResult = {
  kind: "page",
  url: "https://shop.example.com/pricing?plan=team",
  day: "2026-11-11",
  seo: { score: 82, counts: { error: 0, warning: 3, info: 3 } },
  aeo: { score: 93, counts: { error: 0, warning: 1, info: 2 } },
  pages: 1,
};

const SITE_RESULT: ShareResult = {
  ...RESULT,
  kind: "site",
  url: "https://shop.example.com/",
  seo: { score: 41, counts: { error: 12, warning: 30, info: 1 } },
  pages: 25,
};

const signed = async (result: ShareResult, env = ENV) => {
  const link = await signShare(env, result);

  if (!link) {
    throw new Error("signShare made no link with a key");
  }

  return link;
};

/** `text` with the character at `index` changed to another one base64url has. */
const flip = (text: string, index: number) =>
  `${text.slice(0, index)}${text[index] === "A" ? "B" : "A"}${text.slice(index + 1)}`;

/** Findings above info: what the pages must not have. */
const problems = (findings: { rule: string; severity: string }[]) =>
  findings.flatMap((f) => (f.severity === "info" ? [] : [f.rule]));

describe("a share link", () => {
  it("opens to the result it was signed with", async () => {
    const links = await Promise.all(
      [RESULT, SITE_RESULT].map((r) => signed(r))
    );

    const opened = await Promise.all(links.map((l) => openShare(ENV, l.token)));

    expect(opened).toStrictEqual([RESULT, SITE_RESULT]);
  });

  it("opens to nothing once a character of its result or its signature changes", async () => {
    const { token } = await signed(RESULT);
    const dot = token.indexOf(".");

    await expect(openShare(ENV, flip(token, 5))).resolves.toBeNull();
    await expect(openShare(ENV, flip(token, dot + 3))).resolves.toBeNull();
    await expect(openShare(ENV, token.slice(0, dot))).resolves.toBeNull();
  });

  it("opens with the previous key, which never signs", async () => {
    const old = await signed(RESULT, { SHARE_KEY: "the old key" });

    const rotated = {
      SHARE_KEY: "the new key",
      SHARE_KEY_PREVIOUS: "the old key",
    };

    await expect(openShare(rotated, old.token)).resolves.toStrictEqual(RESULT);
    await expect(
      openShare({ SHARE_KEY: "the new key" }, old.token)
    ).resolves.toBeNull();

    const fresh = await signed(RESULT, rotated);

    await expect(
      openShare({ SHARE_KEY: "the new key" }, fresh.token)
    ).resolves.toStrictEqual(RESULT);
  });

  it("is not made for an address the page would refuse, so no Share button leads to a 404", async () => {
    // Under the form's 2,048 typed characters, but over them once URL percent-encodes the path,
    // as it is again after a redirect to a long address.
    const encoded = new URL(`https://shop.example.com/${"é".repeat(400)}`).href;

    expect(encoded.length).toBeGreaterThan(2048);
    await expect(
      signShare(ENV, { ...RESULT, url: encoded })
    ).resolves.toBeNull();
    await expect(
      signShare(ENV, {
        ...RESULT,
        url: `https://shop.example.com/${"a".repeat(2000)}`,
      })
    ).resolves.not.toBeNull();
  });

  it("is not made, and none opens, without a key", async () => {
    const { token } = await signed(RESULT);

    await expect(signShare({}, RESULT)).resolves.toBeNull();
    await expect(openShare({}, token)).resolves.toBeNull();
  });

  it("holds the audits' address, day, scores, counts and pages", async () => {
    const url = "https://shop.example.com/pricing";

    const html =
      "<html><head><title>React App</title></head><body></body></html>";

    const seo = await auditHtml(html, { url, source: "url", target: url });
    const aeo = await auditAeoHtml(html, { url });

    expect(shareResult(seo, aeo)).toStrictEqual({
      kind: "page",
      url,
      day: seo.auditedAt.slice(0, 10),
      seo: { score: seo.score, counts: seo.counts },
      aeo: { score: aeo.score, counts: aeo.counts },
      pages: 1,
    });
  });
});

describe("the post a share link starts", () => {
  it("names the address and the scores, and RIVI Software's account on X", async () => {
    const targets = shareTargets(await signed(RESULT));
    const x = new URL(targets.x);

    expect(targets.text).toBe(
      "shop.example.com/pricing?plan=team: SEO 82, AEO 93 in Agentic SEO Check"
    );
    expect(targets.url.startsWith(`${SITE_ORIGIN}/share/`)).toBeTruthy();
    expect({
      x: [x.origin, x.pathname, Object.fromEntries(x.searchParams)],
      linkedin: new URL(targets.linkedin).searchParams.get("url"),
      bluesky: new URL(targets.bluesky).searchParams.get("text"),
    }).toStrictEqual({
      x: [
        "https://x.com",
        "/intent/post",
        { text: targets.text, url: targets.url, via: "rivi_software" },
      ],
      linkedin: targets.url,
      bluesky: `${targets.text} ${targets.url}`,
    });
  });

  it("says a site's pages, and stays short for a long address", async () => {
    const site = shareTargets(await signed(SITE_RESULT));

    const long = shareTargets(
      await signed({
        ...RESULT,
        url: `https://shop.example.com/${"a".repeat(1500)}`,
      })
    );

    expect(site.text).toBe(
      "shop.example.com, 25 pages: SEO 41, AEO 93 in Agentic SEO Check"
    );
    expect(long.text.length).toBeLessThan(120);
  });
});

describe("the share menu", () => {
  it("links each network in a menu that needs no script, and comes with the report", async () => {
    const link = await signed(RESULT);
    const menu = shareMenu(link);
    const url = "https://shop.example.com/";

    const html =
      "<html><head><title>React App</title></head><body></body></html>";

    const seo = await auditHtml(html, { url, source: "url", target: url });
    const aeo = await auditAeoHtml(html, { url });

    expect(menu).toContain('<details class="share-menu">');
    expect(
      [...menu.matchAll(/href="(?<site>https:\/\/[^/]+\/[^?]+)\?/gu)].map(
        (m) => m.groups?.site
      )
    ).toStrictEqual([
      "https://x.com/intent/post",
      "https://www.linkedin.com/sharing/share-offsite/",
      "https://bsky.app/intent/compose",
    ]);
    expect(renderReport(seo, aeo, false, menu)).toContain(menu);
    expect(renderReport(seo, aeo)).not.toContain("share-menu");
  });
});

describe("the share page", () => {
  it("shows the result, stays out of search, and gives the result's own image", async () => {
    const link = await signed(RESULT);
    const html = sharePage(link);

    for (const part of [
      '<meta name="robots" content="noindex">',
      `<meta property="og:image" content="${SITE_ORIGIN}/share/${link.token}.png">`,
      '<meta name="twitter:site" content="@rivi_software">',
      "SEO: search engines",
      "11 November 2026",
      // The form, filled with the address, which runs only when it is sent.
      `href="/?url=${encodeURIComponent(RESULT.url)}#audit"`,
    ]) {
      expect(html).toContain(part);
    }
  });

  it("passes the tool's own audits, but for the noindex it has on purpose", async () => {
    const link = await signed(SITE_RESULT);
    const html = sharePage(link);
    const url = `${SITE_ORIGIN}/share/${link.token}`;
    const seo = await auditHtml(html, { url, source: "url", target: url });
    const aeo = await auditAeoHtml(html, { url });

    expect(
      problems(seo.findings).filter((rule) => !rule.includes("noindex"))
    ).toStrictEqual([]);
    expect(
      problems(aeo.findings).filter((rule) => !rule.includes("noindex"))
    ).toStrictEqual([]);
  });

  it("quotes the address as text, not markup", async () => {
    const html = sharePage(
      await signed({
        ...RESULT,
        url: 'https://shop.example.com/"><script>alert(1)</script>',
      })
    );

    expect(html).not.toContain("<script>alert(1)");
  });
});

describe("the share image's cache key", () => {
  it("is the path and the version, whatever query the request has", () => {
    const image = `${SITE_ORIGIN}/share/abc.${"A".repeat(22)}.png`;

    expect(
      ["", "?1", "?2&x=y"].map((query) =>
        shareImageCacheKey(`${image}${query}`, "0.8.2")
      )
    ).toStrictEqual([
      `${image}?v=0.8.2`,
      `${image}?v=0.8.2`,
      `${image}?v=0.8.2`,
    ]);
    expect(shareImageCacheKey(image, "0.9.0")).toBe(`${image}?v=0.9.0`);
  });
});

describe("the share image", () => {
  const fonts = ["geist-400", "geist-500", "geist-600", "geist-mono-400"].map(
    (name) =>
      new Uint8Array(
        readFileSync(new URL(`../assets/${name}-ascii.ttf`, import.meta.url))
      )
  );

  beforeAll(async () => {
    await initWasm(
      readFileSync(
        new URL(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))
      )
    );
  });

  it("is a PNG of the size the page states", () => {
    const png = Buffer.from(drawShareCard(RESULT, fonts));

    expect([
      png.subarray(0, 8).toString("hex"),
      png.readUInt32BE(16),
      png.readUInt32BE(20),
    ]).toStrictEqual(["89504e470d0a1a0a", OG_IMAGE.width, OG_IMAGE.height]);
  });

  it("draws the hostname, never the path, and keeps the end of a hostname too long for it", () => {
    const svg = shareCardSvg(RESULT, fonts);

    const long = shareCardSvg(
      {
        ...SITE_RESULT,
        url: `https://${"subdomain-".repeat(12)}example.co.uk/`,
      },
      fonts
    );

    expect(svg).toContain(">shop.example.com<");
    expect(svg).not.toContain("pricing");
    expect(svg).toContain(">Page audit<");
    expect(long).toMatch(/>…[\w.-]*example\.co\.uk</u);
  });
});
