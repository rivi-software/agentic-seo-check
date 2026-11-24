/**
 * How the website answers with a page or a file: its Content-Security-Policy and security headers,
 * and the cache headers of a page at an address it keeps (fresh.ts). The router (routes.ts) and
 * the waitlist's routes (waitlist-routes.ts) answer through it.
 */
import { POSTHOG_HOST } from "../../../src/telemetry/posthog.js";
import { freshResponse } from "../fresh.js";

export const HTML = "text/html; charset=utf-8";

/**
 * Scripts from this site and Turnstile only, and none inline: a report quotes the audited page,
 * and nothing in it may run. Styles are the page's own <style>. The pages send their analytics
 * (issue #57) to PostHog's managed proxy, the only place besides this site they connect to.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  `connect-src 'self' ${POSTHOG_HOST}`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** A page or a file at an address it keeps from deploy to deploy, which browsers ask for again. */
export const file = (
  request: Request,
  body: string,
  contentType: string,
  status = 200
): Promise<Response> =>
  freshResponse(
    request,
    body,
    { "content-type": contentType, ...SECURITY },
    status
  );

/** The answer to a method a path does not take. */
export const methodNotAllowed = (allow: string): Response =>
  new Response("Method not allowed.\n", { status: 405, headers: { allow } });

/**
 * A page whose address holds a secret (a shared report, a waitlist link): it sends no referrer, so
 * a link on it does not hand the address on, and it is never cached or indexed.
 */
export const secretPage = (
  request: Request,
  body: string,
  status = 200
): Response =>
  new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      "content-type": HTML,
      ...SECURITY,
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
