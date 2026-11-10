/**
 * Draws the share images of both hostnames (src/ui/og.ts) into assets/, as rivi.software draws
 * its own: the lockup, a pill, the two-tone heading, the mark's level bars with the middle one lit,
 * a hairline and the domain, in Geist on the ink ground. Run it after changing a card, and commit
 * the PNGs it writes:
 *   pnpm run hosted:og
 * It needs Playwright's Chromium (`agentic-seo-check install-browser`) or an installed Chrome.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { chromium } from "playwright";

import { esc } from "../src/site/html.ts";
import { MARK } from "../src/ui/icons.ts";
import { OG_IMAGE, SERVER_CARD, SITE_CARD } from "../src/ui/og.ts";
import type { ShareCard } from "../src/ui/og.ts";

const assets = new URL("../assets/", import.meta.url);

const fontUrl = (file: string): string =>
  `data:font/woff2;base64,${readFileSync(new URL(file, assets)).toString("base64")}`;

/** The heading's widest, in pixels: it ends before the bars, as rivi.software's cards keep it. */
const HEADING_WIDTH = 740;

/** The heading's size, in pixels, unless it would be wider than HEADING_WIDTH. */
const HEADING_SIZE = 76;

/**
 * The mark's five bars (assets/rivi-mark.svg), eleven times their size, where rivi.software's
 * cards draw them: left, top and height in pixels.
 */
const BARS = [
  [0, 99, 88],
  [57.75, 44, 198],
  [115.5, 0, 286],
  [173.25, 55, 176],
  [231, 99, 88],
]
  .map(
    ([left, top, height], index) =>
      `<i${index === 2 ? ' class="lit"' : ""} style="left:${left}px;top:${top}px;height:${height}px"></i>`
  )
  .join("");

const cardHtml = (card: ShareCard): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
@font-face{font-family:"Geist";font-weight:100 900;src:url("${fontUrl("geist-latin.woff2")}") format("woff2")}
@font-face{font-family:"Geist Mono";font-weight:100 900;src:url("${fontUrl("geist-mono-latin.woff2")}") format("woff2")}
:root{--logo-tile:#f7f8f8;--logo-bars:#08090a;--signal-cue:#0e9f55}
*{box-sizing:border-box}
html,body{width:${OG_IMAGE.width}px;height:${OG_IMAGE.height}px;margin:0;background:#08090a}
body{position:relative;overflow:hidden;color:#f7f8f8;font-family:"Geist",sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:absolute;inset:0;background:radial-gradient(40% 60% at 83% 50%,#3be08a26,#0000 72%),radial-gradient(70% 55% at 25% 0,#ffffff08,#0000 70%)}
body::after{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,#0000,#ffffff2e,#0000)}
.lockup{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:16px;font-size:27px;font-weight:600;letter-spacing:-.02em}
.lockup svg{width:44px;height:44px}
.pill{position:absolute;left:72px;top:188px;display:flex;align-items:center;gap:12px;height:44px;margin:0;padding:0 20px 0 18px;border:1px solid #ffffff1f;border-radius:999px;background:#ffffff0a;color:#d0d6e0;font-size:20px;font-weight:500}
.dot{width:10px;height:10px;border-radius:50%;background:#3be08a;box-shadow:0 0 0 4px #3be08a33}
h1{position:absolute;left:72px;top:262px;margin:0;font-size:${HEADING_SIZE}px;font-weight:500;line-height:1.06;letter-spacing:-.035em;white-space:nowrap}
h1 span{display:block;color:#8a8f98}
.bars{position:absolute;left:864px;top:172px;width:264px;height:286px}
.bars i{position:absolute;width:33px;border-radius:17px;background:#ffffff12}
.bars i.lit{background:#3be08a;box-shadow:0 0 48px #3be08a73,0 0 120px #3be08a33}
.rule{position:absolute;left:72px;right:72px;top:517px;height:1px;background:#ffffff14}
.foot{position:absolute;left:72px;right:72px;top:546px;display:flex;align-items:baseline;justify-content:space-between;gap:32px}
.note{color:#8a8f98;font-family:"Geist Mono",monospace;font-size:19px}
.domain{color:#d0d6e0;font-size:22px}
</style>
</head>
<body>
<div class="lockup">${MARK}<span>RIVI agentic-seo-check</span></div>
<p class="pill"><span class="dot"></span>${esc(card.pill)}</p>
<h1>${esc(card.title)}<span>${esc(card.accent)}</span></h1>
<div class="bars">${BARS}</div>
<div class="rule"></div>
<div class="foot"><span class="note">${esc(card.note)}</span><span class="domain">${esc(card.domain)}</span></div>
</body>
</html>`;

/** Playwright's Chromium, or the installed Chrome when that build is missing, as render.ts does. */
const launch = async () => {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
};

/** Draws `card` in a page of its own and writes the PNG; the size its heading took. */
const draw = async (
  browser: Awaited<ReturnType<typeof launch>>,
  card: ShareCard
): Promise<number> => {
  const page = await browser.newPage({
    viewport: { width: OG_IMAGE.width, height: OG_IMAGE.height },
  });

  await page.setContent(cardHtml(card));
  await page.evaluate("document.fonts.ready");

  // A heading wider than its side of the card is set smaller, in proportion: text scales with it.
  const box = await page.locator("h1").boundingBox();

  const size =
    box && box.width > HEADING_WIDTH
      ? Math.floor((HEADING_SIZE * HEADING_WIDTH) / box.width)
      : HEADING_SIZE;

  if (size < HEADING_SIZE) {
    await page.addStyleTag({ content: `h1{font-size:${size}px}` });
  }

  writeFileSync(
    new URL(card.file, assets),
    await page.screenshot({ type: "png" })
  );

  return size;
};

const browser = await launch();

try {
  const cards = [SITE_CARD, SERVER_CARD];
  const sizes = await Promise.all(cards.map((card) => draw(browser, card)));

  for (const [index, card] of cards.entries()) {
    console.log(`${card.file}: heading at ${sizes[index]}px`);
  }
} finally {
  await browser.close();
}
