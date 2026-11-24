/**
 * The premium server's lab performance (issue #222): Lighthouse on Google's PageSpeed Insights, with
 * RIVI Software's own key, the optional Worker secret PSI_API_KEY, so a subscriber needs none. Each
 * run is kept for a day in the Cache API's `psi` cache, under a hash of the page's URL and the
 * strategy (src/core/psi.ts), so no URL is in the cache's keys and a page asked for again costs no
 * second run.
 */
import { LabUnavailableError, pageSpeedInsights } from "../../src/core/psi.js";
import type { LabRunner } from "../../src/core/psi.js";
import { dayCache } from "./crux.js";

export interface PsiEnv {
  /**
   * RIVI Software's PageSpeed Insights API key, a Worker secret, from the Google Cloud project that
   * has the Chrome UX Report's. Without it, a subscriber's `lighthouse` says lab performance is not
   * set up.
   */
  PSI_API_KEY?: string;
}

/** The lab of the Worker on `origin`: PageSpeed Insights with its key and cache, or a refusal without a key. */
export const labRunner = (env: PsiEnv, origin: string): LabRunner => {
  const apiKey = env.PSI_API_KEY;

  if (!apiKey) {
    return () =>
      Promise.reject(
        new LabUnavailableError("Lab performance is not set up on this server.")
      );
  }

  const cache = dayCache("psi", origin);

  return (url, formFactor) =>
    pageSpeedInsights(url, formFactor, { apiKey, cache });
};
