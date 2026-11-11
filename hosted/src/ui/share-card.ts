/**
 * The share image of a shared result (issue #54): a 1200×630 card in the look of the static cards
 * (scripts/og-image.ts), with the hostname, the kind of audit, the day and both scores as rings.
 * The Worker writes it as SVG and resvg turns that into a PNG. The words are set in static
 * instances of Geist cut to ASCII and five marks, … · – — ’ (assets/geist-*-ascii.ttf): resvg
 * reads neither WOFF2 nor the weights of a variable font. resvg has no other fonts, so a character
 * the files lack is drawn as nothing; test/share.test.ts holds every character the card writes to
 * them. A hostname is ASCII, since URL keeps a domain name in punycode.
 * Only the hostname is drawn, never the path: anyone can type any path, and the card is what a
 * feed shows.
 */
import { Resvg } from "@resvg/resvg-wasm";
import type { ResvgRenderOptions } from "@resvg/resvg-wasm";

import { PRODUCT_NAME } from "../../../src/brand.js";
import { band } from "../../../src/core/report/labels.js";
import type { SeverityCounts } from "../../../src/core/types.js";
import { esc } from "../site/html.js";
import { dayText } from "../site/share.js";
import type { ShareResult } from "../site/share.js";
import { OG_IMAGE, SITE_CARD } from "./og.js";

const { width: W, height: H } = OG_IMAGE;

/** The left and right margin, and the top of the foot, as the static cards have them. */
const MARGIN = 72;
const RULE_Y = 517;

/** The heading's largest size, its smallest, and how wide it may run before the rings. */
const HEADING_SIZE = 72;
const HEADING_MIN = 40;
const HEADING_WIDTH = 620;

/** The rings: their radius, their stroke, the centre of each column and the rings' centre line. */
const RING_R = 70;
const RING_STROKE = 10;
const RING_Y = 262;
const COLUMNS = [833, 1033] as const;

const INK = {
  ground: "#08090a",
  text: "#f7f8f8",
  body: "#d0d6e0",
  muted: "#8a8f98",
  signal: "#3be08a",
  signalText: "#5ee89f",
};

/** The bands of score.ts's scores, coloured as the report colours them (style.ts). */
const BANDS = {
  good: "#3be08a",
  fair: "#f2a33a",
  poor: "#f0675f",
} as const;

const SEVERITY_TEXT: Record<keyof SeverityCounts, string> = {
  error: "#f28b82",
  warning: "#f5b866",
  info: "#8dbaf7",
};

/** The RIVI Software mark as the static cards draw it, on the dark ground. */
const MARK = `<svg x="${MARGIN}" y="64" width="44" height="44" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#f7f8f8"/><g fill="#08090a"><rect x="8" y="16" width="3" height="8" rx="1.5"/><rect x="13.25" y="11" width="3" height="18" rx="1.5"/><rect x="18.5" y="7" width="3" height="26" rx="1.5" fill="#0e9f55"/><rect x="23.75" y="12" width="3" height="16" rx="1.5"/><rect x="29" y="16" width="3" height="8" rx="1.5"/></g></svg>`;

const options = (fonts: Uint8Array[]): ResvgRenderOptions => ({
  fitTo: { mode: "original" },
  font: {
    fontBuffers: fonts,
    loadSystemFonts: false,
    defaultFontFamily: "Geist",
  },
});

interface Text {
  text: string;
  size: number;
  weight: 400 | 500 | 600;
  /** Letter spacing in em, as the stylesheet writes it. */
  tracking?: number;
  family?: "Geist" | "Geist Mono";
}

const textAttributes = (t: Text): string =>
  `font-family="${t.family ?? "Geist"}" font-size="${t.size}" font-weight="${t.weight}"${t.tracking ? ` letter-spacing="${(t.tracking * t.size).toFixed(2)}"` : ""}`;

const textAt = (
  t: Text,
  x: number,
  y: number,
  fill: string,
  anchor: "start" | "middle" | "end" = "start"
): string =>
  `<text x="${x}" y="${y}" fill="${fill}" text-anchor="${anchor}" ${textAttributes(t)}>${esc(t.text)}</text>`;

/** How wide `t` is set, in pixels: resvg lays it out alone and measures what it drew. */
const widthOf = (fonts: Uint8Array[], t: Text): number => {
  const resvg = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200">${textAt(t, 0, 150, "#000")}</svg>`,
    options(fonts)
  );

  try {
    const box = resvg.getBBox();
    const width = box?.width ?? 0;
    box?.free();

    return width;
  } finally {
    resvg.free();
  }
};

/** The heading's words at `size`, set as the static cards set theirs. */
const at = (text: string, size: number): Text => ({
  text,
  size,
  weight: 500,
  tracking: -0.035,
});

/**
 * The hostname as the heading: at its largest size when it fits, smaller in proportion when it
 * does not, and with its start cut to an ellipsis when even the smallest size runs past the rings.
 * The end stays, since that is where the domain is.
 */
const heading = (fonts: Uint8Array[], hostname: string): Text => {
  const full = widthOf(fonts, at(hostname, HEADING_SIZE));

  if (full <= HEADING_WIDTH) {
    return at(hostname, HEADING_SIZE);
  }

  const size = Math.floor((HEADING_SIZE * HEADING_WIDTH) / full);

  if (size >= HEADING_MIN) {
    return at(hostname, size);
  }

  // The longest end of the hostname that fits after its ellipsis, found by halving.
  let low = 1;
  let high = hostname.length - 1;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (
      widthOf(fonts, at(`…${hostname.slice(-mid)}`, HEADING_MIN)) <=
      HEADING_WIDTH
    ) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return at(`…${hostname.slice(-low)}`, HEADING_MIN);
};

