/**
 * What scripts/assets.ts writes into the website's static assets from the Worker's own modules.
 * It bundles this file with esbuild and imports the bundle: those modules reach src/state.ts, which
 * imports `cloudflare:workers`, a module only workerd has, so Node cannot import them as they are.
 */
export { MARK_SVG } from "../../src/brand.js";

export { POSTHOG_TOKEN } from "../../src/telemetry/posthog.js";

export { PDFMAKE_PATH, SITE_JS } from "../src/site/files.js";

export { DRAW_PDF } from "../src/site/pdf-script.js";

export { PDF_FONT_DIR, PDF_FONTS } from "../src/site/pdf.js";

export { SECURITY } from "../src/site/respond.js";

export { SERVER_CARD, SITE_CARD } from "../src/ui/og.js";

export { FONT_PATHS } from "../src/ui/style.js";
