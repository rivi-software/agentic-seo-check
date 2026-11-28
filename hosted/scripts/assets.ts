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
import { defines, readConfig, SITE_CONFIG, WORKERD_STUBS } from "./defines.ts";

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
    alias: WORKERD_STUBS,
  });

  try {
    // SAFETY: the bundle of asset-sources.ts, just built.
    return (await import(bundled)) as typeof Sources;
  } finally {
    rmSync(bundled);
  }
};

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

// The ingestion host the pages start posthog-js with; the analytics are off while it is empty.
// Wrangler's types for its config come from a package it bundles, so they arrive untyped here;
// configs.test.ts holds the var to a string.
const host: string = readConfig(SITE_CONFIG).vars["POSTHOG_HOST"] ?? "";

// posthog-js and its recorder bundle while the Worker's modules do.
const [sources, posthog] = await Promise.all([
  loadSources(),
  host
    ? Promise.all([
        bundle(POSTHOG_ENTRY, "esm"),
        bundle(RECORDER_ENTRY, "iife"),
      ])
    : null,
]);

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
} = sources;

/** How long a browser keeps a file: each file below names one. */
const CACHE = {
  // Keeps its address when a deploy changes it, so browsers ask on every visit (issue #160).
  fresh: "no-cache",
  // Takes a new path when it changes.
  immutable: "public, max-age=31536000, immutable",
  // A share image keeps its address when the card is drawn again.
  day: "public, max-age=86400",
} as const;

/** A file at `path`: its bytes, or the file under hosted/ to copy them from. */
type AssetFile = { path: string; cache: keyof typeof CACHE } & (
  | { contents: string | Uint8Array }
  | { from: string }
);

const pdfmake = readFileSync(
  fileURLToPath(import.meta.resolve("pdfmake/build/pdfmake.min.js")),
  "utf-8"
).replace(/\/\/# sourceMappingURL=\S*\s*$/u, "");

const pdfFonts = new Set(
  Object.values(PDF_FONTS).flatMap(({ normal, bold }) => [normal, bold])
);

const FILES: AssetFile[] = [
  { path: "/site.js", contents: SITE_JS, cache: "fresh" },
  { path: "/favicon.svg", contents: MARK_SVG, cache: "fresh" },
  {
    path: PDFMAKE_PATH,
    contents: `${pdfmake}
;globalThis.drawReportPdf = (report) =>
  (${DRAW_PDF})(globalThis.pdfMake, report, location.origin + ${JSON.stringify(PDF_FONT_DIR)});
`,
    cache: "fresh",
  },
  ...Object.values(FONT_PATHS).map((font) => ({
    path: font,
    from: `assets/${path.basename(font)}`,
    cache: "immutable" as const,
  })),
  ...[...pdfFonts].map((name) => ({
    path: `${PDF_FONT_DIR}${name}`,
    from: `assets/pdf/${name}`,
    cache: "immutable" as const,
  })),
  ...[SITE_CARD, SERVER_CARD].map((card) => ({
    path: card.path,
    from: `assets/${card.file}`,
    cache: "day" as const,
  })),
];

const POSTHOG_PATHS = ["/ph.js", "/ph-recorder.js"];

if (posthog) {
  const [source, recorder] = posthog;

  FILES.push(
    {
      path: "/ph.js",
      contents: `${source}\nexport const TOKEN = ${JSON.stringify(POSTHOG_TOKEN)};\nexport const API_HOST = ${JSON.stringify(host)};\n`,
      cache: "fresh",
    },
    { path: "/ph-recorder.js", contents: recorder, cache: "fresh" }
  );
} else {
  // A build before this one may have written them with a host.
  for (const at of POSTHOG_PATHS) {
    rmSync(new URL(`.${at}`, target), { force: true });
  }
}

for (const file of FILES) {
  write(
    file.path,
    "from" in file ? readFileSync(new URL(file.from, hosted)) : file.contents
  );
}

write(
  "/_headers",
  headerRules([
    ["/*", SECURITY],
    ...FILES.map((file): [string, Record<string, string>] => [
      file.path,
      { "cache-control": CACHE[file.cache] },
    ]),
  ])
);
