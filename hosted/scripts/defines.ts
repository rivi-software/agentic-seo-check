/**
 * The constants the hosted build takes from files the Worker cannot read at run time: the npm
 * package's version (src/version.ts reads it in a bundle) and the rate limits of the Worker's
 * configuration (wrangler.jsonc, or the website's wrangler.site.jsonc), which the landing page and
 * the refusals state. scripts/wrangler.ts passes them to Wrangler as `--define`, and the tests to
 * `unstable_startWorker`.
 */
import { readFileSync } from "node:fs";

import { unstable_readConfig } from "wrangler";

const hosted = new URL("../", import.meta.url);

/** The rate limits of wrangler.jsonc by binding name: requests allowed per period in seconds. */
export type RateLimits = Record<string, { limit: number; period: number }>;

/** The MCP server's configuration; the website's is wrangler.site.jsonc. */
export const SERVER_CONFIG = "wrangler.jsonc";

export const SITE_CONFIG = "wrangler.site.jsonc";

/** A configuration in hosted/, as Wrangler reads it. */
export const readConfig = (file: string) =>
  unstable_readConfig({ config: new URL(file, hosted).pathname });

export const readRateLimits = (file = SERVER_CONFIG): RateLimits => {
  const config = readConfig(file);

  // Wrangler's types for its config come from a package it bundles, so they arrive untyped here.
  const ratelimits: {
    name: string;
    simple: { limit: number; period: number };
  }[] = config.ratelimits;

  return Object.fromEntries(
    ratelimits.map((r) => [
      r.name,
      { limit: r.simple.limit, period: r.simple.period },
    ])
  );
};

export const readVersion = (): string => {
  // SAFETY: npm and pnpm refuse to pack or publish a package.json without a string version.
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", hosted), "utf-8")
  ) as { version: string };

  return manifest.version;
};

/** Each define as the JavaScript expression Wrangler substitutes, for the Worker of `file`. */
export const defines = (file = SERVER_CONFIG) =>
  ({
    "globalThis.AGENTIC_SEO_CHECK_VERSION": JSON.stringify(readVersion()),
    HOSTED_RATE_LIMITS: JSON.stringify(readRateLimits(file)),
  }) satisfies Record<string, string>;