/** A score's ring, filled to the score and coloured by its band, with the number inside. */
const ring = (cx: number, score: number): string => {
  const colour = BANDS[band(score)];
  const length = 2 * Math.PI * RING_R;
  const arc = (length * score) / 100;

  const fill =
    score > 0
      ? `<circle cx="${cx}" cy="${RING_Y}" r="${RING_R}" fill="none" stroke="${colour}" stroke-width="${RING_STROKE}" stroke-linecap="round" stroke-dasharray="${arc.toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 ${cx} ${RING_Y})"/>`
      : "";

  return `<circle cx="${cx}" cy="${RING_Y}" r="${RING_R}" fill="none" stroke="${colour}" stroke-opacity="0.18" stroke-width="${RING_STROKE}"/>
<g filter="url(#glow)" opacity="0.55">${fill}</g>${fill}
${textAt({ text: String(score), size: 56, weight: 500, tracking: -0.04 }, cx, RING_Y + 20, INK.text, "middle")}`;
};

const COUNT_NOUN: Record<keyof SeverityCounts, (count: number) => string> = {
  error: (count) => `${count} ${count === 1 ? "error" : "errors"}`,
  warning: (count) => `${count} ${count === 1 ? "warning" : "warnings"}`,
  info: (count) => `${count} info`,
};

/** A score's column: the ring, the audit's name and its counts, one line per severity it has. */
const scoreColumn = (
  cx: number,
  name: string,
  { score, counts }: ShareResult["seo"]
): string => {
  const lines = (["error", "warning", "info"] as const).flatMap((severity) =>
    counts[severity] > 0
      ? [[COUNT_NOUN[severity](counts[severity]), SEVERITY_TEXT[severity]]]
      : []
  );

  const shown = lines.length > 0 ? lines : [["No findings", INK.signalText]];
  const top = RING_Y + RING_R + 50;

  return [
    ring(cx, score),
    textAt({ text: name, size: 24, weight: 600 }, cx, top, INK.text, "middle"),
    ...shown.map(([text = "", colour = INK.muted], index) =>
      textAt(
        { text, size: 19, weight: 500 },
        cx,
        top + 32 + index * 27,
        colour,
        "middle"
      )
    ),
  ].join("\n");
};

/** The card of `result` as SVG, with its words laid out in `fonts`. */
export const shareCardSvg = (
  result: ShareResult,
  fonts: Uint8Array[]
): string => {
  const { hostname } = new URL(result.url);
  const title = heading(fonts, hostname);

  const pill: Text = {
    text:
      result.kind === "site"
        ? `Site audit, ${result.pages} ${result.pages === 1 ? "page" : "pages"}`
        : "Page audit",
    size: 20,
    weight: 500,
  };

  const pillWidth = 18 + 10 + 12 + widthOf(fonts, pill) + 22;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="green" gradientUnits="userSpaceOnUse" cx="996" cy="315" r="480" gradientTransform="translate(996 315) scale(1 0.7875) translate(-996 -315)"><stop offset="0" stop-color="${INK.signal}" stop-opacity="0.15"/><stop offset="0.72" stop-color="${INK.signal}" stop-opacity="0"/></radialGradient>
<radialGradient id="light" gradientUnits="userSpaceOnUse" cx="300" cy="0" r="840" gradientTransform="translate(300 0) scale(1 0.4125) translate(-300 0)"><stop offset="0" stop-color="#fff" stop-opacity="0.03"/><stop offset="0.7" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="edge" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="${INK.ground}"/>
<rect width="${W}" height="${H}" fill="url(#green)"/>
<rect width="${W}" height="${H}" fill="url(#light)"/>
<rect width="${W}" height="1" fill="url(#edge)"/>
${MARK}
${textAt({ text: `RIVI ${PRODUCT_NAME}`, size: 27, weight: 600, tracking: -0.02 }, 132, 96, INK.text)}
<rect x="${MARGIN + 0.5}" y="188.5" width="${pillWidth.toFixed(1)}" height="43" rx="21.5" fill="#fff" fill-opacity="0.04" stroke="#fff" stroke-opacity="0.12"/>
<circle cx="${MARGIN + 23}" cy="210" r="9" fill="${INK.signal}" fill-opacity="0.2"/>
<circle cx="${MARGIN + 23}" cy="210" r="5" fill="${INK.signal}"/>
${textAt(pill, MARGIN + 40, 217, INK.body)}
${textAt(title, MARGIN, 330, INK.text)}
${textAt({ text: `Audited on ${dayText(result.day)}`, size: 36, weight: 500, tracking: -0.025 }, MARGIN, 392, INK.muted)}
${scoreColumn(COLUMNS[0], "SEO", result.seo)}
${scoreColumn(COLUMNS[1], "AEO", result.aeo)}
<rect x="${MARGIN}" y="${RULE_Y}" width="${W - 2 * MARGIN}" height="1" fill="#fff" fill-opacity="0.08"/>
${textAt({ text: `${SITE_CARD.title} ${SITE_CARD.accent}`, size: 19, weight: 400, family: "Geist Mono" }, MARGIN, 566, INK.muted)}
${textAt({ text: SITE_CARD.domain, size: 22, weight: 400 }, W - MARGIN, 566, INK.body, "end")}
</svg>`;
};

/** The card of `result` as a PNG. */
export const drawShareCard = (
  result: ShareResult,
  fonts: Uint8Array[]
): Uint8Array => {
  const resvg = new Resvg(shareCardSvg(result, fonts), options(fonts));

  try {
    const image = resvg.render();

    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
};
