/**
 * Runs Wrangler on the hosted server: in hosted/, where wrangler.jsonc is, and with the defines a
 * build needs (scripts/defines.ts), the npm package's version and the rate limits of wrangler.jsonc.
 * The `hosted:*` scripts of package.json go through it.
 *   node hosted/scripts/wrangler.ts deploy
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defines } from "./defines.ts";

const [command = "", ...rest] = process.argv.slice(2);

// `wrangler types` only reads the configuration; the commands that bundle the Worker take defines.
const built =
  command === "types"
    ? []
    : Object.entries(defines()).flatMap(([name, value]) => [
        "--define",
        `${name}:${value}`,
      ]);

// pnpm puts node_modules/.bin on the PATH of the scripts it runs.
const { status, error } = spawnSync("wrangler", [command, ...rest, ...built], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
});

if (error) {
  throw error;
}

process.exitCode = status ?? 1;
