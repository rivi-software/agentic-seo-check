import { RequestRefusedError } from "./fetch.js";
import type { FetchOptions } from "./fetch.js";
import { hostOf } from "./url.js";

/**
 * The requests of one audit that a gate refused (the hosted server's), and what each rules out:
 * the URL alone, its host for the rest of the audit, or every later request. A request that was
 * not sent says nothing about its URL, so callers leave it unchecked, never broken.
 */
export interface Refusals {
  /**
   * Runs `request`, which fetches `url`, unless a refusal already rules it out. Null when it is
   * refused, now or before; any other error goes to the caller.
   */
  run: <T>(url: string, request: () => Promise<T>) => Promise<T | null>;
  /** The refusal that rules out `url`, if one does. */
  of: (url: string) => RequestRefusedError | undefined;
  /**
   * The refusal that ended the requests to a host `isSite` accepts, or to every host: the reason a
   * crawl of that site stopped early.
   */
  stopped: (
    isSite: (host: string) => boolean
  ) => RequestRefusedError | undefined;
  /**
   * `options` with a gate that also refuses the hosts already refused, so a redirect to one of them
   * is not sent again. Without a gate nothing is ever refused, and `options` stays as it is.
   */
  guard: (options: FetchOptions) => FetchOptions;
}

export const trackRefusals = (): Refusals => {
  const urls = new Map<string, RequestRefusedError>();
  const hosts = new Map<string, RequestRefusedError>();
  let all: RequestRefusedError | undefined;

  const of = (url: string): RequestRefusedError | undefined =>
    all ?? urls.get(url) ?? hosts.get(hostOf(url) ?? "");

  const record = (url: string, error: RequestRefusedError): void => {
    // The URL asked for, refused itself or through a redirect it led to.
    urls.set(url, error);

    if (error.scope === "all") {
      all ??= error;
    } else if (error.scope === "host" && !hosts.has(error.host)) {
      hosts.set(error.host, error);
    }
  };

  return {
    of,
    stopped: (isSite) => all ?? [...hosts].find(([host]) => isSite(host))?.[1],
    guard: (options) => {
      const { gate } = options;

      if (!gate) {
        return options;
      }

      return {
        ...options,
        gate: {
          ...gate,
          beforeRequest: (url) => {
            const known = all ?? hosts.get(url.hostname);

            return known
              ? { scope: known.scope, message: known.message }
              : gate.beforeRequest(url);
          },
        },
      };
    },
    run: async (url, request) => {
      if (of(url)) {
        return null;
      }

      try {
        return await request();
      } catch (error) {
        if (!(error instanceof RequestRefusedError)) {
          throw error;
        }

        record(url, error);

        return null;
      }
    },
  };
};
