import { POSTHOG_TOKEN } from "../../../src/telemetry/posthog.js";
/**
 * posthog-js for the website's analytics (issue #57), served at /ph.js so that
 * the Content-Security-Policy keeps `script-src 'self'`. It is the ES module build that loads no
 * other script ("slim", "no-external"), at the version the lockfile pins, copied to
 * .generated/posthog-js.txt before each build (scripts/posthog-js.ts) so that Wrangler bundles it
 * as text. Only the routes import this module: Node runs the pages' tests and cannot import it.
 */
import SOURCE from "../../.generated/posthog-js.txt";
import { freshResponse } from "../fresh.js";

/** The bundle's last line names a source map the Worker does not serve. */
const SOURCE_MAP = /\/\/# sourceMappingURL=\S*\s*$/u;

const modules = new Map<string, string>();

/**
 * The module the pages import: posthog-js, with the project's token and the ingestion host to start
 * it with as two more exports.
 */
const posthogModule = (host: string): string => {
  let text = modules.get(host);

  if (!text) {
    text = `${SOURCE.replace(SOURCE_MAP, "")}\nexport const TOKEN = ${JSON.stringify(POSTHOG_TOKEN)};\nexport const API_HOST = ${JSON.stringify(host)};\n`;
    modules.set(host, text);
  }

  return text;
};

/**
 * /ph.js, or null while the analytics are off (`POSTHOG_HOST` empty): the pages then load nothing.
 * Its address stays when a deploy brings another posthog-js, so browsers ask for it again.
 */
export const posthogResponse = (
  request: Request,
  host: string
): Promise<Response> | null =>
  host
    ? freshResponse(request, posthogModule(host), {
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
      })
    : null;
