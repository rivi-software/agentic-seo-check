/**
 * Copies posthog-js's browser build, at the version the lockfile pins, to
 * hosted/.generated/posthog-js.txt, which the Worker bundles as text and serves at /ph.js
 * (src/ui/posthog-script.ts, issue #57). Wrangler runs it before each build, as wrangler.jsonc's
 * `build.command`: its bundler takes a .js file as code whatever the rules say, and a .txt file
 * as text. The copy is not committed.
 *   node scripts/posthog-js.ts
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  import.meta.resolve("posthog-js/dist/module.slim.no-external.js")
);

const target = new URL("../.generated/", import.meta.url);

mkdirSync(target, { recursive: true });

copyFileSync(source, new URL("posthog-js.txt", target));
