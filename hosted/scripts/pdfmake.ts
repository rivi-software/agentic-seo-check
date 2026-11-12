/**
 * Copies pdfmake's browser build, at the version the lockfile pins and without the line that
 * names its source map, which the Worker does not serve, to hosted/.generated/pdfmake.txt. The
 * website's Worker bundles it as text and serves it at /pdfmake.js for a report's PDF
 * (src/site/pdf-assets.ts, issue #157). wrangler.site.jsonc's `build.command` runs it before each
 * build, after scripts/posthog-js.ts: Wrangler's bundler takes a .js file as code whatever the
 * rules say, and a .txt file as text. The copy is not committed.
 *   node scripts/pdfmake.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  import.meta.resolve("pdfmake/build/pdfmake.min.js")
);

const target = new URL("../.generated/", import.meta.url);

mkdirSync(target, { recursive: true });

writeFileSync(
  new URL("pdfmake.txt", target),
  readFileSync(source, "utf-8").replace(/\/\/# sourceMappingURL=\S*\s*$/u, "")
);
