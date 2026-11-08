import { readFileSync } from "node:fs";

/** Package version, read from package.json (one level above both src/ and dist/) so a release bumps one file. */
// SAFETY: npm and pnpm refuse to pack or publish a package.json without a string version.
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
) as { version: string };

export const VERSION: string = manifest.version;
