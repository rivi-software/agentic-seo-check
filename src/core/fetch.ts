import type { RedirectHop, ResponseInfo } from './types.js';

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; agentic-seo-check/0.1; +https://github.com/rivi-software/agentic-seo-check)';

const KEPT_HEADERS = ['content-type', 'x-robots-tag', 'link', 'content-language', 'cache-control', 'last-modified', 'location', 'content-length', 'vary'];

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** Stop reading the body after this many bytes. */
  maxBodyBytes?: number;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  redirectChain: RedirectHop[];
  timeMs: number;
  contentType: string | null;
  error?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** GET a URL, following redirects manually so the chain is recorded. */
export async function fetchPage(url: string, options: FetchOptions = {}, readBody = true): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRedirects = options.maxRedirects ?? 10;
  const started = performance.now();
  const chain: RedirectHop[] = [];
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en,*;q=0.5',
          ...(options.headers ?? {}),
        },
      });
      const headers = pickHeaders(res.headers);
      if (REDIRECT_STATUSES.has(res.status) && headers['location']) {
        chain.push({ url: current, status: res.status });
        let nextUrl: string;
        try {
          nextUrl = new URL(headers['location'], current).href;
        } catch {
          return result(url, current, res.status, headers, null, chain, started, `Invalid Location header: ${headers['location']}`);
        }
        await res.body?.cancel().catch(() => undefined);
        if (chain.some((h) => h.url === nextUrl) || nextUrl === current) {
          return result(url, nextUrl, res.status, headers, null, chain, started, 'Redirect loop');
        }
        current = nextUrl;
        continue;
      }
      let body: string | null = null;
      if (readBody) body = await readLimited(res, options.maxBodyBytes ?? 5_000_000);
      else await res.body?.cancel().catch(() => undefined);
      return result(url, current, res.status, headers, body, chain, started);
    } catch (err) {
      const message = err instanceof Error ? (err.name === 'AbortError' ? `Timed out after ${timeoutMs} ms` : err.message) : String(err);
      return result(url, current, null, {}, null, chain, started, message);
    } finally {
      clearTimeout(timer);
    }
  }
  return result(url, current, null, {}, null, chain, started, `More than ${maxRedirects} redirects`);
}

/** Status/redirect check without downloading the body. */
export function probeUrl(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  return fetchPage(url, options, false);
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  }
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(Buffer.concat(chunks));
  } catch {
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  }
}

function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

function result(requestedUrl: string, finalUrl: string, status: number | null, headers: Record<string, string>, body: string | null, chain: RedirectHop[], started: number, error?: string): FetchResult {
  const r: FetchResult = {
    requestedUrl,
    finalUrl,
    status,
    headers,
    body,
    redirectChain: chain,
    timeMs: Math.round(performance.now() - started),
    contentType: headers['content-type'] ?? null,
  };
  if (error) r.error = error;
  return r;
}

export function toResponseInfo(r: FetchResult): ResponseInfo {
  const info: ResponseInfo = {
    status: r.status,
    finalUrl: r.finalUrl,
    redirectChain: r.redirectChain,
    timeMs: r.timeMs,
    contentType: r.contentType,
    headers: r.headers,
  };
  if (r.error) info.error = r.error;
  return info;
}

export function isHtmlResponse(r: FetchResult): boolean {
  const ct = r.contentType?.toLowerCase() ?? '';
  if (ct) return ct.includes('text/html') || ct.includes('application/xhtml');
  return typeof r.body === 'string' && /<html|<!doctype/i.test(r.body.slice(0, 2000));
}
