/**
 * Real-user Core Web Vitals from the Chrome UX Report (CrUX, issue #130). Google measures LCP, INP
 * and CLS on real visits in Chrome and says this "aligns with what our core ranking systems seek to
 * reward"; the CrUX API gives each URL or origin with enough visits the 75th percentile over the
 * last 28 days. The query goes to Google, never to the audited site, and a URL on localhost, a
 * private network or behind a login (`headers`) is never sent.
 */
import { z } from "zod";

import { mapConcurrent } from "./concurrency.js";
import { ExpectedError } from "./errors.js";
import { privateUrlKind } from "./hosted.js";
import type { PageRecord } from "./site-rules.js";
import type {
  FieldData,
  FieldMetric,
  NoFieldData,
  ResponseInfo,
} from "./types.js";
import { normalizeUrl } from "./url.js";

/** The one endpoint of the CrUX API: a POST with one URL or origin, the key in `key`. */
export const CRUX_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

/** Google indexes the mobile version of a page, so its phone visits are the ones that count. */
const FORM_FACTOR = "PHONE";

/** The pages of a crawl whose own record an audit asks for, the start page first. */
export const FIELD_DATA_PAGES = 10;

const TIMEOUT_MS = 10_000;

/** Where a key comes from, for the error that says one is missing or refused. */
const KEY_HELP =
  "Create a free API key at https://console.cloud.google.com/apis/credentials, in a Google Cloud project with the Chrome UX Report API enabled (https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com), and set it as the environment variable CRUX_API_KEY.";

/**
 * Keeps the API's answers, so that one query serves many audits: the hosted server keeps each for a
 * day, as CrUX changes once a day. `key` names the query, never the API key.
 */
export interface FieldDataCache {
  get: (key: string) => Promise<string | undefined>;
  put: (key: string, value: string) => Promise<void>;
}

export interface FieldDataOptions {
  /** A Chrome UX Report API key; the environment's CRUX_API_KEY when left out. */
  apiKey?: string;
  cache?: FieldDataCache;
  /** In a crawl, the pages whose own URL record is asked for, the start page first (default 10). */
  maxPages?: number;
}

/** The options once the key is known: what the queries are sent with. */
type ResolvedOptions = FieldDataOptions & { apiKey: string };

/** No key, or a key the API refuses: the user's to fix, so the audit stops and says how. */
export class FieldDataKeyError extends ExpectedError {
  override name = "FieldDataKeyError";
}

/** The metrics of `FieldData`, in the order a report lists them. */
export const FIELD_METRICS = [
  "lcpMs",
  "inpMs",
  "cls",
  "fcpMs",
  "ttfbMs",
] as const;

export type FieldMetricKey = (typeof FIELD_METRICS)[number];

/** The Core Web Vitals among them, which the `perf.field-*` rules judge. */
export const CORE_VITALS = ["lcpMs", "inpMs", "cls"] as const;

/** Each metric's short name in a report. */
export const FIELD_LABELS: Record<FieldMetricKey, string> = {
  lcpMs: "LCP",
  inpMs: "INP",
  cls: "CLS",
  fcpMs: "FCP",
  ttfbMs: "TTFB",
};

/**
 * Google's thresholds at the 75th percentile (web.dev): good up to the first, poor above the
 * second. LCP, INP and CLS are the Core Web Vitals; FCP and TTFB help find a slow LCP's cause.
 */
export const FIELD_THRESHOLDS: Record<
  FieldMetricKey,
  readonly [good: number, poor: number]
> = {
  lcpMs: [2500, 4000],
  inpMs: [200, 500],
  cls: [0.1, 0.25],
  fcpMs: [1800, 3000],
  ttfbMs: [800, 1800],
};

export type FieldBand = "good" | "needs improvement" | "poor";

/** How Google rates a metric's 75th percentile. */
export const fieldBand = (key: FieldMetricKey, p75: number): FieldBand => {
  const [good, poor] = FIELD_THRESHOLDS[key];

  if (p75 <= good) {
    return "good";
  }

  return p75 <= poor ? "needs improvement" : "poor";
};

/**
 * A metric's value as a report or a finding shows it: whole milliseconds ("2,543 ms"), so a value
 * just over a threshold never reads as the threshold, and CLS to two places, as CrUX gives it.
 */
