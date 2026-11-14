/**
 * Builds posthog-js for the website, at the version the lockfile pins, into hosted/.generated/,
 * which the Worker bundles as text and serves (src/ui/posthog-script.ts, issue #57): posthog-js.txt
 * at /ph.js and posthog-recorder.txt at /ph-recorder.js. Wrangler runs it before each build, as
 * wrangler.jsonc's `build.command`: its bundler takes a .js file as code whatever the rules say,
 * and a .txt file as text. The build is not committed.
 *
 * /ph.js is posthog-js's slim build, which loads no other script, with the three extensions the
 * pages turn on and nothing else: Web Vitals, error tracking and session replay, the first two with
 * the code the full build would fetch from PostHog's CDN, which the Content-Security-Policy keeps
 * out. The module exports them as `EXTENSIONS`, for `posthog.init`'s `__extensionClasses`.
 * /ph-recorder.js is the recorder session replay would fetch from that CDN (rrweb and the code that
 * drives it, issue #181), some 220 kB, which the pages load only when a recording starts.
 *   node scripts/posthog-js.ts
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ENTRY = `
import "posthog-js/dist/web-vitals";
import "posthog-js/dist/exception-autocapture";
import posthog from "posthog-js/dist/module.slim.no-external";
import {
  AnalyticsExtensions,
  ErrorTrackingExtensions,
  SessionReplayExtensions,
} from "posthog-js/dist/extension-bundles";

export const EXTENSIONS = {
  webVitalsAutocapture: AnalyticsExtensions.webVitalsAutocapture,
  ...ErrorTrackingExtensions,
  ...SessionReplayExtensions,
};

export default posthog;
`;

/** The recorder adds itself to \`window.__PosthogExtensions__\`, where session replay looks for it. */
const RECORDER_ENTRY = `import "posthog-js/dist/lazy-recorder";`;

const root = fileURLToPath(new URL("..", import.meta.url));
const target = new URL("../.generated/", import.meta.url);

mkdirSync(target, { recursive: true });

const bundle = (contents: string, format: "esm" | "iife", file: string) =>
  build({
    stdin: { contents, resolveDir: root, sourcefile: `${file}.js` },
    bundle: true,
    format,
    platform: "browser",
    minify: true,
    logLevel: "warning",
    outfile: fileURLToPath(new URL(`${file}.txt`, target)),
  });

await Promise.all([
  bundle(ENTRY, "esm", "posthog-js"),
  bundle(RECORDER_ENTRY, "iife", "posthog-recorder"),
]);
