/**
 * Lab performance from Google's PageSpeed Insights API (issue #222): Lighthouse run on Google's
 * servers, for a server that cannot launch Chrome itself. The answer's `lighthouseResult` has the
 * shape of a Lighthouse result, so `summarize` reads it as it reads a local run. The page's URL
 * goes to Google in the request and nowhere else: not into an error message and not into a cache
 * key.
 */
import { z } from "zod";

import { ExpectedError } from "./errors.js";
import type { FieldDataCache } from "./field-data.js";
import type { LhrLike } from "./lighthouse.js";

/** The one endpoint of the PageSpeed Insights API: a GET with the page's URL in `url`. */
export const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/** A run takes Google's servers a while: a mobile run of a heavy page can take half a minute. */
const TIMEOUT_MS = 60_000;

/** Runs the lab for a page: `pageSpeedInsights` on the hosted server. Any failure it expects is an ExpectedError. */
export type LabRunner = (
  url: string,
  formFactor: "mobile" | "desktop"
) => Promise<LhrLike>;

export interface PsiOptions {
  /** A Google API key with the PageSpeed Insights API enabled. */
  apiKey: string;
  /** Keeps answers, so that one run serves many audits: the hosted server keeps each for a day. */
  cache?: FieldDataCache;
  /** The `fetch` to ask with, for a test. */
  fetch?: typeof fetch;
}

/** The lab could not run: the quota is used up, Google is down, or no key is set. */
export class LabUnavailableError extends ExpectedError {
  override name = "LabUnavailableError";
}

/** The key a run is kept under: a hash of the URL and the strategy, never the URL or the API key. */
const cacheKey = async (
  url: string,
  formFactor: "mobile" | "desktop"
): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url)
  );

  const hash = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `psi:v1:${formFactor}:${hash}`;
};

/** A message with every URL in it taken out: PSI's words about a failed page quote the page. */
const withoutUrls = (message: string): string =>
  message.replaceAll(/https?:\/\/[^\s)"']+/gu, "the page");

const LhrCheck = z.looseObject({
  audits: z.record(z.string(), z.unknown()),
  categories: z.record(z.string(), z.unknown()),
});

/** A Lighthouse result: checked for audits and categories, which `summarize` reads leniently. */
const LabResult = z.custom<LhrLike>(
  (value) => LhrCheck.safeParse(value).success
);

const PsiAnswer = z.object({ lighthouseResult: LabResult });

const readKept = async (
  cache: FieldDataCache | undefined,
  key: string
): Promise<LhrLike | undefined> => {
  try {
    const kept = await cache?.get(key);

    if (kept === undefined) {
      return undefined;
    }

    const parsed = LabResult.safeParse(JSON.parse(kept));

    return parsed.success ? parsed.data : undefined;
  } catch {
    // A cache that fails, or an entry that does not read, is a miss: the run is asked for.
    return undefined;
  }
};

/** Asks PageSpeed Insights for the lab result of `url`, from its own cache first when given one. */
export const pageSpeedInsights = async (
  url: string,
  formFactor: "mobile" | "desktop",
  options: PsiOptions
): Promise<LhrLike> => {
  const key = await cacheKey(url, formFactor);
  const kept = await readKept(options.cache, key);

  if (kept) {
    return kept;
  }

  const query = new URLSearchParams({
    url,
    strategy: formFactor === "desktop" ? "DESKTOP" : "MOBILE",
  });

  query.append("category", "PERFORMANCE");
  query.append("category", "SEO");
  query.set("key", options.apiKey);

  let res: Response;

  try {
    res = await (options.fetch ?? fetch)(`${PSI_ENDPOINT}?${query}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LabUnavailableError(
      "PageSpeed Insights did not answer. Try again in a few minutes."
    );
  }

  if (res.status === 429) {
    throw new LabUnavailableError(
      "PageSpeed Insights is busy or its quota is used up. Try again in a few minutes."
    );
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => null);

    throw new LabUnavailableError(
      `PageSpeed Insights answered HTTP ${res.status}. Try again in a few minutes.`
    );
  }

  const parsed = PsiAnswer.safeParse(await res.json().catch(() => null));

  if (!parsed.success) {
    throw new LabUnavailableError(
      "PageSpeed Insights gave no lab result. Try again in a few minutes."
    );
  }

  const lhr = parsed.data.lighthouseResult;

  if (lhr.runtimeError && lhr.runtimeError.code !== "NO_ERROR") {
    throw new ExpectedError(
      `PageSpeed Insights could not measure the page (${lhr.runtimeError.code}): ${withoutUrls(lhr.runtimeError.message)}`
    );
  }

  try {
    await options.cache?.put(key, JSON.stringify(lhr));
  } catch {
    // Not kept, so a later audit asks again; this one has its answer.
  }

  return lhr;
};
