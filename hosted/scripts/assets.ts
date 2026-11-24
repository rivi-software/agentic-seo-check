/**
 * Writes the website's fixed files into hosted/.generated/assets/, which both Workers serve as
 * Workers Static Assets (issue #202): the website's from its hostname, before its code runs, and
 * the MCP server's under `hosted:dev` only, where it answers every path itself (src/index.ts). A
 * request for one costs no Worker invocation and no CPU, and Cloudflare's asset server sends the
 * ETag and the 304 that src/fresh.ts sends for a page. Each configuration's `build.command` runs it
 * before each build. The directory is not committed.
 *   node scripts/assets.ts
 *
 * - /site.js, the pages' script (src/site/files.ts), and /favicon.svg, the mark (src/brand.ts).
 * - /ph.js, posthog-js's slim ES module build, which loads no other script, with the three
 *   extensions the pages turn on and nothing else: Web Vitals, error tracking and session replay,
 *   the first two with the code the full build would fetch from PostHog's CDN, which the
 *   Content-Security-Policy keeps out (issue #57). The module exports them as `EXTENSIONS`, for
 *   `posthog.init`'s `__extensionClasses`, then the project's token and the ingestion host,
 *   `POSTHOG_HOST` of the website's configuration. /ph-recorder.js is the recorder session replay
 *   would fetch from that CDN (rrweb and the code that drives it, issue #181), some 220 kB, which
 *   the pages load only when a recording starts. Both are left out while `POSTHOG_HOST` is empty.
 * - /pdfmake.js, pdfmake's browser build without the line that names its source map, followed by
 *   the code that draws a report's PDF (src/site/pdf-script.ts) as `drawReportPdf` (issue #157),
 *   and the PDF's fonts under PDF_FONT_DIR: static TrueType instances of Geist, Geist Mono and
 *   Bricolage Grotesque (assets/pdf/, SIL OFL 1.1).
 * - The pages' fonts (FONT_PATHS) and the two share images (src/ui/og.ts), from assets/.
 * - _headers, the headers Cloudflare adds to each: the website's security headers, `no-cache` on
 *   a file that keeps its address when a deploy changes it (issue #160), a year on a font, which
 *   takes a new path when it changes, and a day on a share image, which keeps its address when the
 *   card is drawn again.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import type * as Sources from "./asset-sources.ts";
import { defines, readConfig, SITE_CONFIG } from "./defines.ts";

const hosted = new URL("../", import.meta.url);
const target = new URL(".generated/assets/", hosted);

/** The Worker's modules this script reads (asset-sources.ts), bundled for Node with the build's defines. */
const loadSources = async () => {
  const bundled = fileURLToPath(
    new URL(`.generated/asset-sources.${process.pid}.mjs`, hosted)
  );

  await build({
    entryPoints: [fileURLToPath(new URL("scripts/asset-sources.ts", hosted))],
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "warning",
    outfile: bundled,
    define: defines(SITE_CONFIG),
    // The modules only workerd has, which src/state.ts and src/crawls.ts import, as the tests
    // stand in for them (vitest.config.ts).
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("stubs/cloudflare-workers.ts", hosted)
      ),
      "cloudflare:workflows": fileURLToPath(
        new URL("stubs/cloudflare-workflows.ts", hosted)
      ),
    },
  });

  try {
    // SAFETY: the bundle of asset-sources.ts, just built.
    return (await import(bundled)) as typeof Sources;
  } finally {
    rmSync(bundled);
  }
};

const {
  DRAW_PDF,
  FONT_PATHS,
  MARK_SVG,
  PDF_FONT_DIR,
  PDF_FONTS,
  PDFMAKE_PATH,
  POSTHOG_TOKEN,
  SECURITY,
  SERVER_CARD,
  SITE_CARD,
  SITE_JS,
} = await loadSources();

/**
 * Writes `contents` at `at` under the directory: to a file beside it first, then renamed, so the
 * other Worker's build, which writes the same files, or its dev server never reads half a file.
 */
const write = (at: string, contents: string | Uint8Array): void => {
  const file = fileURLToPath(new URL(`.${at}`, target));
  const draft = `${file}.${process.pid}.tmp`;

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(draft, contents);
  renameSync(draft, file);
};

