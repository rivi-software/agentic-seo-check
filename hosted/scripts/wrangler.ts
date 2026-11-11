/**
 * Runs Wrangler on the hosted server or the website: in hosted/, where their configurations are,
 * and with the defines a build needs (scripts/defines.ts), the npm package's version and the rate
 * limits of the configuration it is given (`--config`, wrangler.jsonc when there is none). The
 * `hosted:*` and `site:*` scripts of package.json go through it.
 *   node hosted/scripts/wrangler.ts deploy
 *   node hosted/scripts/wrangler.ts deploy --config wrangler.site.jsonc
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defines, SERVER_CONFIG } from "./defines.ts";

const [command = "", ...rest] = process.argv.slice(2);

/** The configuration the command names: the Worker it builds or runs. */
const config = (): string => {
  const at = rest.findIndex((arg) => arg === "--config" || arg === "-c");

  return (at === -1 ? undefined : rest[at + 1]) ?? SERVER_CONFIG;
};

// `wrangler types` only reads the configuration; the commands that bundle the Worker take defines.
const built =
  command === "types"
    ? []
    : Object.entries(defines(config())).flatMap(([name, value]) => [
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
