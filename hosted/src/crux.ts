/**
 * The hosted server's field data (issue #130): RIVI Software's own Chrome UX Report key, the Worker
 * secret CRUX_API_KEY on both Workers, so a caller needs none, and each answer kept for a day in
 * the Cache API of the Cloudflare location, since the report changes once a day. The API allows a
 * project 150 queries a minute; the cache lets that serve every caller. An entry's key is a hash
 * of the query, so no URL is in the cache's keys.
 */
import type {
  FieldDataCache,
  FieldDataOptions,
} from "../../src/core/field-data.js";
import { sha256Hex } from "./secrets.js";

export interface CruxEnv {
  /** RIVI Software's Chrome UX Report API key, a Worker secret. Without it there is no field data. */
  CRUX_API_KEY?: string;
}

/** CrUX updates once a day, around 04:00 UTC: a day's answer is the day's report. */
const DAY_SECONDS = 86_400;

/**
 * A cache of one Worker that keeps each answer for `keepSeconds`, a day unless told otherwise, in
 * the Cache API's cache `name`. Its keys are addresses on the Worker's own `origin` that are never
 * requested, since the Cache API keeps entries by URL for the zone the Worker runs on, and each
 * ends in a hash of the key given.
 */
export const dayCache = (
  name: string,
  origin: string,
  keepSeconds = DAY_SECONDS
): FieldDataCache => {
  const keyOf = async (key: string): Promise<string> =>
    `${origin}/.${name}-cache/${await sha256Hex(key)}`;

  return {
    get: async (key) => {
      const cache = await caches.open(name);
      const kept = await cache.match(await keyOf(key));

      return kept ? await kept.text() : undefined;
    },
    put: async (key, value) => {
      const cache = await caches.open(name);

      await cache.put(
        await keyOf(key),
        new Response(value, {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${keepSeconds}`,
          },
        })
      );
    },
  };
};

/** The Chrome UX Report's cache of a Worker on `origin`. */
export const cruxCache = (origin: string): FieldDataCache =>
  dayCache("crux", origin);

/** The field data options of a Worker on `origin`: its key and cache, or none without a key. */
export const cruxOptions = (
  env: CruxEnv,
  origin: string
): FieldDataOptions | undefined =>
  env.CRUX_API_KEY
    ? { apiKey: env.CRUX_API_KEY, cache: cruxCache(origin) }
    : undefined;
