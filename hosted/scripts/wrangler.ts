/**
 * Runs Wrangler on the hosted server or the website: in hosted/, where their configurations are,
 * and with the defines a build needs (scripts/defines.ts), the npm package's version and the rate
 * limits of the configuration it is given (`--config`, wrangler.jsonc when there is none). The
 * `hosted:*` and `site:*` scripts of package.json go through it.
 *   node hosted/scripts/wrangler.ts deploy
 *   node hosted/scripts/wrangler.ts deploy --config wrangler.site.jsonc
 * `dev` also passes the secrets in hosted/.dev.secrets, when that file exists.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defines, SERVER_CONFIG } from "./defines.ts";

const [command = "", ...rest] = process.argv.slice(2);

/** The configuration the command names: the Worker it builds or runs. */
const config = (): string => {
  const at = rest.findIndex((arg) => arg === "--config" || arg === "-c");

  return (at === -1 ? undefined : rest[at + 1]) ?? SERVER_CONFIG;
};

// `wrangler types` only reads the configuration, and `wrangler d1` (`site:migrate`) only talks to
// the database; the commands that bundle the Worker take defines.
const built =
  command === "types" || command === "d1"
    ? []
    : Object.entries(defines(config())).flatMap(([name, value]) => [
        "--define",
        `${name}:${value}`,
      ]);

const SECRETS_FILE = new URL("../.dev.secrets", import.meta.url);

/**
 * `KEY=value` lines of the git-ignored hosted/.dev.secrets (Stripe's test keys), for `dev` only.
 * They go in as `--var`: Wrangler reads process.env only when no .dev.vars exists, and this
 * directory's is committed.
 */
const localSecrets = (): string[] => {
  if (command !== "dev" || !existsSync(SECRETS_FILE)) {
    return [];
  }

  return readFileSync(SECRETS_FILE, "utf-8")
    .split("\n")
    .flatMap((raw) => {
      const line = raw.trim();
      const at = line.indexOf("=");

      return line.startsWith("#") || at < 1
        ? []
        : ["--var", `${line.slice(0, at)}:${line.slice(at + 1)}`];
    });
};

// pnpm puts node_modules/.bin on the PATH of the scripts it runs.
const { status, error } = spawnSync(
  "wrangler",
  [command, ...rest, ...built, ...localSecrets()],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  }
);

if (error) {
  throw error;
}

process.exitCode = status ?? 1;
