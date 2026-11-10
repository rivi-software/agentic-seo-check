import { readFileSync } from "node:fs";

declare global {
  /**
   * The version a bundle builds in, where no package.json lies beside the code: the hosted
   * server's build sets it with Wrangler's `define` (hosted/scripts/defines.ts). Node never has it.
   */
  // oxlint-disable-next-line no-var -- a declaration of a global is written with var
  var AGENTIC_SEO_CHECK_VERSION: string | undefined;
}

const manifestVersion = (): string => {
  // SAFETY: npm and pnpm refuse to pack or publish a package.json without a string version.
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  ) as { version: string };

  return manifest.version;
};

/** Package version, read from package.json (one level above both src/ and dist/) so a release bumps one file. */
export const VERSION: string =
  globalThis.AGENTIC_SEO_CHECK_VERSION ?? manifestVersion();