export const fieldValue = (key: FieldMetricKey, value: number): string =>
  key === "cls"
    ? value.toFixed(2)
    : `${Math.round(value).toLocaleString("en-US")} ms`;

/** A share of visits as a report shows it: "82%". */
export const sharePercent = (share: number): string =>
  `${Math.round(share * 100)}%`;

/** The CrUX API's names of the metrics `FieldData` holds. */
const METRICS: Record<FieldMetricKey, string> = {
  lcpMs: "largest_contentful_paint",
  inpMs: "interaction_to_next_paint",
  cls: "cumulative_layout_shift",
  fcpMs: "first_contentful_paint",
  ttfbMs: "experimental_time_to_first_byte",
};

/** CLS comes as text ("0.05"), the times as numbers. */
const numeric = z.union([z.number(), z.string()]);

const Metric = z.object({
  histogram: z
    .array(
      z.object({
        start: numeric.optional(),
        end: numeric.optional(),
        density: z.number().optional(),
      })
    )
    .optional(),
  percentiles: z.object({ p75: numeric.optional() }).optional(),
});

const Day = z.object({ year: z.number(), month: z.number(), day: z.number() });

const RecordAnswer = z.object({
  record: z.object({
    metrics: z.record(z.string(), Metric).optional(),
    collectionPeriod: z.object({ firstDate: Day, lastDate: Day }).optional(),
  }),
});

const ErrorAnswer = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
  }),
});

/** A record as the API gives it, before the audit knows whose it is. */
type FieldRecord = Omit<FieldData, "source">;

/**
 * What the API answered one query with: a record, none (404), or nothing usable. `busy` is the
 * quota used up for the minute.
 */
type Answer =
  | { kind: "record"; record: FieldRecord }
  | { kind: "none" }
  | { kind: "unavailable"; message: string; busy?: true };

type Query = { url: string } | { origin: string };

const share = (density: number | undefined): number =>
  Math.round((density ?? 0) * 10_000) / 10_000;

const metricOf = (
  raw: z.infer<typeof Metric> | undefined
): FieldMetric | null => {
  // A missing percentile is NaN here.
  const p75 = Number(raw?.percentiles?.p75);

  if (!raw?.histogram || !Number.isFinite(p75)) {
    return null;
  }

  // Three bins, in Google's order: good, needs improvement, poor.
  const [good, needsImprovement, poor] = raw.histogram;

  return {
    p75,
    good: share(good?.density),
    needsImprovement: share(needsImprovement?.density),
    poor: share(poor?.density),
  };
};

