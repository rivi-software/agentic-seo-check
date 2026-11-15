import { POSTHOG_TOKEN } from "../../../src/telemetry/posthog.js";
/**
 * posthog-js for the website's analytics (issue #57), served at /ph.js so that
 * the Content-Security-Policy keeps `script-src 'self'`. It is the slim ES module build, which loads
 * no other script, with the Web Vitals, error tracking and session replay extensions bundled in and
 * exported as `EXTENSIONS`, at the version the lockfile pins, built into .generated/posthog-js.txt
 * before each build (scripts/posthog-js.ts) so that Wrangler bundles it as text. Session replay's
 * recorder (issue #181) is served apart, at /ph-recorder.js, for the pages to load only when a
 * recording starts. Only the routes import this module: Node runs the pages' tests and cannot import it.
 */
import SOURCE from "../../.generated/posthog-js.txt";
import RECORDER from "../../.generated/posthog-recorder.txt";
import { freshResponse } from "../fresh.js";

const modules = new Map<string, string>();

/**
 * The module the pages import: posthog-js, with the project's token and the ingestion host to start
 * it with as two more exports. esbuild's bundle names no source map (the tests hold it to that).
 */
const posthogModule = (host: string): string => {
  let text = modules.get(host);

  if (!text) {
    text = `${SOURCE}\nexport const TOKEN = ${JSON.stringify(POSTHOG_TOKEN)};\nexport const API_HOST = ${JSON.stringify(host)};\n`;
    modules.set(host, text);
  }

  return text;
};

/** The files at their paths, each as its text for the ingestion host. */
const FILES = new Map<string, (host: string) => string>([
  ["/ph.js", posthogModule],
  ["/ph-recorder.js", () => RECORDER],
]);

/**
 * /ph.js, or /ph-recorder.js (session replay's recorder, a script that adds rrweb and the code that
 * drives it to `window.__PosthogExtensions__`), at `path`. Null at any other path, and while the
 * analytics are off (`POSTHOG_HOST` empty): the pages then load nothing. The addresses stay when a
 * deploy brings another posthog-js, so browsers ask for them again.
 */
export const posthogFileResponse = (
  request: Request,
  path: string,
  host: string
): Promise<Response> | null => {
  const body = FILES.get(path);

  return host && body
    ? freshResponse(request, body(host), {
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
      })
    : null;
};
