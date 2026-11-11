/**
 * Usage analytics in PostHog (issue #57): the project, and the one way events leave, shared by the
 * CLI, the local MCP server and the hosted server. It runs in Node and in a Worker, so it does no
 * Node-only work and needs no PostHog SDK: an event is a JSON object sent to the capture API.
 */
import { VERSION } from "../version.js";
import type { ExceptionEntry } from "./exceptions.js";

/**
 * The "Agentic SEO" project on PostHog Cloud EU. A project token can only send events, and every
 * page that loads posthog-js shows it, so it is public by design and lives here, not in a secret.
 */
export const POSTHOG_TOKEN = "phc_qodC2xP7RSMQH2zDUh5VhNHvXebc52o4mg5RKoGxFASK";

/** Where events go: PostHog's EU ingestion host. */
export const POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * A property's value: what these events carry is flat, as PostHog's MCP Analytics wants it, but for
 * the list of errors of an `$exception` event (exceptions.ts).
 */
export type PropertyValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly ExceptionEntry[];

/** One event as PostHog's batch endpoint takes it. */
export interface PostHogEvent {
  event: string;
  /** When it happened, in ISO 8601; PostHog uses the time it arrived without it. */
  timestamp?: string;
  properties: Record<string, PropertyValue | undefined> & {
    distinct_id: string;
  };
}

/**
 * The properties every event this package sends carries: which library sent it, and no person
 * profile and no location, since nothing it sends is about a person.
 */
export const BASE_PROPERTIES = {
  $lib: "agentic-seo-check",
  $lib_version: VERSION,
  $process_person_profile: false,
  $geoip_disable: true,
} as const;

/** Hex of each byte, two digits. */
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A UUIDv7 (RFC 9562): the time in milliseconds, then random bits. PostHog's session ids are
 * `ses_` and one of these.
 */
export const uuidv7 = (now = Date.now()): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }

  // The version (7) in the high four bits of byte 6, the variant (10) in the high two of byte 8.
  bytes[6] = 0x70 + ((bytes[6] ?? 0) % 0x10);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 0x40);

  const text = hex(bytes);

  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};

/** A string property as PostHog's MCP Analytics wants names, versions and headers: 256 characters at most. */
export const short = (value: string | undefined): string | undefined =>
  value ? value.slice(0, 256) : undefined;

export interface SendOptions {
  /** PostHog's ingestion host; the hosted server's tests point it at their own. */
  host?: string;
  /** How long the send may take before it is given up. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Sends `events` to PostHog's batch endpoint. Analytics never cost the user anything: a send that
 * fails or takes longer than `timeoutMs` is dropped, and this never throws.
 */
export const sendEvents = async (
  events: PostHogEvent[],
  options: SendOptions = {}
): Promise<boolean> => {
  if (events.length === 0) {
    return true;
  }

  try {
    const response = await (options.fetch ?? fetch)(
      `${options.host ?? POSTHOG_HOST}/batch/`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: POSTHOG_TOKEN, batch: events }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      }
    );

    await response.body?.cancel();

    return response.ok;
  } catch {
    return false;
  }
};
