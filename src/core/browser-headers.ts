import { headersGoTo } from "./fetch.js";

/** A request header as the Chrome DevTools Protocol's Fetch domain takes it. */
export interface HeaderEntry {
  name: string;
  value: string;
}

/**
 * The headers a browser's request to `requestUrl` goes out with, when the user gave `headers` (a
 * staging password, a cookie) for the audit of `auditedUrl`: with them to the audited origin, and
 * without them to any other. A browser's own setting for extra headers puts them on every request
 * a page makes, its third-party scripts, fonts and images included, and carries them along a
 * redirect, so `--render` and `--lighthouse` ask for each request instead, a redirect's included.
 * A header the page itself set for another origin stays: only the user's values are held back.
 */
export const browserRequestHeaders = (
  requestHeaders: Record<string, string>,
  requestUrl: string,
  headers: Record<string, string>,
  auditedUrl: string
): HeaderEntry[] => {
  const sent = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );

  const own = headersGoTo(requestUrl, auditedUrl);

  // To the audited origin the user's value replaces the page's; elsewhere only a value that is
  // the user's, which a redirect carried over, is taken out.
  const kept = Object.entries(requestHeaders).filter(([name, value]) => {
    const given = sent.get(name.toLowerCase());

    return given === undefined || (!own && given !== value);
  });

  return [...kept, ...(own ? Object.entries(headers) : [])].map(
    ([name, value]) => ({ name, value })
  );
};

/** Whether the user gave any header to send. */
export const hasHeaders = (
  headers: Record<string, string> | undefined
): headers is Record<string, string> =>
  headers !== undefined && Object.keys(headers).length > 0;