const dayOf = (d: z.infer<typeof Day>): string =>
  `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

const recordOf = (answer: z.infer<typeof RecordAnswer>): FieldRecord => {
  const { metrics = {}, collectionPeriod } = answer.record;

  const metric = (key: FieldMetricKey): FieldMetric | null =>
    metricOf(metrics[METRICS[key]]);

  return {
    formFactor: FORM_FACTOR,
    period: collectionPeriod
      ? {
          firstDate: dayOf(collectionPeriod.firstDate),
          lastDate: dayOf(collectionPeriod.lastDate),
        }
      : { firstDate: "", lastDate: "" },
    lcpMs: metric("lcpMs"),
    inpMs: metric("inpMs"),
    cls: metric("cls"),
    fcpMs: metric("fcpMs"),
    ttfbMs: metric("ttfbMs"),
  };
};

/** The key a query's answer is kept under: what it asks for, never the API key. */
const cacheKey = (query: Query): string =>
  `crux:v1:${FORM_FACTOR}:${"url" in query ? `url:${query.url}` : `origin:${query.origin}`}`;

/** The API's own words for an error answer, or its status when it gave none. */
const errorMessage = async (res: Response): Promise<string> => {
  const parsed = ErrorAnswer.safeParse(await res.json().catch(() => null));

  return parsed.success && parsed.data.error.message
    ? `${res.status}: ${parsed.data.error.message}`
    : `HTTP ${res.status}`;
};

/**
 * The key was refused: 400 with "API key" in the message (an invalid key), 401, or 403 (the API is
 * not enabled for its project, or the key is restricted to other APIs or referrers).
 */
const keyRefused = (status: number, message: string): boolean =>
  status === 401 ||
  status === 403 ||
  (status === 400 && /api key/iu.test(message));

/** Sends one query; a key the API refuses throws, anything else it cannot use is `unavailable`. */
const send = async (query: Query, apiKey: string): Promise<Answer> => {
  let res: Response;

  try {
    res = await fetch(`${CRUX_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        ...query,
        formFactor: FORM_FACTOR,
        metrics: Object.values(METRICS),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      kind: "unavailable",
      message: `The Chrome UX Report API did not answer: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  // No record: too few visits, or a URL that is not public.
  if (res.status === 404) {
    await res.body?.cancel();

    return { kind: "none" };
  }

  if (!res.ok) {
    const message = await errorMessage(res);

    if (keyRefused(res.status, message)) {
      throw new FieldDataKeyError(
        `The Chrome UX Report API refused the API key (${message}). ${KEY_HELP}`
      );
    }

    return res.status === 429
      ? {
          kind: "unavailable",
          message:
            "The Chrome UX Report API's quota for this key is used up for the minute (150 queries); try again in a minute.",
          busy: true,
        }
      : {
          kind: "unavailable",
          message: `The Chrome UX Report API answered ${message}.`,
        };
  }

  const parsed = RecordAnswer.safeParse(await res.json().catch(() => null));

  return parsed.success
    ? { kind: "record", record: recordOf(parsed.data) }
    : {
        kind: "unavailable",
        message:
          "The Chrome UX Report API answered with a record this tool cannot read.",
      };
};

/** The API key from the options or the environment; none throws, saying how to get one. */
const apiKeyOf = (options: FieldDataOptions): string => {
  const key =
    options.apiKey ?? globalThis.process?.env?.["CRUX_API_KEY"]?.trim();

  if (!key) {
    throw new FieldDataKeyError(
      `Field data needs a Chrome UX Report API key. ${KEY_HELP}`
    );
  }

  return key;
};

/**
 * The options `fieldData` stands for (`true` is the defaults), with the API key from the
 * environment when they name none; undefined when field data is off. Throws without a key, so an
 * audit fails before it requests anything.
 */
export const fieldDataOptions = (
  value: boolean | FieldDataOptions | undefined
): ResolvedOptions | undefined => {
  if (!value) {
    return undefined;
  }

  const options = value === true ? {} : value;

  return { ...options, apiKey: apiKeyOf(options) };
};

type Ask = (query: Query) => Promise<Answer>;

/**
 * Asks with the cache first: a record or "none" is kept, an answer that failed is not, so a later
 * audit asks again. A query asked twice in one audit is sent once, and once the quota is used up
 * for the minute, the audit sends no more.
 */
const askerOf = ({ apiKey, cache }: ResolvedOptions): Ask => {
  const asked = new Map<string, Promise<Answer>>();
  let busy: Answer | undefined;

  const fromCache = async (key: string): Promise<Answer | undefined> => {
    let kept: string | undefined;

    try {
      kept = await cache?.get(key);
    } catch {
      // A cache that fails is one that misses: the query is sent.
    }

    if (kept === undefined) {
      return undefined;
    }

    try {
      // SAFETY: only `fresh` writes these entries, from an Answer it serialised.
      return JSON.parse(kept) as Answer;
    } catch {
      return undefined;
    }
  };

  const fresh = async (query: Query, key: string): Promise<Answer> => {
    const answer =
      (await fromCache(key)) ?? busy ?? (await send(query, apiKey));

    if (answer.kind === "unavailable") {
      busy ??= answer.busy ? answer : undefined;

      return answer;
    }

    try {
      await cache?.put(key, JSON.stringify(answer));
    } catch {
      // Not kept, so a later audit sends the query again; this one has its answer.
    }

    return answer;
  };

  return (query) => {
    const key = cacheKey(query);
    let answer = asked.get(key);

    if (!answer) {
      answer = fresh(query, key);
      asked.set(key, answer);
    }

    return answer;
  };
};

/**
 * Name endings for tests and home networks (RFC 6761, RFC 8375), and `.lan`, which no public site
 * has, beside those the hosted server's address rules know: a URL with one is never sent to Google.
 */
const RESERVED_SUFFIXES = [".test", ".home.arpa", ".lan"];

/**
 * Why `url` is never sent to the Chrome UX Report, or null when it may be: only public http(s)
 * hostnames go, and no audit that sends headers, which are for a site behind a login.
 */
export const notPublicReason = (
  url: string,
  withHeaders: boolean
): string | null => {
  if (withHeaders) {
    return "The audit sends request headers, as for a site behind a login, so its URLs are not sent to the Chrome UX Report.";
  }

  if (!URL.canParse(url)) {
    return `${url} is not a URL the Chrome UX Report can have.`;
  }

  const parsed = new URL(url);

  return privateUrlKind(parsed, RESERVED_SUFFIXES)
    ? `${parsed.hostname || url} is not a public website, so it is not sent to the Chrome UX Report.`
    : null;
};

const none = (reason: NoFieldData["reason"], message: string): NoFieldData => ({
  source: null,
  reason,
  message,
});

const NO_RECORD =
  "The Chrome UX Report has no record for this URL or its origin: too few Chrome visits on phones in the last 28 days, which says nothing against the page.";

const NO_URL_RECORD =
  "The Chrome UX Report has no record for this URL: too few Chrome visits on phones in the last 28 days. The start page's field data has its origin's.";

/** The URL CrUX keys a page by: no fragment, no tracking parameters. */
const cruxUrl = (url: string): string => normalizeUrl(url) ?? url;

/**
 * The field data of one page: why it is never sent, its URL's record, else its origin's when
 * `originToo`, else why there is none.
 */
const fieldDataOf = async (
  url: string,
  ask: Ask,
  withHeaders: boolean,
  originToo: boolean
): Promise<FieldData | NoFieldData> => {
  const notPublic = notPublicReason(url, withHeaders);

  if (notPublic) {
    return none("not-public", notPublic);
  }

  const answer = await ask({ url: cruxUrl(url) });

  if (answer.kind === "record") {
    return { source: "url", ...answer.record };
  }

  if (!originToo) {
    return answer.kind === "none"
      ? none("no-data", NO_URL_RECORD)
      : none("unavailable", answer.message);
  }

  const origin = await ask({ origin: new URL(url).origin });

  if (origin.kind === "record") {
    return { source: "origin", ...origin.record };
  }

  // A failure says more than "no record": the other query may have had one to give.
  const failed = [answer, origin].find((a) => a.kind === "unavailable");

  return failed?.kind === "unavailable"
    ? none("unavailable", failed.message)
    : none("no-data", NO_RECORD);
};

/** The field data of a page audit: its URL's record, or its origin's when the URL has none. */
export const fieldDataForPage = async (
  url: string,
  options: ResolvedOptions,
  withHeaders: boolean
): Promise<FieldData | NoFieldData> =>
  await fieldDataOf(url, askerOf(options), withHeaders, true);

/** A page that answered 2xx: one the Chrome UX Report may have, and worth a query. */
export const answeredOk = (response: ResponseInfo | undefined): boolean => {
  const status = response?.status ?? null;

  return status !== null && status >= 200 && status < 300;
};

/**
 * The field data of a crawl's first pages, by their URL: each page's own record, and the origin's
 * for the start page when it has none, so a crawl asks for the origin once at most. The queries
 * run four at a time.
 */
export const fieldDataForCrawl = async (
  records: readonly PageRecord[],
  options: ResolvedOptions,
  withHeaders: boolean
): Promise<Map<string, FieldData | NoFieldData>> => {
  const ask = askerOf(options);

  const chosen = records
    .filter((r) => answeredOk(r.response))
    .toSorted((a, b) => a.depth - b.depth)
    .slice(0, options.maxPages ?? FIELD_DATA_PAGES);

  const start = chosen.find((r) => r.depth === 0);

  const results = await mapConcurrent(
    chosen,
    4,
    async (record) =>
      await fieldDataOf(record.url, ask, withHeaders, record === start)
  );

  return new Map(
    chosen.map((record, i) => [
      record.url,
      results[i] ?? none("no-data", NO_URL_RECORD),
    ])
  );
};

/** Whether a page's field data is a record its rules read. */
export const isFieldRecord = (
  data: FieldData | NoFieldData | undefined
): data is FieldData => data !== undefined && data.source !== null;
