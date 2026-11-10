import { MARK_SVG } from "../../../src/brand.js";
/**
 * The routes of the website at agentic-seo.rivi.software (issue #39), which the Worker
 * serves beside the MCP server's own hostname: the homepage with the audit form, the rules, the
 * form's answer at /audit, and the files a crawler asks for.
 */
import font from "../../assets/bricolage-grotesque-600.woff2";
import { answerAudit, formOpen } from "./audit.js";
import type { SiteEnv } from "./audit.js";
import { LLMS_TXT, SITE_JS, SITE_ROBOTS_TXT, SITEMAP_XML } from "./files.js";
import { homePage, notFoundPage } from "./home.js";
import { SITE_HOST } from "./layout.js";
import { rulesPage } from "./rules-page.js";
import { FONT_PATH } from "./style.js";

/**
 * The website's hostname. Wrangler's dev server gives every request the hostname of the first
 * route, so the site is reached locally with `pnpm run hosted:dev --host` and this name.
 */
export const isSiteHost = (hostname: string): boolean => hostname === SITE_HOST;

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

/**
 * Scripts from this site and Turnstile only, and none inline: a report quotes the audited page,
 * and nothing in it may run. Styles are the page's own <style>.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const file = (
  request: Request,
  body: string | ArrayBuffer,
  contentType: string,
  options: { status?: number; cache?: string } = {}
): Response =>
  new Response(request.method === "HEAD" ? null : body, {
    status: options.status ?? 200,
    headers: {
      "content-type": contentType,
      "cache-control": options.cache ?? "public, max-age=3600",
      ...SECURITY,
    },
  });

/** The address a link put in the field (`/?url=…`). It fills the field only: a GET never audits. */
const prefill = (url: URL): string | undefined =>
  url.searchParams.get("url")?.slice(0, 2048);

/** The answer of the audit form: the homepage with the report, never cached and never indexed. */
const audit = async (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  const { status, state } = await answerAudit(request, env, ctx);

  const body = homePage({
    open: formOpen(env),
    siteKey: env.TURNSTILE_SITE_KEY,
    ...state,
  });

  return new Response(body, {
    status,
    headers: {
      "content-type": HTML,
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      ...SECURITY,
    },
  });
};

export const siteRoute = (
  request: Request,
  env: SiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Response | Promise<Response> => {
  const url = new URL(request.url);
  const read = request.method === "GET" || request.method === "HEAD";

  if (url.pathname === "/audit") {
    if (request.method === "POST") {
      return audit(request, env, ctx);
    }

    // A report has no address of its own: /audit opened as a link goes to the form.
    return read
      ? new Response(null, { status: 303, headers: { location: "/" } })
      : new Response("Method not allowed.\n", {
          status: 405,
          headers: { allow: "GET, HEAD, POST" },
        });
  }

  if (!read) {
    return new Response("Method not allowed.\n", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  switch (url.pathname) {
    case "/": {
      return file(
        request,
        homePage({
          open: formOpen(env),
          siteKey: env.TURNSTILE_SITE_KEY,
          url: prefill(url),
        }),
        HTML
      );
    }

    case "/rules": {
      return file(request, rulesPage(), HTML);
    }

    case "/robots.txt": {
      return file(request, SITE_ROBOTS_TXT, TEXT);
    }

    case "/sitemap.xml": {
      return file(request, SITEMAP_XML, "application/xml; charset=utf-8");
    }

    case "/llms.txt": {
      return file(request, LLMS_TXT, "text/markdown; charset=utf-8");
    }

    case "/site.js": {
      return file(request, SITE_JS, "text/javascript; charset=utf-8");
    }

    case "/favicon.svg": {
      return file(request, MARK_SVG, "image/svg+xml");
    }

    case FONT_PATH: {
      return file(request, font, "font/woff2", {
        cache: "public, max-age=31536000, immutable",
      });
    }

    default: {
      return file(request, notFoundPage(), HTML, { status: 404 });
    }
  }
};
