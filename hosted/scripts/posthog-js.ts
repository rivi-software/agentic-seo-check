/**
 * Builds posthog-js for the website, at the version the lockfile pins, into
 * hosted/.generated/posthog-js.txt, which the Worker bundles as text and serves at /ph.js
 * (src/ui/posthog-script.ts, issue #57). Wrangler runs it before each build, as wrangler.jsonc's
 * `build.command`: its bundler takes a .js file as code whatever the rules say, and a .txt file
 * as text. The build is not committed.
 *
 * It is posthog-js's slim build, which loads no other script, with the two extensions the pages
 * turn on and nothing else: Web Vitals and error tracking, each with the code the full build would
 * fetch from PostHog's CDN, which the Content-Security-Policy keeps out. The module exports them
 * as `EXTENSIONS`, for `posthog.init`'s `__extensionClasses`.
 *   node scripts/posthog-js.ts
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ENTRY = `
import "posthog-js/dist/web-vitals";
import "posthog-js/dist/exception-autocapture";
import posthog from "posthog-js/dist/module.slim.no-external";
import { AnalyticsExtensions, ErrorTrackingExtensions } from "posthog-js/dist/extension-bundles";

export const EXTENSIONS = {
  webVitalsAutocapture: AnalyticsExtensions.webVitalsAutocapture,
  ...ErrorTrackingExtensions,
};

export default posthog;
`;

const target = new URL("../.generated/", import.meta.url);

mkdirSync(target, { recursive: true });

await build({
  stdin: {
    contents: ENTRY,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    sourcefile: "posthog-entry.js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  logLevel: "warning",
  outfile: fileURLToPath(new URL("posthog-js.txt", target)),
});
