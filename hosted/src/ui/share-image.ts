/**
 * The share image of a shared result (issue #54), as the Worker serves it: resvg's WebAssembly and
 * the card's fonts, which Wrangler bundles (the CompiledWasm and Data rules in wrangler.jsonc), and
 * the card itself (share-card.ts). Only the routes import this module: Node runs the pages' tests
 * and cannot import a .wasm or a font file.
 */
import { initWasm } from "@resvg/resvg-wasm";
import resvg from "@resvg/resvg-wasm/index_bg.wasm";

import geist400 from "../../assets/geist-400-ascii.ttf";
import geist500 from "../../assets/geist-500-ascii.ttf";
import geist600 from "../../assets/geist-600-ascii.ttf";
import geistMono400 from "../../assets/geist-mono-400-ascii.ttf";
import type { ShareResult } from "../site/share.js";
import { drawShareCard } from "./share-card.js";

const FONTS = [geist400, geist500, geist600, geistMono400].map(
  (font) => new Uint8Array(font)
);

/**
 * resvg, made ready on the first image an isolate draws rather than when it starts, so that a
 * Worker that serves no image never pays for it. A start that failed is tried again on the next
 * image.
 */
let ready: Promise<void> | null = null;

const start = async (): Promise<void> => {
  try {
    await initWasm(resvg);
  } catch (error) {
    ready = null;
    throw error;
  }
};

/** The card of `result` as a PNG. */
export const shareImage = async (result: ShareResult): Promise<Uint8Array> => {
  ready ??= start();
  await ready;

  return drawShareCard(result, FONTS);
};