const copy = (at: string, from: string): void => {
  write(at, readFileSync(new URL(from, hosted)));
};

const POSTHOG_ENTRY = `
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

/** The recorder adds itself to `window.__PosthogExtensions__`, where session replay looks for it. */
const RECORDER_ENTRY = `import "posthog-js/dist/lazy-recorder";`;

/** `contents` bundled for the browser and minified. esbuild's bundle names no source map. */
const bundle = async (
  contents: string,
  format: "esm" | "iife"
): Promise<string> => {
  const { outputFiles } = await build({
    stdin: { contents, resolveDir: fileURLToPath(hosted) },
    bundle: true,
    format,
    platform: "browser",
    minify: true,
    logLevel: "warning",
    write: false,
  });

  return outputFiles.map((output) => output.text).join("");
};

/** The ingestion host the pages start posthog-js with; the analytics are off while it is empty. */
const posthogHost = (): string => {
  // Wrangler's types for its config come from a package it bundles, so they arrive untyped here;
  // configs.test.ts holds the var to a string.
  const host: string | undefined = readConfig(SITE_CONFIG).vars["POSTHOG_HOST"];

  return host ?? "";
};

const writePosthog = async (host: string): Promise<void> => {
  const [source, recorder] = await Promise.all([
    bundle(POSTHOG_ENTRY, "esm"),
    bundle(RECORDER_ENTRY, "iife"),
  ]);

  write(
    "/ph.js",
    `${source}\nexport const TOKEN = ${JSON.stringify(POSTHOG_TOKEN)};\nexport const API_HOST = ${JSON.stringify(host)};\n`
  );
  write("/ph-recorder.js", recorder);
};

const writePdf = (): void => {
  const pdfmake = readFileSync(
    fileURLToPath(import.meta.resolve("pdfmake/build/pdfmake.min.js")),
    "utf-8"
  ).replace(/\/\/# sourceMappingURL=\S*\s*$/u, "");

  write(
    PDFMAKE_PATH,
    `${pdfmake}
;globalThis.drawReportPdf = (report) =>
  (${DRAW_PDF})(globalThis.pdfMake, report, location.origin + ${JSON.stringify(PDF_FONT_DIR)});
`
  );

  const files = new Set(
    Object.values(PDF_FONTS).flatMap(({ normal, bold }) => [normal, bold])
  );

  for (const name of files) {
    copy(`${PDF_FONT_DIR}${name}`, `assets/pdf/${name}`);
  }
};

/** The rules of _headers: a path, then each header on its own line, indented. */
const headerRules = (rules: [string, Record<string, string>][]): string =>
  rules
    .map(
      ([at, headers]) =>
        `${at}\n${Object.entries(headers)
          .map(([name, value]) => `  ${name}: ${value}`)
          .join("\n")}\n`
    )
    .join("");

const FRESH = { "cache-control": "no-cache" };

const host = posthogHost();

write("/site.js", SITE_JS);

write("/favicon.svg", MARK_SVG);

for (const font of Object.values(FONT_PATHS)) {
  copy(font, `assets/${path.basename(font)}`);
}

for (const card of [SITE_CARD, SERVER_CARD]) {
  copy(card.path, `assets/${card.file}`);
}

writePdf();

if (host) {
  await writePosthog(host);
} else {
  // A build before this one may have written them with a host.
  rmSync(new URL("ph.js", target), { force: true });
  rmSync(new URL("ph-recorder.js", target), { force: true });
}

write(
  "/_headers",
  headerRules([
    ["/*", SECURITY],
    ["/site.js", FRESH],
    ["/favicon.svg", FRESH],
    [PDFMAKE_PATH, FRESH],
    ["/ph.js", FRESH],
    ["/ph-recorder.js", FRESH],
    ["/fonts/*", { "cache-control": "public, max-age=31536000, immutable" }],
    [SITE_CARD.path, { "cache-control": "public, max-age=86400" }],
    [SERVER_CARD.path, { "cache-control": "public, max-age=86400" }],
  ])
);
